// ============================================================================
// WEBHOOK INSTADELIVERY + GATILHO DE NOTIFICAÇÃO
//
// ANTES: o webhook salvava o pedido E enviava WhatsApp na mesma requisição
//        (lento, e webhook reenviado = mensagem duplicada). Havia ainda um
//        segundo gatilho (status 5) competindo com o webhook.
//
// AGORA:
//   1. webhookPedidos: exige ?token=, valida e grava o evento numa inbox
//      durável antes de responder. O ACK não depende do processamento completo.
//   2. processarEventoPedidoInsta: converte a inbox no pedido operacional em
//      uma transação; o agendador recupera eventos se o gatilho falhar.
//   3. notificarStatusPedido (onDocumentWritten): TODA notificação sai daqui.
//      Uma transação marca `notificados.{status}` ANTES de enviar; se o mesmo
//      status chegar de novo (webhook reenviado, edição manual, etc.),
//      NENHUMA mensagem duplicada é enviada ao cliente.
// ============================================================================

const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

const {
  PEDIDOS_WEBHOOK_TOKEN,
  PEDIDOS_WEBHOOK_BACKUP_TOKEN,
  TOKEN_META,
} = require("../config");
const { comparaSegura }        = require("../lib/seguranca");
const {
  calcularJanelas,
  dataHoraAtualSP,
  normalizarDataVenda,
  dataOperacionalPedido,
  idDocSeguro,
} = require("../lib/util");
const { processarNotificacaoWhatsApp } = require("../services/pedidos");
const { devePreservarCancelamento } = require("../services/comandosPedidos");
const {
  COLECAO_NOTIFICACOES_PEDIDO,
  dadosNotificacaoCancelamento,
  idNotificacaoCancelamento,
} = require("../services/notificacoesPedido");

const db = () => admin.firestore();
const COLECAO_INBOX_PEDIDOS = "inbox_pedidos_instadelivery";
const MAX_TENTATIVAS_INBOX = 10;

function serializarEstavel(valor) {
  if (Array.isArray(valor)) return valor.map(serializarEstavel);
  if (valor && typeof valor === "object") {
    return Object.keys(valor).sort().reduce((objeto, chave) => {
      objeto[chave] = serializarEstavel(valor[chave]);
      return objeto;
    }, {});
  }
  return valor;
}

function idEventoPedido(payload) {
  const orderId = idDocSeguro(String(payload?.order_id || "sem_id")).slice(0, 80);
  const hash = crypto.createHash("sha256")
    .update(JSON.stringify(serializarEstavel(payload || {})))
    .digest("hex");
  return `pedido_${orderId}_${hash}`;
}

function normalizarPedidoRecebido(payload) {
  const pedido = { ...(payload || {}) };
  const dataVendaRecebida = pedido.data_venda;
  const dataVendaNormalizada = normalizarDataVenda(dataVendaRecebida);

  if (dataVendaNormalizada) {
    pedido.data_venda = dataVendaNormalizada;
    if (String(dataVendaRecebida).trim() !== dataVendaNormalizada) {
      pedido.data_venda_origem = String(dataVendaRecebida).slice(0, 200);
    }
  } else {
    if (dataVendaRecebida != null && String(dataVendaRecebida).trim()) {
      pedido.data_venda_origem = String(dataVendaRecebida).slice(0, 200);
    }
    pedido.data_venda = dataHoraAtualSP();
  }

  const statusNumero = Number(pedido.status);
  if (Number.isInteger(statusNumero) && statusNumero >= 1 && statusNumero <= 5) {
    pedido.status = statusNumero;
  } else {
    if (pedido.status != null) pedido.status_origem = String(pedido.status).slice(0, 80);
    pedido.status = 1;
  }

  if (pedido.origem == null || String(pedido.origem).trim() === "") {
    pedido.origem = "instadelivery";
  }

  if (pedido.data_venda && pedido.agendamento) {
    const janelas = calcularJanelas(pedido.data_venda, pedido.agendamento);
    if (janelas) {
      pedido.janela_inicio = janelas.janela_inicio;
      pedido.janela_fim = janelas.janela_fim;
    }
  }
  pedido.data_operacional = dataOperacionalPedido(pedido.data_venda, pedido.agendamento);
  if (!pedido.status_interno) pedido.status_interno = "recebido";
  return pedido;
}

