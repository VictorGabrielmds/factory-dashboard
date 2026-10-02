// ============================================================================
// NOTIFICAÇÕES CRÍTICAS DE PEDIDO
//
// Uma mensagem enviada a um provedor externo não tem "exactly once" real sem
// uma chave de idempotência aceita por esse provedor. Por isso, para eventos
// críticos como cancelamento, a regra é deliberadamente conservadora:
//
//   pendente -> enviando -> aceito_pela_meta | falhou | incerto
//
// Depois de tentar o POST, qualquer resultado que não confirme um ID da Meta
// vira `incerto`; nunca se repete às cegas e o painel recebe uma pendência.
// ============================================================================

const { idDocSeguro, normalizarTelefone } = require("../lib/util");

const COLECAO_NOTIFICACOES_PEDIDO = "notificacoes_pedido";
const TIPO_CANCELAMENTO = "whatsapp_cancelamento";

const ESTADOS_NOTIFICACAO = Object.freeze({
  PENDENTE: "pendente",
  ENVIANDO: "enviando",
  ACEITO_PELA_META: "aceito_pela_meta",
  FALHOU: "falhou",
  INCERTO: "incerto",
});

function idNotificacaoCancelamento(pedidoId) {
  const id = String(pedidoId ?? "").trim();
  if (!id) throw new Error("Pedido inválido para notificação de cancelamento.");
  return idDocSeguro(`cancelamento_${id}`);
}

function idPendenciaNotificacaoCancelamento(pedidoId) {
  const id = String(pedidoId ?? "").trim();
  if (!id) throw new Error("Pedido inválido para pendência de cancelamento.");
  return idDocSeguro(`notificacao_cancelamento_${id}`);
}

function textoSeguro(valor, limite = 500) {
  return String(valor ?? "").trim().slice(0, limite);
}

function dadosNotificacaoCancelamento({ pedidoId, pedido, origem, agora }) {
  const id = String(pedidoId).trim();
  const nomeCliente = textoSeguro(pedido?.nome_destinatario || "Cliente", 160) || "Cliente";
  const orderId = textoSeguro(pedido?.order_id || id, 120) || id;
  const telefoneOriginal = textoSeguro(pedido?.telefone_destinatario, 50);
  const telefone = normalizarTelefone(telefoneOriginal);

  return {
    versao: 1,
    tipo: TIPO_CANCELAMENTO,
    pedidoId: id,
    orderId,
    origem: textoSeguro(origem || "cancelamento_painel", 80),
    telefone: telefone || null,
    telefoneOriginal: telefoneOriginal || null,
    nomeCliente,
    template: "aviso_cancelamento",
    parametros: [nomeCliente, orderId],
    preview: `Olá ${nomeCliente}, infelizmente seu pedido #${orderId} precisou ser cancelado. Se tiver alguma dúvida, é só mandar uma mensagem aqui!`,
    estado: ESTADOS_NOTIFICACAO.PENDENTE,
    tentativas: 0,
    criadoEm: agora,
    atualizadoEm: agora,
  };
}

function visaoNotificacaoPedido({ id, estado, motivo = null, msgId = null, tentativa = null }) {
  return {
    id: textoSeguro(id, 1400),
    estado,
    ...(motivo ? { motivo: textoSeguro(motivo, 500) } : {}),
    ...(msgId ? { metaMensagemId: textoSeguro(msgId, 300) } : {}),
    ...(Number.isFinite(tentativa) ? { tentativa } : {}),
  };
}

function detalheErro(erro) {
  const bruto = erro?.response?.data ?? erro?.message ?? "Falha desconhecida ao comunicar com a Meta.";
  let texto;
  try {
    texto = typeof bruto === "string" ? bruto : JSON.stringify(bruto);
  } catch (_) {
    texto = "Falha desconhecida ao comunicar com a Meta.";
  }
  return textoSeguro(texto, 1000) || "Falha desconhecida ao comunicar com a Meta.";
}

/**
 * Só 4xx (menos 429) prova que a Meta rejeitou a solicitação. Timeout, rede,
 * 429 e 5xx são tratados como ambíguos: a Meta pode ter aceitado o POST e a
 * resposta ter se perdido no caminho.
 */
function classificarFalhaMeta(erro) {
  const status = Number(erro?.response?.status);
  const permanente = Number.isInteger(status) && status >= 400 && status < 500 && status !== 429;
  return {
    estado: permanente ? ESTADOS_NOTIFICACAO.FALHOU : ESTADOS_NOTIFICACAO.INCERTO,
    codigo: permanente ? "META_REJEITOU" : "META_RESULTADO_INCERTO",
    detalhe: detalheErro(erro),
    statusHttp: Number.isInteger(status) ? status : null,
  };
}

function dadosPendenciaNotificacao({ pedidoId, notificacaoId, estado, motivo, agora }) {
  const descricaoBase = estado === ESTADOS_NOTIFICACAO.FALHOU
    ? "O WhatsApp de cancelamento foi rejeitado e precisa de ação manual"
    : "Não foi possível confirmar se o WhatsApp de cancelamento foi aceito; não houve reenvio automático para evitar duplicidade";

  return {
    chatId: "sistema",
    tipo: "notificacao_cancelamento",
    pedidoId: String(pedidoId),
    notificacaoId: String(notificacaoId),
    descricao: `${descricaoBase} (pedido #${pedidoId}). Motivo: ${textoSeguro(motivo, 500) || "não informado"}.`,
    resolvida: false,
    criadaEm: agora,
  };
}

module.exports = {
  COLECAO_NOTIFICACOES_PEDIDO,
  TIPO_CANCELAMENTO,
  ESTADOS_NOTIFICACAO,
  idNotificacaoCancelamento,
  idPendenciaNotificacaoCancelamento,
  dadosNotificacaoCancelamento,
  visaoNotificacaoPedido,
  detalheErro,
  classificarFalhaMeta,
  dadosPendenciaNotificacao,
};
