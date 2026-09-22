const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizarDataVenda } = require("../src/lib/util");

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
