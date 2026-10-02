const test = require("node:test");
const assert = require("node:assert/strict");

const {
  dataISOValida,
  formatarDataISOEmFortaleza,
  somarDiasISO,
} = require("../src/cliente/agendamentoFritura");

test("valida datas ISO locais sem aceitar datas impossíveis", () => {
  assert.equal(dataISOValida("2026-07-29"), true);
  assert.equal(dataISOValida("2026-02-29"), false);
  assert.equal(dataISOValida("2026-13-01"), false);
  assert.equal(dataISOValida("29/07/2026"), false);
});

test("formata a data usando o fuso de Fortaleza", () => {
  assert.equal(
    formatarDataISOEmFortaleza(new Date("2026-07-30T01:30:00.000Z")),
    "2026-07-29"
  );
});

test("soma dias atravessando mês e ano", () => {
  assert.equal(somarDiasISO("2026-12-31", 1), "2027-01-01");
  assert.equal(somarDiasISO("2028-02-28", 1), "2028-02-29");
});
