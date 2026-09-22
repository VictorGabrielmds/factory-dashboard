const test = require("node:test");
const assert = require("node:assert/strict");

const {
  capacidadesDoStaff,
  montarOperadorPainel,
  avaliarCapacidade,
  exigirCapacidadePainel,
  exigirCapacidadeCriticaPainel,
} = require("../src/lib/permissoesPainel");

const usuario = { uid: "u-1", email: "op@fabrica.test", name: "Operador" };

test("gestor possui todas as capacidades sem depender do navegador", () => {
  const operador = montarOperadorPainel({ usuario, staff: { ativo: true, papel: "gestor" } });
  assert.deepEqual(operador.papeis, ["gestor"]);
  assert.equal(avaliarCapacidade(operador, "financeiro.confirmar_pix").autorizada, true);
  assert.equal(avaliarCapacidade(operador, "clientes.bloquear").modo, "permitida");
  assert.equal(avaliarCapacidade(operador, "impressao.parear").autorizada, true);
});

test("papéis podem ser acumulados e capacidades extras são explícitas", () => {
  const capacidades = capacidadesDoStaff({
    papeis: ["atendimento", "fiscal"],
    permissoes: ["clientes.bloquear", "CLIENTES.BLOQUEAR", 12],
  });
  assert.deepEqual(capacidades.sort(), [
    "chat.atender", "chat.ler", "clientes.bloquear", "clientes.consultar",
    "fiscal.cancelar", "fiscal.emitir", "fiscal.preparar", "pedidos.ler", "pedidos.operar", "rotas.operar",
  ].sort());
});

test("permissões explícitas usam uma allowlist e nunca aceitam curinga", () => {
  const capacidades = capacidadesDoStaff({
    permissoes: ["clientes.bloquear", "PEDIDOS.CANCELAR", "IMPRESSAO.PAREAR", "*", "inexistente.administrar"],
  });
  assert.deepEqual(capacidades.sort(), ["clientes.bloquear", "pedidos.cancelar", "impressao.parear"].sort());
});

test("perfil definido fica em observação até a migração ser ativada", () => {
  const operador = montarOperadorPainel({ usuario, staff: { ativo: true, papel: "atendimento" } });
  assert.deepEqual(avaliarCapacidade(operador, "financeiro.confirmar_pix"), {
    autorizada: true,
    modo: "observacao",
    capacidade: "financeiro.confirmar_pix",
    permitidaPorPerfil: false,
  });
});

test("perfil estrito não confirma PIX nem bloqueia cliente sem capacidade", () => {
  const operador = montarOperadorPainel({
    usuario,
    staff: { ativo: true, papel: "atendimento", permissoesEstritas: true },
  });
  assert.deepEqual(avaliarCapacidade(operador, "financeiro.confirmar_pix"), {
    autorizada: false,
    modo: "negada",
    capacidade: "financeiro.confirmar_pix",
    permitidaPorPerfil: false,
  });

  const resposta = {
    statusCode: null,
    corpo: null,
    status(code) { this.statusCode = code; return this; },
    json(corpo) { this.corpo = corpo; },
  };
  assert.equal(exigirCapacidadePainel(resposta, operador, "clientes.bloquear"), null);
  assert.equal(resposta.statusCode, 403);
  assert.equal(resposta.corpo.codigo, "ACAO_NAO_AUTORIZADA");
});

test("papel desconhecido não vira acesso legado quando a conta está em modo estrito", () => {
  const operador = montarOperadorPainel({
    usuario,
    staff: { ativo: true, papel: "gerente-geral", permissoesEstritas: true },
  });
  assert.equal(operador.papel, "sem_papel");
  assert.deepEqual(operador.capacidades, []);
  assert.equal(avaliarCapacidade(operador, "financeiro.confirmar_pix").autorizada, false);
});

test("operador_legado só existe para documento sem nenhuma configuração", () => {
  const configuracoesExplicitas = [
    { papel: "operador_legado" },
    { papeis: ["operador_legado"] },
    { permissoes: ["*"] },
  ];

  for (const staff of configuracoesExplicitas) {
    const operador = montarOperadorPainel({
      usuario,
      staff: { ativo: true, ...staff, permissoesEstritas: true },
    });
    assert.equal(operador.papel, "sem_papel");
    assert.deepEqual(operador.papeis, []);
    assert.deepEqual(operador.capacidades, []);
    assert.deepEqual(avaliarCapacidade(operador, "pedidos.cancelar"), {
      autorizada: false,
      modo: "negada",
      capacidade: "pedidos.cancelar",
      permitidaPorPerfil: false,
    });
  }
});

test("documento legado preserva operação durante a transição", () => {
  const operador = montarOperadorPainel({ usuario, staff: { ativo: true } });
  assert.equal(operador.papel, "operador_legado");
  assert.equal(avaliarCapacidade(operador, "financeiro.confirmar_pix").modo, "permitida");
});

test("pareamento não herda a permissão ampla de um documento legado", () => {
  const resposta = { statusCode: null, status(codigo) { this.statusCode = codigo; return this; }, json() {} };
  const legado = montarOperadorPainel({ usuario, staff: { ativo: true } });
  assert.equal(exigirCapacidadeCriticaPainel(resposta, legado, "impressao.parear"), null);
  assert.equal(resposta.statusCode, 403);
  const gestor = montarOperadorPainel({ usuario, staff: { ativo: true, papel: "gestor" } });
  assert.equal(exigirCapacidadeCriticaPainel(resposta, gestor, "impressao.parear").autorizada, true);
});
