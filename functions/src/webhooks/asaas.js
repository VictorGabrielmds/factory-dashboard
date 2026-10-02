// ============================================================================
// ASAAS / PIX — RECEPÇÃO DURÁVEL, CONCILIAÇÃO E RECONCILIAÇÃO
//
// Garantias principais:
// 1. O webhook só autentica, persiste o evento de forma idempotente e responde.
// 2. Um gatilho separado consulta a cobrança diretamente na API do Asaas.
// 3. Cobranças do app só confirmam com paymentId + externalReference + PIX +
//    status RECEIVED + valor em centavos, todos exatamente iguais ao pedido.
// 4. Pedido, pagamento e evento são concluídos na MESMA transação Firestore.
// 5. Um paymentId jamais pode confirmar dois pedidos.
// 6. Pedidos InstaDelivery com a referência genérica ORDER_PIX só confirmam
//    quando valor, origem, identidade completa e janela temporal convergem
//    para um único pedido. Qualquer ambiguidade vira conferência humana.
// 7. Uma rotina programada reconcilia cobranças pendentes e audita cobranças
//    recebidas, cobrindo webhook atrasado, perdido ou fila temporariamente
//    indisponível.
// 8. Estornos totais, parciais e em andamento são persistidos e alertados.
// ============================================================================

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

const { ASAAS_WEBHOOK_TOKEN, ASAAS_API_KEY, TOKEN_META } = require("../config");
const { comparaSegura } = require("../lib/seguranca");
const { idDocSeguro, normalizarTelefone, horaAtualSP } = require("../lib/util");
const { atualizarStatusPixNaFicha } = require("../services/pedidos");
const { enviarTemplate } = require("../services/meta");
const { buscarHorarioFuncionamento } = require("../services/horario");
const {
  buscarPagamentoAsaas,
  buscarPagadorDoPagamento,
} = require("../services/asaas");
const {
  parseValor,
  paraCentavos,
  normalizarStatus,
  pedidoEhPix,
  eventoEhRelevante,
  eventoEhEstorno,
  statusDoEvento,
  eventoParaStatusConsultado,
  validarPagamentoRecebido,
  selecionarCandidatoInstaSeguro,
  calcularJanelaInstaSeguraMinutos,
  atualizacaoOperacionalAoConfirmarPix,
  pedidoVisivelNoPainel,
} = require("../services/pixConfiavel");

const db = () => admin.firestore();

const COLECAO_EVENTOS = "eventos_asaas";
const COLECAO_PAGAMENTOS = "pagamentos_asaas";
const MAX_TENTATIVAS_ANTES_REVISAO = 5;
const MAX_PEDIDOS_PARA_CONCILIACAO = 3000;
const JANELA_INSTA_MINIMA_MINUTOS = 6 * 60;
const TIPOS_PENDENCIA_VINCULO_PIX = [
  "pix_sem_vinculo_exato",
  "pix_colisao",
  "pix_nao_encontrado",
];
const MOTIVOS_REPROCESSAVEIS_INSTA = new Set([
  "pix_sem_vinculo_exato",
  "pix_colisao",
]);
const DIAS_RETENCAO_EVENTO = 90;
const INTERVALOS_AUDITORIA_MS = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
];

class ErroConciliacao extends Error {
  constructor(codigo, mensagem, { transitorio = false, detalhes = null } = {}) {
    super(mensagem);
    this.name = "ErroConciliacao";
    this.codigo = codigo;
    this.transitorio = transitorio;
    this.detalhes = detalhes;
  }
}

function timestampDaqui(ms) {
  return admin.firestore.Timestamp.fromMillis(Date.now() + ms);
}

function instanteEmMs(valor, fallback = Date.now()) {
  if (valor && typeof valor.toMillis === "function") {
    const millis = valor.toMillis();
    if (Number.isFinite(millis)) return millis;
  }
  const millis = valor instanceof Date ? valor.getTime() : Date.parse(String(valor || ""));
  return Number.isFinite(millis) ? millis : fallback;
}

function dataHoraSP(millis) {
  const alvo = new Date(millis);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(alvo);
}

function dataCorteSP(horasAtras, referencia = Date.now()) {
  return dataHoraSP(
    instanteEmMs(referencia) - horasAtras * 60 * 60 * 1000
  );
}

function mensagemErro(erro) {
  return String(
    erro?.response?.data?.errors?.[0]?.description ??
    erro?.response?.data?.message ??
    erro?.message ??
    erro
  ).slice(0, 1500);
}

// A configuração de dias à frente é a fonte de verdade também para PIXs do
// InstaDelivery. Se o Firestore estiver momentaneamente indisponível, mantém
// a janela mínima que já era usada, em vez de bloquear uma confirmação válida.
async function buscarJanelaInstaSeguraMinutos() {
  try {
    const horario = await buscarHorarioFuncionamento();
    return calcularJanelaInstaSeguraMinutos(horario.diasAntecedencia);
  } catch (erro) {
    console.error(
      "[asaas] Não foi possível ler diasAntecedencia para conciliar PIX:",
      mensagemErro(erro)
    );
    return JANELA_INSTA_MINIMA_MINUTOS;
  }
}

function referenciaEhGenerica(referencia) {
  const valor = String(referencia || "").trim().toUpperCase();
  return !valor || valor === "ORDER_PIX" || valor === "PIX" || valor === "PEDIDO_PIX";
}

function refEvento(eventoId) {
  return db().collection(COLECAO_EVENTOS).doc(idDocSeguro(eventoId));
}

function refPagamento(paymentId) {
  return db().collection(COLECAO_PAGAMENTOS).doc(idDocSeguro(paymentId));
}

function refPendenciaPix(paymentId, tipo) {
  return db().collection("pendencias").doc(idDocSeguro(`${tipo}_${paymentId}`));
}

