const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pedidoElegivelParaImpressao, montarReciboDoPedido, produzirTrabalhoDoPedido,
} = require("../src/impressao/produtorPedidos");

function timestamp(ms) { return { toMillis: () => ms, toDate: () => new Date(ms) }; }
function bancoMemoria(inicial = {}) {
  const docs = new Map(Object.entries(inicial));
  const ref = (colecao, id) => ({ caminho: `${colecao}/${id}`, id });
  const snap = (referencia) => ({ id: referencia.id, exists: docs.has(referencia.caminho), data: () => docs.get(referencia.caminho) });
  const gravar = (referencia, valor, merge = false) => docs.set(referencia.caminho,
    merge ? { ...(docs.get(referencia.caminho) || {}), ...valor } : valor);
  return { docs, db: {
    collection(colecao) { return { doc: (id) => {
      const referencia = ref(colecao, id);
      return { ...referencia, async get() { return snap(referencia); } };
    } }; },
    async runTransaction(fn) { return fn({ get: async (referencia) => snap(referencia),
      create(referencia, valor) { if (docs.has(referencia.caminho)) throw new Error("EXISTS"); gravar(referencia, valor); },
      update(referencia, valor) { if (!docs.has(referencia.caminho)) throw new Error("NOT_FOUND"); gravar(referencia, valor, true); } }); },
  } };
}
const FieldValue = { serverTimestamp: () => timestamp(100) };
const Timestamp = { fromMillis: timestamp };
const uid = "imp_aaaaaaaaaaaaaaaa";
function pedido(extra = {}) {
  return {
    origem: "app", status: 2, tipo_entrega: "delivery", forma_pagamento: ["04"],
    nome_destinatario: "Maria\u0007 da Silva", telefone_destinatario: "5592999991111", agendamento: "10/09 às 12:00",
    valor_venda: 53.5, descricao_item: ["Coxinha"], quantidade_item: [10], observacoes: "Sem pimenta",
    logradouro_destinatario: "Rua Um", numero_destinatario: "10", bairro_destinatario: "Centro",
    complemento_destinatario: null, referencia: null, pix_pagamento_id: "nunca no recibo", ...extra,
  };
}
function ambienteFila(extra = {}) {
  return {
    "configuracoes/impressao_api": { ativa: true, versao: 1, filaAtiva: true, dispositivoPadraoUid: uid },
    [`dispositivos_impressao/${uid}`]: { uid, ativo: true, tipo: "impressao", credencialVersao: 1 }, ...extra,
  };
}

test("produtor: só pedido próprio já liberado pode entrar na fila", () => {
  assert.equal(pedidoElegivelParaImpressao(pedido()), true);
  assert.equal(pedidoElegivelParaImpressao(pedido({ forma_pagamento: ["17"], status: 1, pix_confirmado: false })), false);
  assert.equal(pedidoElegivelParaImpressao(pedido({ forma_pagamento: ["17"], status: 1, pix_confirmado: true, pix_status: "RECEIVED" })), true);
  assert.equal(pedidoElegivelParaImpressao(pedido({ origem: "instadelivery" })), false);
  assert.equal(pedidoElegivelParaImpressao(pedido({ status: 4 })), false);
});

test("produtor: recibo deriva do snapshot confiável e não leva IDs financeiros", () => {
  const recibo = montarReciboDoPedido({ pedidoId: "148204781", pedido: pedido() });
  assert.equal(recibo.pago, false);
  assert.equal(recibo.nome.includes("\u0007"), false);
  assert.equal(recibo.entrega.endereco, "Rua Um, 10");
  assert.equal(JSON.stringify(recibo).includes("nunca no recibo"), false);
  assert.equal(montarReciboDoPedido({ pedidoId: "148204781", pedido: pedido({ quantidade_item: [0] }) }), null);
});

test("produtor: fila desativada ou destino inválido não cria trabalho", async () => {
  const desativada = bancoMemoria(ambienteFila({ "configuracoes/impressao_api": { ativa: true, versao: 1, filaAtiva: false, dispositivoPadraoUid: uid } }));
  const r1 = await produzirTrabalhoDoPedido({ db: desativada.db, FieldValue, Timestamp, pedidoId: "148204781", pedido: pedido(), agoraMs: 1 });
  assert.equal(r1.status, 204);
  assert.equal([...desativada.docs.keys()].some((caminho) => caminho.startsWith("trabalhos_impressao/")), false);
  const staff = bancoMemoria(ambienteFila({ [`staff/${uid}`]: { ativo: true } }));
  const r2 = await produzirTrabalhoDoPedido({ db: staff.db, FieldValue, Timestamp, pedidoId: "148204781", pedido: pedido(), agoraMs: 1 });
  assert.equal(r2.status, 409);
  assert.equal([...staff.docs.keys()].some((caminho) => caminho.startsWith("trabalhos_impressao/")), false);
});

test("produtor: evento repetido é idempotente; edição posterior não reimprime", async () => {
  const { db, docs } = bancoMemoria(ambienteFila());
  const primeiro = await produzirTrabalhoDoPedido({ db, FieldValue, Timestamp, pedidoId: "148204781", pedido: pedido(), agoraMs: 1000 });
  const repetido = await produzirTrabalhoDoPedido({ db, FieldValue, Timestamp, pedidoId: "148204781", pedido: pedido(), agoraMs: 1001 });
  const alterado = await produzirTrabalhoDoPedido({ db, FieldValue, Timestamp, pedidoId: "148204781",
    pedido: pedido({ nome_destinatario: "Nome corrigido" }), agoraMs: 1002 });
  assert.equal(primeiro.status, 201);
  assert.equal(repetido.corpo.duplicado, true);
  assert.equal(alterado.status, 409);
  assert.equal([...docs.keys()].filter((caminho) => caminho.startsWith("trabalhos_impressao/")).length, 1);
});
