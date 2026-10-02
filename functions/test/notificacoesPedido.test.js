const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ESTADOS_NOTIFICACAO,
  classificarFalhaMeta,
  dadosNotificacaoCancelamento,
  idNotificacaoCancelamento,
  idPendenciaNotificacaoCancelamento,
} = require("../src/services/notificacoesPedido");

test("job de cancelamento usa ID determinístico e snapshot mínimo do pedido", () => {
  assert.equal(idNotificacaoCancelamento("148204781"), "cancelamento_148204781");
  assert.equal(idPendenciaNotificacaoCancelamento("148204781"), "notificacao_cancelamento_148204781");

  const job = dadosNotificacaoCancelamento({
    pedidoId: "148204781",
    pedido: {
      order_id: 148204781,
      nome_destinatario: "Maria Luiza",
      telefone_destinatario: "(92) 98888-1234",
    },
    origem: "cancelamento_painel",
    agora: "agora",
  });
  assert.deepEqual(job, {
    versao: 1,
    tipo: "whatsapp_cancelamento",
    pedidoId: "148204781",
    orderId: "148204781",
    origem: "cancelamento_painel",
    telefone: "5592988881234",
    telefoneOriginal: "(92) 98888-1234",
    nomeCliente: "Maria Luiza",
    template: "aviso_cancelamento",
    parametros: ["Maria Luiza", "148204781"],
    preview: "Olá Maria Luiza, infelizmente seu pedido #148204781 precisou ser cancelado. Se tiver alguma dúvida, é só mandar uma mensagem aqui!",
    estado: ESTADOS_NOTIFICACAO.PENDENTE,
    tentativas: 0,
    criadoEm: "agora",
    atualizadoEm: "agora",
  });
});

test("só rejeição 4xx comprovada é falha definitiva; resultado ambíguo não reenvia", () => {
  assert.deepEqual(classificarFalhaMeta({
    response: { status: 400, data: { error: "template inválido" } },
  }), {
    estado: ESTADOS_NOTIFICACAO.FALHOU,
    codigo: "META_REJEITOU",
    detalhe: "{\"error\":\"template inválido\"}",
    statusHttp: 400,
  });

  for (const erro of [
    new Error("timeout"),
    { response: { status: 429, data: "rate limited" } },
    { response: { status: 503, data: "indisponível" } },
  ]) {
    const resultado = classificarFalhaMeta(erro);
    assert.equal(resultado.estado, ESTADOS_NOTIFICACAO.INCERTO);
    assert.equal(resultado.codigo, "META_RESULTADO_INCERTO");
  }
});
