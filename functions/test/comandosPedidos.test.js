const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STATUS_CANCELADO,
  normalizarIdPedido,
  devePreservarCancelamento,
  decidirCancelamento,
} = require("../src/services/comandosPedidos");

test("comando de pedido aceita somente um ID de documento simples", () => {
  assert.equal(normalizarIdPedido("148204781"), "148204781");
  assert.equal(normalizarIdPedido(" app_1-2 "), "app_1-2");
  assert.equal(normalizarIdPedido("pedidos/outro"), null);
  assert.equal(normalizarIdPedido(""), null);
  assert.equal(normalizarIdPedido("x".repeat(121)), null);
});

test("cancelamento é idempotente, protege o PIX e respeita a política do App Cliente", () => {
  assert.deepEqual(decidirCancelamento(null), {
    encontrado: false,
    deveAtualizar: false,
    jaCancelado: false,
    permitido: false,
    motivo: "PEDIDO_NAO_ENCONTRADO",
    pixConfirmado: false,
  });
  assert.deepEqual(decidirCancelamento({ origem: "app", status: 2, pix_confirmado: true }), {
    encontrado: true,
    deveAtualizar: true,
    jaCancelado: false,
    permitido: true,
    motivo: null,
    pixConfirmado: true,
  });
  assert.deepEqual(decidirCancelamento({ origem: "app", status: STATUS_CANCELADO, pix_status: "RECEIVED" }), {
    encontrado: true,
    deveAtualizar: false,
    jaCancelado: true,
    permitido: true,
    motivo: "PEDIDO_JA_CANCELADO",
    pixConfirmado: true,
  });
  assert.deepEqual(decidirCancelamento({ origem: "instadelivery", status: 2 }), {
    encontrado: true,
    deveAtualizar: false,
    jaCancelado: false,
    permitido: false,
    motivo: "ORIGEM_NAO_SUPORTADA",
    pixConfirmado: false,
  });
  assert.deepEqual(decidirCancelamento({ origem: "app", status: 5 }), {
    encontrado: true,
    deveAtualizar: false,
    jaCancelado: false,
    permitido: false,
    motivo: "STATUS_NAO_CANCELAVEL",
    pixConfirmado: false,
  });
});

test("webhook atrasado não ressuscita pedido cancelado", () => {
  assert.equal(devePreservarCancelamento(4, 2), true);
  assert.equal(devePreservarCancelamento(4, undefined), true);
  assert.equal(devePreservarCancelamento(4, 4), false);
  assert.equal(devePreservarCancelamento(2, 3), false);
});
