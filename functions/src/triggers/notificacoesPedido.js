// ============================================================================
// WORKER DURÁVEL — aviso de cancelamento por WhatsApp
//
// O pedido e seu job são criados na mesma transação. O worker tem semântica
// at-most-once para o POST externo: um timeout, 5xx ou queda após a tentativa
// vira pendência humana, não outro envio automático que poderia duplicar a
// mensagem ao cliente.
// ============================================================================

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

const { TOKEN_META } = require("../config");
const { enviarTemplateConfirmadoUmaVez } = require("../services/meta");
const { horaAtualSP, idDocSeguro, normalizarTelefone } = require("../lib/util");
const {
  COLECAO_NOTIFICACOES_PEDIDO,
  ESTADOS_NOTIFICACAO,
  TIPO_CANCELAMENTO,
  classificarFalhaMeta,
  dadosPendenciaNotificacao,
  idPendenciaNotificacaoCancelamento,
  visaoNotificacaoPedido,
} = require("../services/notificacoesPedido");

const db = () => admin.firestore();
const LIMITE_PENDENTE_MS = 5 * 60 * 1000;
const LIMITE_ENVIANDO_MS = 10 * 60 * 1000;

function timestampParaMs(timestamp) {
  return typeof timestamp?.toMillis === "function" ? timestamp.toMillis() : null;
}

