const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizarDataVenda, dataOperacionalPedido } = require("../src/lib/util");
const {
  idEventoPedido,
  normalizarPedidoRecebido,
} = require("../src/webhooks/pedidos");

test("normaliza datas ISO e brasileiras recebidas do InstaDelivery", () => {
  assert.equal(normalizarDataVenda("2026-08-24 10:02:08"), "2026-08-24 10:02:08");
  assert.equal(normalizarDataVenda("2026-08-24T10:02"), "2026-08-24 10:02:00");
  assert.equal(normalizarDataVenda("24/08/2026 às 10:02:08"), "2026-08-24 10:02:08");
  assert.equal(normalizarDataVenda("24/08/2026 10:02"), "2026-08-24 10:02:00");
});

test("rejeita data inválida em vez de deixá-la invisível em consultas por período", () => {
  assert.equal(normalizarDataVenda("31/02/2026 às 10:02"), "");
  assert.equal(normalizarDataVenda("sem data"), "");
});

test("calcula a data operacional pelo agendamento, inclusive na virada do ano", () => {
  assert.equal(
    dataOperacionalPedido("2026-09-28 10:02:08", "Dia 03/10 - 14:20"),
    "2026-10-03"
  );
  assert.equal(
    dataOperacionalPedido("2026-12-28 10:02:08", "Dia 02/01 - 09:00"),
    "2027-01-02"
  );
  assert.equal(
    dataOperacionalPedido("2026-09-28 10:02:08", null),
    "2026-09-28"
  );
});

test("inbox usa ID estável para deduplicar os dois webhooks sem perder atualizações", () => {
  const a = { order_id: 123, status: 1, nome_destinatario: "Maria" };
  const mesmasChavesEmOutraOrdem = { nome_destinatario: "Maria", status: 1, order_id: 123 };
  const atualizado = { ...a, status: 2 };

  assert.equal(idEventoPedido(a), idEventoPedido(mesmasChavesEmOutraOrdem));
  assert.notEqual(idEventoPedido(a), idEventoPedido(atualizado));
});

test("normaliza status textual e grava data operacional antes do ACK", () => {
  const pedido = normalizarPedidoRecebido({
    order_id: "153000001",
    status: "2",
    data_venda: "28/09/2026 às 10:02:08",
    agendamento: "Dia 30/09 - 15:00",
  });
  assert.equal(pedido.status, 2);
  assert.equal(pedido.data_venda, "2026-09-28 10:02:08");
  assert.equal(pedido.data_operacional, "2026-09-30");
  assert.equal(pedido.origem, "instadelivery");
});

test("status inválido fica visível para conferência em vez de sumir da consulta", () => {
  const pedido = normalizarPedidoRecebido({
    order_id: "153000002",
    status: "recebido",
    data_venda: "2026-09-28 10:02:08",
  });
  assert.equal(pedido.status, 1);
  assert.equal(pedido.status_origem, "recebido");
});