async function criarPendenciaDeterministica({ paymentId, tipo, descricao, detalhes = null }) {
  await refPendenciaPix(paymentId, tipo).set({
    chatId: "sistema",
    tipo,
    descricao,
    detalhes,
    pagamentoId: paymentId,
    resolvida: false,
    criadaEm: horaAtualSP(),
    criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function incrementarTentativa(eventoRef) {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(eventoRef);
    const atual = snap.data() || {};
    if (atual.estado === "concluido" || atual.estado === "requer_revisao") {
      return { ignorar: true, tentativas: atual.tentativas ?? 0 };
    }
    const tentativas = (atual.tentativas ?? 0) + 1;
    tx.set(eventoRef, {
      estado: "processando",
      tentativas,
      processamentoIniciadoEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ignorar: false, tentativas };
  });
}

async function marcarErroTransitorio(eventoRef, erro) {
  await eventoRef.set({
    estado: "erro_transitorio",
    ultimoErro: mensagemErro(erro),
    ultimaFalhaEm: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function marcarParaRevisao(eventoRef, {
  paymentId,
  tipo,
  descricao,
  detalhes = null,
}) {
  const pendenciaRef = refPendenciaPix(paymentId, tipo);
  await db().runTransaction(async (tx) => {
    const eventoSnap = await tx.get(eventoRef);
    if (eventoSnap.data()?.estado === "concluido") return;

    tx.set(eventoRef, {
      estado: "requer_revisao",
      motivoRevisao: tipo,
      descricaoRevisao: descricao,
      revisaoCriadaEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(pendenciaRef, {
      chatId: "sistema",
      tipo,
      descricao,
      detalhes,
      pagamentoId: paymentId,
      resolvida: false,
      criadaEm: horaAtualSP(),
      criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

async function resolverAlertaDeProcessamento(eventoRef) {
  const pendenciaRef = db().collection("pendencias").doc(`pix_processamento_${eventoRef.id}`);
  const snap = await pendenciaRef.get();
  if (!snap.exists || snap.data()?.resolvida) return;
  await pendenciaRef.set({
    resolvida: true,
    resolvidaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function persistirEventoAsaas({ eventoId, tipo, paymentId, payload, origem = "webhook" }) {
  const eventoRef = refEvento(eventoId);
  try {
    await eventoRef.create({
      eventoId,
      tipo,
      paymentId,
      payload,
      origem,
      estado: "pendente",
      tentativas: 0,
      recebidoEm: admin.firestore.FieldValue.serverTimestamp(),
      expiraEm: timestampDaqui(DIAS_RETENCAO_EVENTO * 24 * 60 * 60 * 1000),
    });
    return { criado: true, eventoRef };
  } catch (erro) {
    if (erro.code === 6 /* ALREADY_EXISTS */) {
      return { criado: false, eventoRef };
    }
    throw erro;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) RECEPTOR: autentica, persiste de modo idempotente e responde HTTP 200.
// ─────────────────────────────────────────────────────────────────────────────
const webhookAsaas = onRequest(
  {
    secrets: [ASAAS_WEBHOOK_TOKEN],
    memory: "256MiB",
    cpu: 1,
    minInstances: 1,
  },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    if (!comparaSegura(req.headers["asaas-access-token"], ASAAS_WEBHOOK_TOKEN.value())) {
      return res.status(401).send("Não autorizado");
    }

    const payload = req.body || {};
    const tipo = normalizarStatus(payload.event);
    if (!eventoEhRelevante(tipo)) {
      return res.status(200).send("Evento ignorado");
    }

    const paymentId = String(payload.payment?.id || "").trim();
    const eventoId = String(payload.id || "").trim();

    // O Asaas documenta ambos como obrigatórios. Se vierem ausentes, não há
    // como consultar/conciliar. Persistimos a anomalia e respondemos 200 para
    // um payload malformado não paralisar a fila inteira.
    if (!paymentId || !eventoId) {
      const idInvalido = idDocSeguro(
        `invalido_${tipo || "sem_tipo"}_${paymentId || "sem_pagamento"}_${payload.dateCreated || Date.now()}`
      );
      try {
        await db().collection(COLECAO_EVENTOS).doc(idInvalido).set({
          eventoId: eventoId || null,
          tipo: tipo || null,
          paymentId: paymentId || null,
          payload,
          origem: "webhook",
          estado: "requer_revisao",
          motivoRevisao: "pix_evento_malformado",
          recebidoEm: admin.firestore.FieldValue.serverTimestamp(),
          expiraEm: timestampDaqui(DIAS_RETENCAO_EVENTO * 24 * 60 * 60 * 1000),
        }, { merge: true });
        await criarPendenciaDeterministica({
          paymentId: paymentId || idInvalido,
          tipo: "pix_evento_malformado",
          descricao: `O Asaas enviou ${tipo || "um evento"} sem identificadores suficientes para conciliação. Conferir os logs do webhook.`,
        });
      } catch (erro) {
        console.error("[webhookAsaas] Falha ao registrar evento malformado:", erro);
        return res.status(500).send("Falha ao persistir evento");
      }
      return res.status(200).send("Evento inválido registrado");
    }

    try {
      const { criado } = await persistirEventoAsaas({
        eventoId,
        tipo,
        paymentId,
        payload,
        origem: "webhook",
      });
      return res.status(200).send(criado ? "Evento persistido" : "Evento duplicado");
    } catch (erro) {
      // Só confirmamos recebimento depois que o evento está durável. Um 500
      // aqui faz o Asaas tentar novamente; create() torna a repetição segura.
      console.error(`[webhookAsaas] Falha ao persistir ${eventoId}:`, erro);
      return res.status(500).send("Falha ao persistir evento");
    }
  }
);

async function localizarPedidoPorPagamento(paymentId) {
  const pagamentoRef = refPagamento(paymentId);
  const marcaSnap = await pagamentoRef.get();
  const pedidoMarcadoId = marcaSnap.data()?.pedidoId;
  if (pedidoMarcadoId) {
    const pedidoRef = db().collection("pedidos").doc(String(pedidoMarcadoId));
    const pedidoSnap = await pedidoRef.get();
    if (pedidoSnap.exists) {
      return {
        pedidoRef,
        pedidoSnap,
        pagamentoRef,
        origemVinculo: "registro_pagamento",
      };
    }
  }

  const porIdSnap = await db().collection("pedidos")
    .where("pix_pagamento_id", "==", paymentId)
    .limit(2)
    .get();

  if (porIdSnap.size > 1) {
    throw new ErroConciliacao(
      "payment_id_duplicado",
      `O paymentId ${paymentId} está salvo em mais de um pedido.`,
      {
        detalhes: { pedidos: porIdSnap.docs.map((doc) => doc.id) },
      }
    );
  }

  if (porIdSnap.size === 1) {
    const pedidoSnap = porIdSnap.docs[0];
    return {
      pedidoRef: pedidoSnap.ref,
      pedidoSnap,
      pagamentoRef,
      origemVinculo: "payment_id_salvo",
    };
  }

  return { pedidoRef: null, pedidoSnap: null, pagamentoRef, origemVinculo: null };
}

async function localizarPorReferenciaExata(pagamento, paymentId) {
  const referencia = String(pagamento?.externalReference || "").trim();
  if (referenciaEhGenerica(referencia)) return null;

  const pedidoRef = db().collection("pedidos").doc(referencia);
  const pedidoSnap = await pedidoRef.get();
  if (!pedidoSnap.exists) return null;

  const pedido = pedidoSnap.data();
  if (!pedidoEhPix(pedido)) return null;

  // No checkout próprio, o paymentId é gravado antes de o QR Code chegar ao
  // cliente. Se ainda não estiver no pedido, não adivinhamos: a reconciliação
  // programada tentará de novo assim que a gravação estiver visível.
  if (pedido.origem === "app" && pedido.pix_pagamento_id !== paymentId) {
    throw new ErroConciliacao(
      "pedido_app_sem_payment_id",
      `Pedido ${referencia} do app ainda não possui o paymentId esperado.`,
      { transitorio: !pedido.pix_pagamento_id }
    );
  }

  return {
    pedidoRef,
    pedidoSnap,
    pagamentoRef: refPagamento(paymentId),
    origemVinculo: "external_reference",
  };
}

async function confirmarPedidoAtomico({
  eventoRef,
  eventoId,
  paymentId,
  pagamento,
  pedidoRef,
  pagamentoRef,
  origemVinculo,
  evidenciaVinculo = null,
}) {
  return db().runTransaction(async (tx) => {
    const pendenciaRefs = TIPOS_PENDENCIA_VINCULO_PIX
      .map((tipo) => refPendenciaPix(paymentId, tipo));
    const exigeUnicidadeInsta =
      origemVinculo === "instadelivery_nome_valor_tempo";
    const leituras = await Promise.all([
      tx.get(eventoRef),
      tx.get(pedidoRef),
      tx.get(pagamentoRef),
      ...pendenciaRefs.map((ref) => tx.get(ref)),
      ...(exigeUnicidadeInsta
        ? [tx.get(consultaPedidosRecentesParaPix(
          evidenciaVinculo?.eventoRecebidoEm,
          evidenciaVinculo?.janelaMinutos
        ))]
        : []),
    ]);
    const [eventoSnap, pedidoSnap, marcaSnap] = leituras;
    const pendenciaSnaps = leituras.slice(3, 3 + pendenciaRefs.length);
    const candidatosAtuaisSnap = exigeUnicidadeInsta
      ? leituras[3 + pendenciaRefs.length]
      : null;

    const eventoAtual = eventoSnap.data() || {};
    if (eventoAtual.estado === "concluido") {
      return { novo: false, pedido: pedidoSnap.data() || null };
    }
    if (!pedidoSnap.exists) {
      throw new ErroConciliacao("pedido_ausente", `Pedido ${pedidoRef.id} não existe.`, {
        transitorio: true,
      });
    }

    const pedido = pedidoSnap.data();
    const marca = marcaSnap.data() || {};
    if (marca.pedidoId && String(marca.pedidoId) !== pedidoRef.id) {
      throw new ErroConciliacao(
        "pagamento_ja_usado",
        `Pagamento ${paymentId} já está vinculado ao pedido ${marca.pedidoId}.`,
        { detalhes: { pedidoAtual: pedidoRef.id, pedidoJaVinculado: marca.pedidoId } }
      );
    }

    if (exigeUnicidadeInsta) {
      const consultaTruncada =
        candidatosAtuaisSnap.size >= MAX_PEDIDOS_PARA_CONCILIACAO;
      const candidatosAtuais = candidatosPixDoSnapshot(
        candidatosAtuaisSnap,
        pagamento
      );
      const candidatoAindaSeguro = selecionarCandidatoInstaSeguro({
        pagamento,
        pagador: evidenciaVinculo?.pagador,
        candidatos: candidatosAtuais,
        eventoRecebidoEm: evidenciaVinculo?.eventoRecebidoEm,
        janelaMinutos: evidenciaVinculo?.janelaMinutos,
      });
      if (
        consultaTruncada ||
        !candidatoAindaSeguro ||
        candidatoAindaSeguro.id !== pedidoRef.id
      ) {
        throw new ErroConciliacao(
          "vinculo_insta_nao_mais_seguro",
          `Os sinais do pagamento ${paymentId} deixaram de identificar com segurança o pedido ${pedidoRef.id}.`
        );
      }
    }

    const ehApp = pedido.origem === "app";
    const validacao = validarPagamentoRecebido({
      pagamento,
      pedido,
      orderId: pedidoRef.id,
      paymentId,
      exigirIdSalvo: ehApp || origemVinculo === "payment_id_salvo",
      exigirReferencia: ehApp || origemVinculo === "external_reference",
    });
    if (!validacao.ok) {
      throw new ErroConciliacao(
        "vinculo_pix_invalido",
        `Cobrança ${paymentId} não passou na validação estrita do pedido ${pedidoRef.id}.`,
        { detalhes: validacao }
      );
    }

    const jaConfirmado =
      pedido.pix_confirmado === true &&
      pedido.pix_status === "RECEIVED" &&
      String(pedido.pix_pagamento_id || "") === paymentId;

    const promocaoOperacional = atualizacaoOperacionalAoConfirmarPix(pedido);
    const atualizacaoPedido = {
      pix_pagamento_id: paymentId,
      pix_confirmado: true,
      pix_status: "RECEIVED",
      pix_valor_recebido: parseValor(pagamento.value),
      pix_asaas_evento_id: eventoId,
      pix_asaas_ultima_verificacao_em: admin.firestore.FieldValue.serverTimestamp(),
      pix_origem_confirmacao: origemVinculo,
      pix_estornado: admin.firestore.FieldValue.delete(),
      pix_estorno_parcial: admin.firestore.FieldValue.delete(),
      pix_estorno_em_andamento: admin.firestore.FieldValue.delete(),
      pix_estornado_em: admin.firestore.FieldValue.delete(),
      pix_proxima_verificacao_em: timestampDaqui(INTERVALOS_AUDITORIA_MS[0]),
      pix_auditoria_etapa: 0,
      ...promocaoOperacional,
    };
    if (!jaConfirmado) {
      atualizacaoPedido.pix_confirmado_em = admin.firestore.FieldValue.serverTimestamp();
    }

    tx.set(pedidoRef, atualizacaoPedido, { merge: true });
    const pedidoDepoisDaConfirmacao = { ...pedido, ...atualizacaoPedido };
    if (!pedidoVisivelNoPainel(pedidoDepoisDaConfirmacao)) {
      const pendenciaVisibilidadeRef = db().collection("pendencias")
        .doc(idDocSeguro(`pix_pago_invisivel_${paymentId}`));
      tx.set(pendenciaVisibilidadeRef, {
        chatId: "sistema",
        tipo: "pix_pago_pedido_invisivel",
        pagamentoId: paymentId,
        pedidoId: pedidoRef.id,
        descricao:
          `O PIX do pedido #${pedidoRef.id} foi confirmado, mas o status operacional ` +
          `${String(pedidoDepoisDaConfirmacao.status ?? "ausente")} não aparece no painel.`,
        resolvida: false,
        criadaEm: horaAtualSP(),
        criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    tx.set(pagamentoRef, {
      casado: true,
      pedidoId: pedidoRef.id,
      paymentId,
      status: "RECEIVED",
      billingType: pagamento.billingType,
      externalReference: pagamento.externalReference || null,
      valor: parseValor(pagamento.value),
      ultimoEventoId: eventoId,
      verificadoDiretamenteNaApi: true,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(eventoRef, {
      estado: "concluido",
      resultado: jaConfirmado ? "ja_confirmado" : "confirmado",
      pedidoId: pedidoRef.id,
      concluidoEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    pendenciaSnaps.forEach((pendenciaSnap, indice) => {
      if (!pendenciaSnap.exists || pendenciaSnap.data()?.resolvida === true) return;
      tx.set(pendenciaRefs[indice], {
        resolvida: true,
        resolvidaAutomaticamente: true,
        pedidoId: pedidoRef.id,
        resolvidaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return { novo: !jaConfirmado, pedido: pedidoDepoisDaConfirmacao };
  });
}

async function aplicarEstornoAtomico({
  eventoRef,
  eventoId,
  tipoEvento,
  paymentId,
  pagamento,
  pedidoRef,
  pagamentoRef,
}) {
  const status = statusDoEvento(tipoEvento, pagamento);
  const statusApi = normalizarStatus(pagamento.status);
  const statusCompativeis = {
    REFUNDED: new Set(["REFUNDED"]),
    PARTIALLY_REFUNDED: new Set(["PARTIALLY_REFUNDED", "REFUNDED"]),
    REFUND_IN_PROGRESS: new Set(["REFUND_IN_PROGRESS", "REFUND_REQUESTED"]),
  };

  if (!statusCompativeis[status]?.has(statusApi)) {
    throw new ErroConciliacao(
      "estorno_ainda_nao_visivel",
      `Evento ${tipoEvento} recebido, mas a API ainda informa status ${statusApi || "vazio"} para ${paymentId}.`,
      { transitorio: true, detalhes: { statusEvento: status, statusApi } }
    );
  }

  return db().runTransaction(async (tx) => {
    const [eventoSnap, pedidoSnap, marcaSnap] = await Promise.all([
      tx.get(eventoRef),
      tx.get(pedidoRef),
      tx.get(pagamentoRef),
    ]);
    if (eventoSnap.data()?.estado === "concluido") {
      return { alterou: false, pedido: pedidoSnap.data() || null, status };
    }
    if (!pedidoSnap.exists) {
      throw new ErroConciliacao("pedido_estorno_ausente", "Pedido do estorno não foi encontrado.");
    }

    const pedido = pedidoSnap.data();
    const marca = marcaSnap.data() || {};
    if (marca.pedidoId && String(marca.pedidoId) !== pedidoRef.id) {
      throw new ErroConciliacao(
        "estorno_pagamento_vinculo_divergente",
        `O pagamento ${paymentId} está vinculado a outro pedido (${marca.pedidoId}).`
      );
    }
    if (String(pedido.pix_pagamento_id || "") !== paymentId) {
      throw new ErroConciliacao(
        "estorno_payment_id_divergente",
        `O pedido ${pedidoRef.id} não está vinculado ao pagamento ${paymentId}.`
      );
    }
    if (normalizarStatus(pagamento.billingType) !== "PIX") {
      throw new ErroConciliacao("estorno_nao_pix", `Pagamento ${paymentId} não é PIX.`);
    }
    if (paraCentavos(pagamento.value) !== paraCentavos(pedido.valor_venda)) {
      throw new ErroConciliacao(
        "estorno_valor_divergente",
        `Valor do estorno ${paymentId} não confere com o pedido ${pedidoRef.id}.`
      );
    }

    const estornoTotal = status === "REFUNDED";
    const estornoParcial = status === "PARTIALLY_REFUNDED";
    const estornoEmAndamento = status === "REFUND_IN_PROGRESS";
    const jaEstavaAssim = pedido.pix_status === status;
    const pendenciaRef = refPendenciaPix(paymentId, `pix_${status.toLowerCase()}`);

    tx.set(pedidoRef, {
      pix_confirmado: !estornoTotal,
      pix_status: status,
      pix_estornado: estornoTotal,
      pix_estorno_parcial: estornoParcial,
      pix_estorno_em_andamento: estornoEmAndamento,
      pix_valor_estornado: parseValor(pagamento.refundedValue || 0),
      pix_estornado_em: admin.firestore.FieldValue.serverTimestamp(),
      pix_asaas_evento_id: eventoId,
      pix_asaas_ultima_verificacao_em: admin.firestore.FieldValue.serverTimestamp(),
      pix_proxima_verificacao_em: timestampDaqui(
        estornoEmAndamento ? 60 * 60 * 1000 : INTERVALOS_AUDITORIA_MS.at(-1)
      ),
    }, { merge: true });
    tx.set(pagamentoRef, {
      casado: true,
      pedidoId: pedidoRef.id,
      paymentId,
      status,
      valorEstornado: parseValor(pagamento.refundedValue || 0),
      ultimoEventoId: eventoId,
      verificadoDiretamenteNaApi: true,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(eventoRef, {
      estado: "concluido",
      resultado: jaEstavaAssim ? "estorno_ja_registrado" : "estorno_registrado",
      pedidoId: pedidoRef.id,
      concluidoEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(pendenciaRef, {
      chatId: "sistema",
      tipo: `pix_${status.toLowerCase()}`,
      pagamentoId: paymentId,
      pedidoId: pedidoRef.id,
      descricao:
        `PIX do pedido #${pedidoRef.id} mudou para ${status}. ` +
        `Pagamento ${paymentId}; valor estornado informado: R$ ${parseValor(pagamento.refundedValue || 0).toFixed(2)}.`,
      resolvida: false,
      criadaEm: horaAtualSP(),
      criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { alterou: !jaEstavaAssim, pedido, status };
  });
}

async function notificarConfirmacaoSeNova(resultado, pedidoRef, paymentId) {
  if (!resultado.novo || !resultado.pedido) return;
  const pedido = resultado.pedido;

  await atualizarStatusPixNaFicha(
    normalizarTelefone(pedido.telefone_destinatario) ?? "",
    pedido.order_id || pedidoRef.id,
    true,
    "RECEIVED"
  );

  try {
    const telefone = normalizarTelefone(pedido.telefone_destinatario);
    if (!telefone) return;
    const nome = pedido.nome_destinatario || "Cliente";
    const orderId = String(pedido.order_id || pedidoRef.id);
    await enviarTemplate(
      TOKEN_META.value(),
      telefone,
      "confirmacao_pix",
      [{ type: "text", text: orderId }],
      nome,
      `Recebemos a confirmação do seu pagamento via PIX para o pedido #${orderId}✅`
    );
  } catch (erro) {
    console.error(
      `[processarEventoAsaas] PIX ${paymentId} confirmado, mas a mensagem ao cliente falhou:`,
      mensagemErro(erro)
    );
  }
}

function consultaPedidosRecentesParaPix(eventoRecebidoEm, janelaMinutos = JANELA_INSTA_MINIMA_MINUTOS) {
  const eventoEmMs = instanteEmMs(eventoRecebidoEm);
  const minutos = Number.isFinite(janelaMinutos) && janelaMinutos >= 0
    ? janelaMinutos
    : JANELA_INSTA_MINIMA_MINUTOS;
  const corte = dataCorteSP(minutos / 60, eventoEmMs);
  const limiteSuperior = dataHoraSP(eventoEmMs);
  return db().collection("pedidos")
    .where("data_venda", ">=", corte)
    .where("data_venda", "<=", limiteSuperior)
    .orderBy("data_venda", "desc")
    .limit(MAX_PEDIDOS_PARA_CONCILIACAO);
}

function candidatosPixDoSnapshot(snapshot, pagamento) {
  return snapshot.docs
    .filter((doc) => {
      const pedido = doc.data();
      return (
        pedido.pix_confirmado !== true &&
        pedidoEhPix(pedido) &&
        paraCentavos(pedido.valor_venda) === paraCentavos(pagamento.value)
      );
    })
    .map((doc) => ({ id: doc.id, pedido: doc.data(), ref: doc.ref }));
}

async function listarCandidatosLegados(pagamento, eventoRecebidoEm, janelaMinutos) {
  const snapshot = await consultaPedidosRecentesParaPix(eventoRecebidoEm, janelaMinutos).get();
  const candidatos = candidatosPixDoSnapshot(snapshot, pagamento);

  return {
    candidatos,
    truncado: snapshot.size >= MAX_PEDIDOS_PARA_CONCILIACAO,
  };
}

function candidatosParaPendencia(candidatos) {
  return candidatos.map(({ id, pedido }) => ({
    id,
    nome: pedido.nome_destinatario || null,
    valor: parseValor(pedido.valor_venda),
    dataVenda: pedido.data_venda || null,
  }));
}

async function processarRecebimento({
  eventoRef,
  eventoId,
  paymentId,
  pagamento,
  tentativas,
  eventoRecebidoEm,
  janelaInstaSeguraMinutos = null,
  somenteVinculoSeguro = false,
}) {
  const statusApi = normalizarStatus(pagamento.status);
  if (statusApi !== "RECEIVED") {
    const eventoStatusAtual = eventoParaStatusConsultado(statusApi);
    if (eventoStatusAtual && eventoEhEstorno(eventoStatusAtual)) {
      return processarEstorno({
        eventoRef,
        eventoId,
        tipoEvento: eventoStatusAtual,
        paymentId,
        pagamento,
      });
    }
    throw new ErroConciliacao(
      "pagamento_ainda_nao_recebido",
      `A API do Asaas informa status ${statusApi || "vazio"} para ${paymentId}.`,
      { transitorio: tentativas <= MAX_TENTATIVAS_ANTES_REVISAO }
    );
  }

  let vinculo = await localizarPedidoPorPagamento(paymentId);
  if (!vinculo.pedidoRef) {
    vinculo = await localizarPorReferenciaExata(pagamento, paymentId) || vinculo;
  }

  let consultaCandidatos = null;
  let pagador = null;
  const referenciaGenerica = String(pagamento.externalReference || "").trim().toUpperCase();
  const janelaMinutos = referenciaGenerica === "ORDER_PIX"
    ? (janelaInstaSeguraMinutos ?? await buscarJanelaInstaSeguraMinutos())
    : JANELA_INSTA_MINIMA_MINUTOS;
  if (!vinculo.pedidoRef && referenciaGenerica === "ORDER_PIX") {
    [consultaCandidatos, pagador] = await Promise.all([
      listarCandidatosLegados(pagamento, eventoRecebidoEm, janelaMinutos),
      buscarPagadorDoPagamento(paymentId, ASAAS_API_KEY.value()),
    ]);
    const candidatoSeguro = consultaCandidatos.truncado
      ? null
      : selecionarCandidatoInstaSeguro({
        pagamento,
        pagador,
        candidatos: consultaCandidatos.candidatos,
        eventoRecebidoEm,
        janelaMinutos,
      });

    if (candidatoSeguro) {
      vinculo = {
        pedidoRef: candidatoSeguro.ref,
        pedidoSnap: null,
        pagamentoRef: refPagamento(paymentId),
        origemVinculo: "instadelivery_nome_valor_tempo",
        evidenciaVinculo: {
          pagador,
          eventoRecebidoEm,
          janelaMinutos,
        },
      };
    }
  }

  if (!vinculo.pedidoRef) {
    if (somenteVinculoSeguro) {
      return { confirmado: false, motivo: "sem_candidato_insta_seguro" };
    }

    if (tentativas <= MAX_TENTATIVAS_ANTES_REVISAO) {
      throw new ErroConciliacao(
        "pedido_ainda_nao_encontrado",
        `O pagamento ${paymentId} foi recebido antes de existir um vínculo inequívoco com o pedido.`,
        { transitorio: true }
      );
    }

    if (!consultaCandidatos) {
      [consultaCandidatos, pagador] = await Promise.all([
        listarCandidatosLegados(pagamento, eventoRecebidoEm, janelaMinutos),
        buscarPagadorDoPagamento(paymentId, ASAAS_API_KEY.value()),
      ]);
    }
    const candidatos = candidatosParaPendencia(consultaCandidatos.candidatos);
    const ids = candidatos.map((candidato) => `#${candidato.id}`).join(", ");
    await marcarParaRevisao(eventoRef, {
      paymentId,
      tipo: candidatos.length > 1 ? "pix_colisao" : "pix_sem_vinculo_exato",
      descricao:
        `PIX R$ ${parseValor(pagamento.value).toFixed(2)} (${paymentId}) não possui vínculo exato. ` +
        `${candidatos.length ? `Candidatos apenas heurísticos: ${ids}.` : "Nenhum pedido candidato foi encontrado."} ` +
        "Nenhum pedido foi confirmado automaticamente.",
      detalhes: {
        candidatos,
        pagador,
        externalReference: pagamento.externalReference || null,
        consultaTruncada: consultaCandidatos.truncado,
      },
    });
    return { confirmado: false, motivo: "revisao_manual" };
  }

  const resultado = await confirmarPedidoAtomico({
    eventoRef,
    eventoId,
    paymentId,
    pagamento,
    ...vinculo,
  });
  await notificarConfirmacaoSeNova(resultado, vinculo.pedidoRef, paymentId);
  return { confirmado: true, novo: resultado.novo, pedidoId: vinculo.pedidoRef.id };
}

async function processarEstorno({
  eventoRef,
  eventoId,
  tipoEvento,
  paymentId,
  pagamento,
}) {
  const vinculo = await localizarPedidoPorPagamento(paymentId);
  if (!vinculo.pedidoRef) {
    throw new ErroConciliacao(
      "estorno_sem_pedido",
      `Estorno do pagamento ${paymentId} não possui pedido vinculado.`
    );
  }

  const resultado = await aplicarEstornoAtomico({
    eventoRef,
    eventoId,
    tipoEvento,
    paymentId,
    pagamento,
    ...vinculo,
  });

  if (resultado.alterou && resultado.pedido) {
    await atualizarStatusPixNaFicha(
      normalizarTelefone(resultado.pedido.telefone_destinatario) ?? "",
      resultado.pedido.order_id || vinculo.pedidoRef.id,
      resultado.status !== "REFUNDED",
      resultado.status
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) PROCESSADOR: consulta a API e aplica a decisão de forma transacional.
// ─────────────────────────────────────────────────────────────────────────────
const processarEventoAsaas = onDocumentCreated(
  {
    document: `${COLECAO_EVENTOS}/{eventoId}`,
    secrets: [ASAAS_API_KEY, TOKEN_META],
    memory: "512MiB",
    cpu: 1,
    retry: true,
  },
  async (event) => {
    const eventoRef = event.data?.ref;
    if (!eventoRef) return;

    const tentativa = await incrementarTentativa(eventoRef);
    if (tentativa.ignorar) return;

    const snapAtual = await eventoRef.get();
    const dados = snapAtual.data() || {};
    const eventoId = String(dados.eventoId || event.params.eventoId);
    const tipoEvento = normalizarStatus(dados.tipo);
    const paymentId = String(dados.paymentId || "").trim();

    if (!eventoEhRelevante(tipoEvento) || !paymentId) {
      await marcarParaRevisao(eventoRef, {
        paymentId: paymentId || event.params.eventoId,
        tipo: "pix_evento_invalido",
        descricao: `Evento Asaas ${eventoId} não possui tipo ou paymentId válido.`,
      });
      return;
    }

    try {
      // Fonte da verdade: nunca muda pedido financeiro confiando somente no
      // payload recebido. A cobrança é relida pelo ID na API oficial.
      const pagamento = await buscarPagamentoAsaas(paymentId, ASAAS_API_KEY.value());
      if (String(pagamento?.id || "") !== paymentId) {
        throw new ErroConciliacao(
          "asaas_retornou_id_divergente",
          `A consulta de ${paymentId} retornou o identificador ${pagamento?.id || "vazio"}.`
        );
      }

      if (eventoEhEstorno(tipoEvento)) {
        await processarEstorno({
          eventoRef,
          eventoId,
          tipoEvento,
          paymentId,
          pagamento,
        });
      } else {
        await processarRecebimento({
          eventoRef,
          eventoId,
          paymentId,
          pagamento,
          tentativas: tentativa.tentativas,
          eventoRecebidoEm: dados.recebidoEm,
        });
      }
      await resolverAlertaDeProcessamento(eventoRef);
    } catch (erro) {
      if (erro instanceof ErroConciliacao && !erro.transitorio) {
        await marcarParaRevisao(eventoRef, {
          paymentId,
          tipo: erro.codigo || "pix_revisao_necessaria",
          descricao: erro.message,
          detalhes: erro.detalhes,
        });
        return;
      }

      await marcarErroTransitorio(eventoRef, erro);
      console.error(
        `[processarEventoAsaas] Falha transitória no evento ${eventoId}, pagamento ${paymentId}:`,
        mensagemErro(erro)
      );
      throw erro;
    }
  }
);

async function enfileirarReconciliacao(pagamento, tipoEvento) {
  const agora = new Date();
  const baldeHorario =
    `${agora.getUTCFullYear()}${String(agora.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(agora.getUTCDate()).padStart(2, "0")}${String(agora.getUTCHours()).padStart(2, "0")}`;
  const eventoId = `reconciliacao_${pagamento.id}_${tipoEvento}_${baldeHorario}`;
  await persistirEventoAsaas({
    eventoId,
    tipo: tipoEvento,
    paymentId: pagamento.id,
    payload: {
      id: eventoId,
      event: tipoEvento,
      dateCreated: new Date().toISOString(),
      payment: { id: pagamento.id },
    },
    origem: "reconciliacao",
  });
}

function proximoIntervaloAuditoria(etapaAtual) {
  const proximaEtapa = Math.min(
    Math.max(Number(etapaAtual ?? 0) + 1, 0),
    INTERVALOS_AUDITORIA_MS.length - 1
  );
  return {
    etapa: proximaEtapa,
    intervaloMs: INTERVALOS_AUDITORIA_MS[proximaEtapa],
  };
}

async function reconciliarPedido(pedidoDoc) {
  const pedido = pedidoDoc.data();
  const paymentId = String(pedido.pix_pagamento_id || "").trim();
  if (!paymentId) {
    await pedidoDoc.ref.set({
      pix_reconciliacao_erro: "Pedido marcado para reconciliação sem paymentId.",
      pix_proxima_verificacao_em: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    await criarPendenciaDeterministica({
      paymentId: pedidoDoc.id,
      tipo: "pix_pendente_sem_payment_id",
      descricao: `Pedido #${pedidoDoc.id} precisa ser conciliado, mas não possui paymentId do Asaas.`,
    });
    return;
  }

  try {
    const pagamento = await buscarPagamentoAsaas(paymentId, ASAAS_API_KEY.value());
    const tipoEvento = eventoParaStatusConsultado(pagamento.status);
    const statusAtual = normalizarStatus(pagamento.status);
    const statusPedido = normalizarStatus(pedido.pix_status);
    const estadoAindaNaoAplicado =
      (statusAtual === "RECEIVED" && pedido.pix_confirmado !== true) ||
      (statusAtual === "REFUNDED" && pedido.pix_confirmado !== false) ||
      (
        ["PARTIALLY_REFUNDED", "REFUND_IN_PROGRESS", "REFUND_REQUESTED"].includes(statusAtual) &&
        statusPedido !== statusAtual
      );

    if (tipoEvento && (statusAtual !== statusPedido || estadoAindaNaoAplicado)) {
      await enfileirarReconciliacao(pagamento, tipoEvento);
      await pedidoDoc.ref.set({
        pix_asaas_ultima_verificacao_em: admin.firestore.FieldValue.serverTimestamp(),
        pix_proxima_verificacao_em: timestampDaqui(15 * 60 * 1000),
        pix_reconciliacao_erro: admin.firestore.FieldValue.delete(),
      }, { merge: true });
      return;
    }

    if (pedido.pix_confirmado === true && statusAtual !== "RECEIVED") {
      await criarPendenciaDeterministica({
        paymentId,
        tipo: "pix_status_inesperado",
        descricao:
          `A auditoria do pedido #${pedidoDoc.id} encontrou status ${statusAtual || "vazio"} ` +
          `no Asaas para um PIX que estava marcado como recebido. Nenhuma alteração automática foi aplicada.`,
      });
      await pedidoDoc.ref.set({
        pix_asaas_ultima_verificacao_em: admin.firestore.FieldValue.serverTimestamp(),
        pix_proxima_verificacao_em: timestampDaqui(60 * 60 * 1000),
      }, { merge: true });
      return;
    }

    if (statusAtual === "RECEIVED" && pedido.pix_confirmado === true) {
      // A promoção 1 → 2 precisa reler o pedido dentro da transação. Sem isso,
      // um cancelamento concorrente poderia ser sobrescrito por este snapshot
      // antigo do agendador e o pedido seria reaberto indevidamente.
      await db().runTransaction(async (tx) => {
        const atualSnap = await tx.get(pedidoDoc.ref);
        if (!atualSnap.exists) return;
        const atual = atualSnap.data() || {};
        if (
          atual.pix_confirmado !== true ||
          String(atual.pix_pagamento_id || "") !== paymentId
        ) return;

        const promocaoOperacional = atualizacaoOperacionalAoConfirmarPix(atual);
        const pedidoDepoisDaAuditoria = { ...atual, ...promocaoOperacional };
        const proxima = proximoIntervaloAuditoria(atual.pix_auditoria_etapa);
        tx.set(pedidoDoc.ref, {
          ...promocaoOperacional,
          pix_auditoria_etapa: proxima.etapa,
          pix_proxima_verificacao_em: timestampDaqui(proxima.intervaloMs),
          pix_asaas_ultima_verificacao_em: admin.firestore.FieldValue.serverTimestamp(),
          pix_reconciliacao_erro: admin.firestore.FieldValue.delete(),
        }, { merge: true });

        if (!pedidoVisivelNoPainel(pedidoDepoisDaAuditoria)) {
          tx.set(
            db().collection("pendencias")
              .doc(idDocSeguro(`pix_pago_invisivel_${paymentId}`)),
            {
              chatId: "sistema",
              tipo: "pix_pago_pedido_invisivel",
              pagamentoId: paymentId,
              pedidoId: pedidoDoc.id,
              descricao:
                `O PIX do pedido #${pedidoDoc.id} está confirmado, mas seu status operacional ` +
                `${String(pedidoDepoisDaAuditoria.status ?? "ausente")} não aparece no painel.`,
              resolvida: false,
              criadaEm: horaAtualSP(),
              criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      });
      return;
    }

    // Ainda não pago: consulta frequente nas primeiras 24h, diária depois.
    const criadoEm = pedido.criadoEmTimestamp?.toMillis?.() || Date.now();
    const idadeMs = Math.max(Date.now() - criadoEm, 0);
    const intervalo = idadeMs < 24 * 60 * 60 * 1000
      ? 5 * 60 * 1000
      : 24 * 60 * 60 * 1000;
    await pedidoDoc.ref.set({
      pix_status: statusAtual || pedido.pix_status || "PENDING",
      pix_proxima_verificacao_em: timestampDaqui(intervalo),
      pix_asaas_ultima_verificacao_em: admin.firestore.FieldValue.serverTimestamp(),
      pix_reconciliacao_erro: admin.firestore.FieldValue.delete(),
    }, { merge: true });
  } catch (erro) {
    await pedidoDoc.ref.set({
      pix_reconciliacao_erro: mensagemErro(erro),
      pix_proxima_verificacao_em: timestampDaqui(5 * 60 * 1000),
    }, { merge: true });
    console.error(`[reconciliarPixAsaas] Falha no pedido ${pedidoDoc.id}:`, mensagemErro(erro));
  }
}

async function encaminharEventoParaRevisaoManual(eventoDoc, detalhes = {}) {
  await db().runTransaction(async (tx) => {
    const atualSnap = await tx.get(eventoDoc.ref);
    if (!atualSnap.exists || atualSnap.data()?.estado !== "requer_revisao") return;
    tx.set(eventoDoc.ref, {
      estado: "revisao_manual",
      revisaoAutomaticaConcluidaEm: admin.firestore.FieldValue.serverTimestamp(),
      ...detalhes,
    }, { merge: true });
  });
}

async function reprocessarEventoInstaEmRevisao(eventoDoc) {
  const dados = eventoDoc.data() || {};
  const motivo = String(dados.motivoRevisao || "");
  const paymentId = String(dados.paymentId || "").trim();

  if (!MOTIVOS_REPROCESSAVEIS_INSTA.has(motivo) || !paymentId) {
    await encaminharEventoParaRevisaoManual(eventoDoc);
    return;
  }

  try {
    const janelaMinutos = await buscarJanelaInstaSeguraMinutos();
    const pagamento = await buscarPagamentoAsaas(paymentId, ASAAS_API_KEY.value());
    if (
      String(pagamento?.id || "") !== paymentId ||
      normalizarStatus(pagamento?.status) !== "RECEIVED"
    ) {
      await encaminharEventoParaRevisaoManual(eventoDoc, {
        revisaoAutomaticaResultado: "pagamento_nao_recebido_ou_divergente",
      });
      return;
    }

    const resultado = await processarRecebimento({
      eventoRef: eventoDoc.ref,
      eventoId: String(dados.eventoId || eventoDoc.id),
      paymentId,
      pagamento,
      tentativas: Math.max(
        Number(dados.tentativas || 0),
        MAX_TENTATIVAS_ANTES_REVISAO + 1
      ),
      eventoRecebidoEm: dados.recebidoEm,
      janelaInstaSeguraMinutos: janelaMinutos,
      somenteVinculoSeguro: true,
    });

    if (!resultado?.confirmado) {
      // O pagamento e o webhook do InstaDelivery são independentes. Se o
      // PIX chegar primeiro (ou o provedor reenviar o pedido alguns minutos
      // depois), não entregamos a pendência para revisão humana logo na
      // primeira checagem: mantemos a rechecagem automática pela mesma janela
      // segura usada para comparar nome, valor e horário.
      const recebidoEmMs = instanteEmMs(dados.recebidoEm);
      if (
        resultado?.motivo === "sem_candidato_insta_seguro" &&
        Date.now() - recebidoEmMs < janelaMinutos * 60 * 1000
      ) {
        await eventoDoc.ref.set({
          revisaoAutomaticaResultado: "aguardando_pedido_instadelivery",
          revisaoAutomaticaUltimaTentativaEm: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
      }
      await encaminharEventoParaRevisaoManual(eventoDoc, {
        revisaoAutomaticaResultado: resultado?.motivo || "sem_vinculo_seguro",
      });
    }
  } catch (erro) {
    if (erro instanceof ErroConciliacao && !erro.transitorio) {
      await encaminharEventoParaRevisaoManual(eventoDoc, {
        revisaoAutomaticaResultado: erro.codigo || "revisao_necessaria",
        revisaoAutomaticaErro: mensagemErro(erro),
      });
      return;
    }

    await eventoDoc.ref.set({
      revisaoAutomaticaErro: mensagemErro(erro),
      revisaoAutomaticaFalhouEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.error(
      `[reconciliarPixAsaas] Falha ao reprocessar evento ${eventoDoc.id}:`,
      mensagemErro(erro)
    );
  }
}

async function executarComConcorrencia(itens, limite, tarefa) {
  let indice = 0;
  const workers = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (indice < itens.length) {
      const atual = itens[indice];
      indice += 1;
      await tarefa(atual);
    }
  });
  await Promise.all(workers);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) RECONCILIAÇÃO: segunda via independente do webhook.
// ─────────────────────────────────────────────────────────────────────────────
const reconciliarPixAsaas = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "America/Sao_Paulo",
    secrets: [ASAAS_API_KEY, TOKEN_META],
    memory: "512MiB",
    cpu: 1,
    timeoutSeconds: 300,
  },
  async () => {
    const [pedidosSnapshot, eventosSnapshot] = await Promise.all([
      db().collection("pedidos")
        .where("pix_proxima_verificacao_em", "<=", admin.firestore.Timestamp.now())
        .limit(100)
        .get(),
      db().collection(COLECAO_EVENTOS)
        .where("estado", "==", "requer_revisao")
        .limit(50)
        .get(),
    ]);

    await Promise.all([
      executarComConcorrencia(pedidosSnapshot.docs, 5, reconciliarPedido),
      executarComConcorrencia(eventosSnapshot.docs, 3, reprocessarEventoInstaEmRevisao),
    ]);
  }
);

module.exports = {
  webhookAsaas,
  processarEventoAsaas,
  reconciliarPixAsaas,
};