async function persistirEventoPedido(payload, canal) {
  const eventoId = idEventoPedido(payload);
  const ref = db().collection(COLECAO_INBOX_PEDIDOS).doc(eventoId);
  try {
    await ref.create({
      eventoId,
      orderId: String(payload.order_id),
      canal,
      pedido: normalizarPedidoRecebido(payload),
      estado: "recebido",
      tentativas: 0,
      recebidoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { eventoId, duplicado: false };
  } catch (erro) {
    if (erro?.code === 6 || erro?.code === "already-exists") {
      return { eventoId, duplicado: true };
    }
    throw erro;
  }
}

async function processarEventoPedidoRef(eventoRef) {
  return db().runTransaction(async (tx) => {
    const eventoSnap = await tx.get(eventoRef);
    if (!eventoSnap.exists) return { ignorado: true };
    const evento = eventoSnap.data() || {};
    if (["processado", "erro_permanente"].includes(evento.estado)) return { ignorado: true };

    const pedido = evento.pedido || {};
    if (!pedido.order_id) throw new Error(`Inbox ${eventoRef.id} sem order_id.`);

    const pedidoRef = db().collection("pedidos").doc(String(pedido.order_id));
    const notificacaoRef = db().collection(COLECAO_NOTIFICACOES_PEDIDO)
      .doc(idNotificacaoCancelamento(pedido.order_id));
    const [pedidoAtualSnap, notificacaoSnap] = await Promise.all([
      tx.get(pedidoRef),
      tx.get(notificacaoRef),
    ]);
    const pedidoAtual = pedidoAtualSnap.exists ? pedidoAtualSnap.data() || {} : {};

    if (typeof pedidoAtual.primeiro_pedido_cliente !== "boolean") {
      if (pedido.telefone_destinatario) {
        const mesmosTelefone = await tx.get(
          db().collection("pedidos")
            .where("telefone_destinatario", "==", pedido.telefone_destinatario)
            .limit(2)
        );
        pedido.primeiro_pedido_cliente = !mesmosTelefone.docs.some(
          (doc) => doc.id !== String(pedido.order_id)
        );
      } else {
        pedido.primeiro_pedido_cliente = false;
      }
    }

    if (pedidoAtual.impresso === true) {
      const mudouAlgo = Object.entries(pedido).some(
        ([chave, valor]) => JSON.stringify(pedidoAtual[chave]) !== JSON.stringify(valor)
      );
      if (mudouAlgo) pedido.impresso = false;
    }

    const statusAtual = Number(pedidoAtual.status);
    const statusRecebido = Number(pedido.status);
    if (devePreservarCancelamento(statusAtual, statusRecebido)) {
      tx.set(pedidoRef, {
        ultimoStatusWebhookIgnorado: {
          statusRecebido: pedido.status ?? null,
          canal: evento.canal || "inbox",
          recebidoEm: admin.firestore.FieldValue.serverTimestamp(),
        },
      }, { merge: true });
    } else {
      tx.set(pedidoRef, pedido, { merge: true });

      const virouCancelado = statusRecebido === 4 && statusAtual !== 4;
      if (virouCancelado && !notificacaoSnap.exists) {
        tx.create(notificacaoRef, dadosNotificacaoCancelamento({
          pedidoId: String(pedido.order_id),
          pedido: { ...pedidoAtual, ...pedido },
          origem: "cancelamento_webhook_instadelivery",
          agora: admin.firestore.FieldValue.serverTimestamp(),
        }));
      }
    }

    tx.set(eventoRef, {
      estado: "processado",
      processadoEm: admin.firestore.FieldValue.serverTimestamp(),
      ultimoErro: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    return {
      ignorado: false,
      pedidoId: String(pedido.order_id),
      statusAnterior: Number.isFinite(statusAtual) ? statusAtual : null,
      statusRecebido,
    };
  });
}

async function registrarFalhaInbox(eventoRef, erro) {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(eventoRef);
    if (!snap.exists || snap.data()?.estado === "processado") return { permanente: false, ignorado: true };
    const tentativas = Number(snap.data()?.tentativas || 0) + 1;
    const permanente = tentativas >= MAX_TENTATIVAS_INBOX;
    tx.set(eventoRef, {
      estado: permanente ? "erro_permanente" : "erro",
      tentativas,
      ultimoErro: String(erro?.message || erro).slice(0, 500),
      ultimaFalhaEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    if (permanente) {
      const orderId = String(snap.data()?.orderId || "desconhecido");
      tx.set(db().collection("pendencias").doc(idDocSeguro(`inbox_pedido_${eventoRef.id}`)), {
        chatId: "sistema",
        tipo: "pedido_instadelivery_nao_processado",
        pedidoId: orderId,
        inboxId: eventoRef.id,
        descricao:
          `O pedido #${orderId} chegou ao webhook, mas não pôde ser processado após ` +
          `${tentativas} tentativas. Nenhum dado foi descartado.`,
        resolvida: false,
        criadaEm: dataHoraAtualSP(),
        criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return { permanente, ignorado: false };
  });
}

async function processarEventoPedidoComRecuperacao(eventoRef) {
  try {
    return await processarEventoPedidoRef(eventoRef);
  } catch (erro) {
    const falha = await registrarFalhaInbox(eventoRef, erro);
    console.error(`[inboxPedidos] Falha em ${eventoRef.id}:`, erro);
    if (!falha.permanente) throw erro;
    return { ignorado: true, permanente: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) RECEPTOR — salva e responde
//    URL a cadastrar no InstaDelivery:
//    https://.../webhookPedidos?token=<token-configurado-no-provedor>
// ─────────────────────────────────────────────────────────────────────────────
async function processarWebhookPedidos(req, res, tokenEsperado, canal) {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // 🔒 Sem o token correto na URL, ninguém injeta pedidos falsos
    if (!comparaSegura(req.query.token, tokenEsperado)) {
      return res.status(401).send("Não autorizado");
    }

    const pedido = { ...req.body };
    if (!pedido.order_id) {
      console.error(`[${canal}] Payload inválido: sem order_id.`);
      return res.status(400).send("order_id inválido");
    }

    console.log(`[${canal}] Recebido pedido ${pedido.order_id}, status ${pedido.status ?? "ausente"}.`);
    try {
      const resultado = await persistirEventoPedido(pedido, canal);
      console.log(
        `[${canal}] Pedido ${pedido.order_id} persistido no inbox ${resultado.eventoId}` +
        `${resultado.duplicado ? " (duplicado seguro)" : ""}.`
      );
      return res.status(200).send("Pedido recebido");
    } catch (error) {
      console.error(`[${canal}] Erro ao persistir pedido no inbox:`, error);
      return res.status(500).send("Falha ao registrar pedido");
    }
}

const opcoesWebhookPedidos = { memory: "256MiB", cpu: 1 };

const webhookPedidos = onRequest(
  { ...opcoesWebhookPedidos, secrets: [PEDIDOS_WEBHOOK_TOKEN] },
  (req, res) => processarWebhookPedidos(
    req,
    res,
    PEDIDOS_WEBHOOK_TOKEN.value(),
    "webhookPedidos"
  )
);

// Endpoint independente para o campo "Webhook 2" do InstaDelivery. Os dois
// geram o mesmo ID de inbox para o mesmo payload; uma entrega duplicada é
// segura, enquanto uma mudança real de status gera um novo evento processável.
const webhookPedidosBackup = onRequest(
  { ...opcoesWebhookPedidos, secrets: [PEDIDOS_WEBHOOK_BACKUP_TOKEN] },
  (req, res) => processarWebhookPedidos(
    req,
    res,
    PEDIDOS_WEBHOOK_BACKUP_TOKEN.value(),
    "webhookPedidosBackup"
  )
);

const processarEventoPedidoInsta = onDocumentCreated(
  {
    document: `${COLECAO_INBOX_PEDIDOS}/{eventoId}`,
    memory: "256MiB",
    cpu: 1,
    retry: true,
  },
  async (event) => {
    if (!event.data?.ref) return;
    const resultado = await processarEventoPedidoComRecuperacao(event.data.ref);
    if (resultado?.pedidoId) {
      console.log(`[inboxPedidos] Pedido ${resultado.pedidoId} salvo/atualizado.`);
    }
  }
);

const reconciliarInboxPedidos = onSchedule(
  {
    schedule: "every 2 minutes",
    timeZone: "America/Sao_Paulo",
    memory: "256MiB",
    cpu: 1,
    timeoutSeconds: 180,
  },
  async () => {
    const snapshot = await db().collection(COLECAO_INBOX_PEDIDOS)
      .where("estado", "in", ["recebido", "erro"])
      .limit(50)
      .get();
    const resultados = await Promise.allSettled(
      snapshot.docs.map((doc) => processarEventoPedidoComRecuperacao(doc.ref))
    );
    const falhas = resultados.filter((resultado) => resultado.status === "rejected");
    if (falhas.length > 0) {
      console.error(`[reconciliarInboxPedidos] ${falhas.length} evento(s) continuam pendentes.`);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 2) GATILHO ÚNICO DE NOTIFICAÇÃO
//    Dispara em criação E atualização. Substitui o antigo gatilhoStatusPedido.
// ─────────────────────────────────────────────────────────────────────────────
// O status 4 segue a fila durável `notificacoes_pedido`: o job é criado na
// mesma transação de cancelamento (painel ou webhook) e não pode ser enviado
// pelo fluxo legado abaixo, que marca "notificado" antes da Meta confirmar.
const STATUS_NOTIFICAVEIS = new Set([2, 3, 5]);

const notificarStatusPedido = onDocumentWritten(
  {
    document: "pedidos/{pedidoId}",
    secrets: [TOKEN_META],
    memory: "512MiB",
    cpu: 1,
    retry: true,
  },
  async (event) => {
    const depois = event.data?.after?.exists ? event.data.after.data() : null;
    if (!depois) return; // documento excluído

    const antes        = event.data?.before?.exists ? event.data.before.data() : null;
    const statusDepois = Number(depois.status);
    const statusAntes  = antes ? Number(antes.status) : null;

    if (!STATUS_NOTIFICAVEIS.has(statusDepois)) return;
    if (statusAntes === statusDepois && antes?.notificados?.[statusDepois]) return;

    // 🔐 Transação: só UMA execução consegue marcar o status como notificado.
    // Webhook duplicado, retry do gatilho, edição manual — nada gera 2ª mensagem.
    const ref = event.data.after.ref;
    const deveEnviar = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const dados = snap.data() || {};
      if (dados.notificados?.[statusDepois]) return false;
      tx.set(ref, {
        notificados: { ...(dados.notificados || {}), [statusDepois]: true },
      }, { merge: true });
      return true;
    });

    if (!deveEnviar) {
      console.log(`[notificarStatusPedido] Pedido ${depois.order_id} status ${statusDepois} já notificado. Ignorando.`);
      return;
    }

    console.log(`[notificarStatusPedido] Pedido ${depois.order_id} → status ${statusDepois}. Notificando.`);
    try {
      await processarNotificacaoWhatsApp(TOKEN_META.value(), depois);
    } catch (erro) {
      // Erro transitório (rede/5xx): desmarca e relança para o retry da GCP reenviar
      const transitorio = !erro.response || erro.response.status >= 500 || erro.response.status === 429;
      if (transitorio) {
        await ref.set({ notificados: { [statusDepois]: false } }, { merge: true });
        throw erro; // retry: true reprocessa
      }
      // Erro permanente (template reprovado, número inválido): loga e não repete
      console.error(`[notificarStatusPedido] Erro permanente pedido ${depois.order_id}:`,
        JSON.stringify(erro.response?.data ?? erro.message));
    }
  }
);

module.exports = {
  webhookPedidos,
  webhookPedidosBackup,
  processarEventoPedidoInsta,
  reconciliarInboxPedidos,
  notificarStatusPedido,
  // Regras puras exportadas para regressões unitárias do receptor.
  idEventoPedido,
  normalizarPedidoRecebido,
};
