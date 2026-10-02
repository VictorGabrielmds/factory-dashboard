const test = require("node:test");
const assert = require("node:assert/strict");
const { CONSULTA_LEVE, PREPARACAO_FISCAL } = require("../src/runtime/capacidade");
// Only constructs the SDK deployment descriptors. Does not invoke handlers,
// contact Firestore, fetch secrets or create an order/payment.
const funcoes = require("../index");

const consultas = ["consultarConfiguracoesGerais", "consultarOrdemCategorias",
  "consultarHorarioFuncionamento", "consultarTaxaEntrega", "listarBairrosEntrega"];

test("pareamento de impressão usa perfil econômico", () => {
  for (const nome of ["impressao", "resgatarPareamentoImpressao", "confirmarPareamentoImpressao"]) {
    const endpoint = funcoes[nome].__endpoint;
    assert.equal(endpoint.cpu, "gcf_gen1");
    assert.equal(endpoint.concurrency, 1);
    assert.equal(endpoint.maxInstances, 2);
    assert.equal(endpoint.minInstances, 0);
    assert.deepEqual(endpoint.region, ["southamerica-east1"]);
  }
  assert.equal(Object.hasOwn(funcoes, "consultaImpressao"), false);
  assert.equal(Object.hasOwn(funcoes, "criarHandlerConsultaImpressao"), false);
  assert.equal(Object.hasOwn(funcoes, "trabalhosImpressao"), false);
  assert.equal(Object.hasOwn(funcoes, "criarHandlerTrabalhosImpressao"), false);
  assert.equal(Object.hasOwn(funcoes, "produtorTrabalhosImpressao"), false);
  assert.equal(Object.hasOwn(funcoes, "criarGatilhoProdutorPedidos"), false);
});

test("APIs sem segredo declaram lista vazia para remover o vínculo legado no deploy", () => {
  for (const nome of ["clientes", "configuracoes", "pendencias"]) {
    assert.deepEqual(funcoes[nome].__endpoint.secretEnvironmentVariables, []);
  }
});

test("perfis de capacidade são imutáveis e não adicionam instâncias mínimas", () => {
  assert.ok(Object.isFrozen(CONSULTA_LEVE));
  assert.ok(Object.isFrozen(PREPARACAO_FISCAL));
  assert.equal(CONSULTA_LEVE.minInstances, 0);
  assert.equal(PREPARACAO_FISCAL.minInstances, 0);
  assert.equal(CONSULTA_LEVE.memory, "256MiB");
});
for (const nome of consultas) {
  test(`${nome}: perfil leve aparece no descritor real do Firebase`, () => {
    const endpoint = funcoes[nome].__endpoint;
    assert.equal(endpoint.cpu, "gcf_gen1");
    assert.equal(endpoint.concurrency, 1);
    assert.equal(endpoint.availableMemoryMb, 256);
    assert.equal(endpoint.minInstances, 0);
    assert.equal(endpoint.maxInstances, 4);
    assert.ok(endpoint.callableTrigger);
    assert.deepEqual(endpoint.region, ["southamerica-east1"]);
  });
}
test("preparação fiscal preserva o teto de três instâncias e emissão bloqueada", () => {
  const endpoint = funcoes.fiscal.__endpoint;
  assert.equal(endpoint.cpu, "gcf_gen1");
  assert.equal(endpoint.concurrency, 1);
  assert.equal(endpoint.maxInstances, 3);
  assert.equal(endpoint.minInstances, 0);
  assert.equal(require("../src/fiscal/modelo").EMISSAO_HABILITADA, false);
});
test("checkout e recuperação não recebem CPU fracionada nem redução de escala", () => {
  for (const nome of ["criarPedido", "consultarCheckoutPedido", "reconciliarCheckoutsPix"]) {
    // SDK ResetValue serializes to null, meaning the platform default.
    const endpoint = JSON.parse(JSON.stringify(funcoes[nome].__endpoint));
    assert.equal(endpoint.cpu ?? 1, 1, nome);
    assert.equal(endpoint.maxInstances, 10, nome);
    assert.equal(endpoint.concurrency ?? 80, 80, nome);
    assert.equal(endpoint.minInstances ?? 0, 0, nome);
  }
});
test("webhooks, PIX, mídia e login mantêm os recursos existentes", () => {
  for (const nome of ["webhookWhatsApp", "webhookAsaas", "webhookPedidos", "webhookPedidosBackup",
    "processarEventoMeta", "processarEventoAsaas", "processarEventoPedidoInsta",
    "reconciliarInboxPedidos", "processarOutbox", "notificarStatusPedido",
    "processarNotificacaoCancelamentoFila", "reconciliarNotificacoesPedido", "reconciliarPixAsaas",
    "solicitarLoginWhatsApp", "validarLoginWhatsApp", "chat", "conversas"]) {
    const endpoint = funcoes[nome].__endpoint;
    assert.equal(endpoint.cpu ?? 1, 1, nome);
    assert.equal(endpoint.maxInstances, 10, nome);
  }
  for (const nome of ["webhookWhatsApp", "webhookAsaas", "chat"]) {
    assert.equal(funcoes[nome].__endpoint.minInstances, 1, nome);
  }
});
test("perfil fracionado é opt-in: consultas, fiscal e pareamento", () => {
  const nomes = Object.entries(funcoes).filter(([, funcao]) => funcao.__endpoint?.cpu === "gcf_gen1").map(([nome]) => nome);
  assert.deepEqual(nomes.sort(), [...consultas, "fiscal", "impressao", "resgatarPareamentoImpressao", "confirmarPareamentoImpressao"].sort());
});