function execucaoIdPadrao(prefixo = "worker") {
  return `${prefixo}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function reivindicarNotificacaoCancelamento({ database, FieldValue, notificacaoRef, execucaoId }) {
  return database.runTransaction(async (tx) => {
    const snap = await tx.get(notificacaoRef);
    if (!snap.exists) return null;

    const dados = snap.data() || {};
    if (dados.tipo !== TIPO_CANCELAMENTO || dados.estado !== ESTADOS_NOTIFICACAO.PENDENTE) {
      return null;
    }

    const tentativas = Number(dados.tentativas || 0) + 1;
    const agora = FieldValue.serverTimestamp();
    tx.update(notificacaoRef, {
      estado: ESTADOS_NOTIFICACAO.ENVIANDO,
      execucaoId,
      tentativas,
      iniciadaEm: agora,
      atualizadoEm: agora,
    });
    return { ...dados, tentativas, execucaoId };
  });
}

function detalheFinal({ estado, motivo, msgId, tentativa, registroChatPendente, statusMeta }) {
  return {
    estado,
    ...(motivo ? { motivo: String(motivo).slice(0, 1000) } : {}),
    ...(msgId ? { metaMensagemId: String(msgId).slice(0, 300) } : {}),
    ...(Number.isFinite(tentativa) ? { tentativa } : {}),
    ...(registroChatPendente ? { registroChatPendente: String(registroChatPendente).slice(0, 500) } : {}),
    ...(statusMeta ? { statusMeta } : {}),
  };
}

async function finalizarNotificacaoCancelamento({
  database,
  FieldValue,
  notificacaoRef,
  execucaoId,
  estado,
  motivo = null,
  codigo = null,
  statusHttp = null,
  msgId = null,
  registroChatPendente = null,
}) {
  return database.runTransaction(async (tx) => {
    const jobSnap = await tx.get(notificacaoRef);
    if (!jobSnap.exists) return { atualizada: false, motivo: "JOB_AUSENTE" };

    const job = jobSnap.data() || {};
    if (job.estado !== ESTADOS_NOTIFICACAO.ENVIANDO || job.execucaoId !== execucaoId) {
      return { atualizada: false, motivo: "EXECUCAO_SUPERADA" };
    }

    // A Meta pode chamar o webhook de status antes de esta função conseguir
    // persistir `metaMensagemId`. O webhook guarda esse estado separado; ao
    // concluir aqui, projetamos a falha já conhecida no job/pedido.
    const statusMetaRef = msgId
      ? database.collection("status_meta_saida").doc(idDocSeguro(msgId))
      : null;
    const statusMetaSnap = statusMetaRef ? await tx.get(statusMetaRef) : null;
    const statusMeta = statusMetaSnap?.exists ? statusMetaSnap.data() || {} : null;

    let estadoFinal = estado;
    let motivoFinal = motivo;
    if (estado === ESTADOS_NOTIFICACAO.ACEITO_PELA_META && statusMeta?.status === "failed") {
      estadoFinal = ESTADOS_NOTIFICACAO.FALHOU;
      motivoFinal = statusMeta.motivo || "A Meta informou falha depois de aceitar a mensagem.";
    }

    const precisaPendencia = [ESTADOS_NOTIFICACAO.FALHOU, ESTADOS_NOTIFICACAO.INCERTO]
      .includes(estadoFinal);
    const pendenciaRef = precisaPendencia
      ? database.collection("pendencias").doc(idPendenciaNotificacaoCancelamento(job.pedidoId))
      : null;
    // Toda leitura deve ocorrer antes das escritas de uma transação Firestore.
    const pendenciaSnap = pendenciaRef ? await tx.get(pendenciaRef) : null;

    const agora = FieldValue.serverTimestamp();
    const final = detalheFinal({
      estado: estadoFinal,
      motivo: motivoFinal,
      msgId,
      tentativa: job.tentativas,
      registroChatPendente,
      statusMeta: statusMeta?.status || null,
    });
    tx.set(notificacaoRef, {
      ...final,
      ...(codigo ? { codigo } : {}),
      ...(Number.isInteger(statusHttp) ? { statusHttp } : {}),
      ...(estadoFinal === ESTADOS_NOTIFICACAO.ACEITO_PELA_META ? { aceitoEm: agora } : {}),
      ...(estadoFinal === ESTADOS_NOTIFICACAO.FALHOU ? { falhouEm: agora } : {}),
      ...(estadoFinal === ESTADOS_NOTIFICACAO.INCERTO ? { marcadoIncertoEm: agora } : {}),
      atualizadoEm: agora,
    }, { merge: true });

    const pedidoRef = database.collection("pedidos").doc(String(job.pedidoId));
    tx.set(pedidoRef, {
      notificacao_cancelamento: {
        ...visaoNotificacaoPedido({
          id: notificacaoRef.id,
          estado: estadoFinal,
          motivo: motivoFinal,
          msgId,
          tentativa: job.tentativas,
        }),
        atualizadaEm: agora,
      },
    }, { merge: true });

    if (precisaPendencia && (!pendenciaSnap?.exists || pendenciaSnap.data()?.resolvida !== true)) {
      tx.set(pendenciaRef, {
        ...dadosPendenciaNotificacao({
          pedidoId: job.pedidoId,
          notificacaoId: notificacaoRef.id,
          estado: estadoFinal,
          motivo: motivoFinal,
          agora: horaAtualSP(),
        }),
        criadaEmTimestamp: agora,
        atualizadaEm: agora,
      }, { merge: true });
    }

    return { atualizada: true, estado: estadoFinal, pedidoId: String(job.pedidoId) };
  });
}

async function processarNotificacaoCancelamento({
  database,
  FieldValue,
  notificacaoRef,
  token,
  enviarTemplate = enviarTemplateConfirmadoUmaVez,
  execucaoId = execucaoIdPadrao(),
}) {
  const job = await reivindicarNotificacaoCancelamento({
    database, FieldValue, notificacaoRef, execucaoId,
  });
  if (!job) return { processada: false, estado: "ignorada" };

  const telefone = normalizarTelefone(job.telefone || job.telefoneOriginal);
  if (!telefone) {
    const resultado = await finalizarNotificacaoCancelamento({
      database,
      FieldValue,
      notificacaoRef,
      execucaoId,
      estado: ESTADOS_NOTIFICACAO.FALHOU,
      codigo: "TELEFONE_INVALIDO",
      motivo: "O pedido não possui um telefone válido para o WhatsApp.",
    });
    return { processada: resultado.atualizada, estado: resultado.estado };
  }

  let aceite;
  try {
    aceite = await enviarTemplate(token, telefone, job.template, [
      { type: "text", text: job.parametros?.[0] || job.nomeCliente || "Cliente" },
      { type: "text", text: job.parametros?.[1] || job.orderId || job.pedidoId },
    ], {
      nomeCliente: job.nomeCliente || "Cliente",
      textoPreview: job.preview || null,
      clientId: notificacaoRef.id,
    });
  } catch (erro) {
    const falha = classificarFalhaMeta(erro);
    const resultado = await finalizarNotificacaoCancelamento({
      database, FieldValue, notificacaoRef, execucaoId, ...falha,
    });
    return { processada: resultado.atualizada, estado: resultado.estado, codigo: falha.codigo };
  }

  const msgId = typeof aceite === "string" ? aceite : aceite?.msgId;
  if (!msgId) {
    const resultado = await finalizarNotificacaoCancelamento({
      database,
      FieldValue,
      notificacaoRef,
      execucaoId,
      estado: ESTADOS_NOTIFICACAO.INCERTO,
      codigo: "META_SEM_ID",
      motivo: "A Meta respondeu sem o identificador da mensagem; não houve reenvio automático.",
    });
    return { processada: resultado.atualizada, estado: resultado.estado, codigo: "META_SEM_ID" };
  }

  // Se este último update falhar, não relançamos a function: a Meta já
  // confirmou o aceite. O varredor transforma o job ainda "enviando" em
  // `incerto` visível, sem repetir o POST.
  try {
    const resultado = await finalizarNotificacaoCancelamento({
      database,
      FieldValue,
      notificacaoRef,
      execucaoId,
      estado: ESTADOS_NOTIFICACAO.ACEITO_PELA_META,
      msgId,
      registroChatPendente: typeof aceite === "object" ? aceite.registroChatPendente : null,
    });
    return { processada: resultado.atualizada, estado: resultado.estado, msgId };
  } catch (erroFinal) {
    console.error(
      `[notificacoesPedido] Meta aceitou ${msgId}, mas não foi possível concluir ${notificacaoRef.id}:`,
      erroFinal.message,
    );
    return { processada: false, estado: ESTADOS_NOTIFICACAO.ENVIANDO, msgId };
  }
}

const processarNotificacaoCancelamentoCriada = onDocumentCreated(
  {
    document: `${COLECAO_NOTIFICACOES_PEDIDO}/{notificacaoId}`,
    secrets: [TOKEN_META],
    memory: "256MiB",
    cpu: 1,
    retry: true,
  },
  async (event) => {
    const ref = event.data?.ref;
    if (!ref) return;
    const resultado = await processarNotificacaoCancelamento({
      database: db(),
      FieldValue: admin.firestore.FieldValue,
      notificacaoRef: ref,
      token: TOKEN_META.value(),
      execucaoId: event.id || execucaoIdPadrao("evento"),
    });
    console.log(`[notificacoesPedido] ${ref.id}: ${resultado.estado}.`);
  }
);

async function reconciliarNotificacoesCancelamento({
  database = db(),
  FieldValue = admin.firestore.FieldValue,
  token,
  agoraMs = Date.now(),
  enviarTemplate = enviarTemplateConfirmadoUmaVez,
}) {
  const [pendentes, enviando] = await Promise.all([
    database.collection(COLECAO_NOTIFICACOES_PEDIDO)
      .where("estado", "==", ESTADOS_NOTIFICACAO.PENDENTE).limit(100).get(),
    database.collection(COLECAO_NOTIFICACOES_PEDIDO)
      .where("estado", "==", ESTADOS_NOTIFICACAO.ENVIANDO).limit(100).get(),
  ]);

  const resultados = [];
  for (const doc of pendentes.docs) {
    const criadoEm = timestampParaMs(doc.data().criadoEm);
    if (criadoEm == null || agoraMs - criadoEm < LIMITE_PENDENTE_MS) continue;
    resultados.push(await processarNotificacaoCancelamento({
      database,
      FieldValue,
      notificacaoRef: doc.ref,
      token,
      enviarTemplate,
      execucaoId: execucaoIdPadrao("reconciliador"),
    }));
  }

  for (const doc of enviando.docs) {
    const dados = doc.data() || {};
    const iniciadaEm = timestampParaMs(dados.iniciadaEm);
    if (iniciadaEm == null || agoraMs - iniciadaEm < LIMITE_ENVIANDO_MS) continue;
    resultados.push(await finalizarNotificacaoCancelamento({
      database,
      FieldValue,
      notificacaoRef: doc.ref,
      execucaoId: dados.execucaoId,
      estado: ESTADOS_NOTIFICACAO.INCERTO,
      codigo: "EXECUCAO_SEM_CONFIRMACAO",
      motivo: "A tentativa de envio não teve desfecho confirmado dentro do prazo; não houve reenvio automático.",
    }));
  }
  return resultados;
}

const reconciliarNotificacoesPedido = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "America/Sao_Paulo",
    secrets: [TOKEN_META],
    memory: "256MiB",
    cpu: 1,
    timeoutSeconds: 120,
  },
  async () => {
    const resultados = await reconciliarNotificacoesCancelamento({ token: TOKEN_META.value() });
    if (resultados.length) {
      console.warn(`[reconciliarNotificacoesPedido] ${resultados.length} job(s) recuperado(s)/sinalizado(s).`);
    }
  }
);

module.exports = {
  LIMITE_PENDENTE_MS,
  LIMITE_ENVIANDO_MS,
  reivindicarNotificacaoCancelamento,
  finalizarNotificacaoCancelamento,
  processarNotificacaoCancelamento,
  reconciliarNotificacoesCancelamento,
  processarNotificacaoCancelamentoCriada,
  reconciliarNotificacoesPedido,
};
