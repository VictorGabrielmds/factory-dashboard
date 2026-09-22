const test = require("node:test");
const assert = require("node:assert/strict");

const { autenticarEquipePainel, exigirPainel } = require("../src/lib/seguranca");

function bancoStaff(registro, { erro = null } = {}) {
  return {
    collection(nome) {
      assert.equal(nome, "staff");
      return {
        doc(uid) {
          return {
            async get() {
              if (erro) throw erro;
              return {
                exists: registro !== undefined,
                data: () => registro,
                uid,
              };
            },
          };
        },
      };
    },
  };
}

function authCom(resultado) {
  const chamadas = [];
  return {
    chamadas,
    async verifyIdToken(token, verificarRevogacao) {
      chamadas.push({ token, verificarRevogacao });
      if (resultado instanceof Error) throw resultado;
      return resultado;
    },
  };
}

test("painel exige Bearer para iniciar a autorização", async () => {
  const auth = authCom({ uid: "operador" });
  const resultado = await autenticarEquipePainel({
    authorization: undefined,
    auth,
    db: bancoStaff({ ativo: true }),
  });
  assert.deepEqual(resultado, { ok: false, status: 401, codigo: "SESSAO_NECESSARIA" });
  assert.equal(auth.chamadas.length, 0);
});

test("token inválido ou revogado é recusado sem consultar staff", async () => {
  const auth = authCom(new Error("revogado"));
  const resultado = await autenticarEquipePainel({
    authorization: "Bearer token-invalido",
    auth,
    db: bancoStaff({ ativo: true }),
  });
  assert.deepEqual(resultado, { ok: false, status: 401, codigo: "SESSAO_INVALIDA" });
  assert.deepEqual(auth.chamadas, [{ token: "token-invalido", verificarRevogacao: true }]);
});

test("cliente autenticado sem staff não acessa API administrativa", async () => {
  const resultado = await autenticarEquipePainel({
    authorization: "Bearer token-cliente",
    auth: authCom({ uid: "cliente" }),
    db: bancoStaff(undefined),
  });
  assert.deepEqual(resultado, { ok: false, status: 403, codigo: "ACESSO_EQUIPE_NEGADO" });
});

test("staff inativo perde acesso imediatamente", async () => {
  const resultado = await autenticarEquipePainel({
    authorization: "Bearer token-inativo",
    auth: authCom({ uid: "operador-inativo" }),
    db: bancoStaff({ ativo: false, papel: "gestor" }),
  });
  assert.deepEqual(resultado, { ok: false, status: 403, codigo: "ACESSO_EQUIPE_NEGADO" });
});

test("staff ativo retorna operador auditável", async () => {
  const resultado = await autenticarEquipePainel({
    authorization: "Bearer token-operador",
    auth: authCom({ uid: "operador", email: "op@fabrica.test", name: "Operador" }),
    db: bancoStaff({ ativo: true }),
  });
  assert.deepEqual(resultado, {
    ok: true,
    operador: {
      uid: "operador",
      email: "op@fabrica.test",
      nome: "Operador",
      papel: "operador_legado",
      papeis: ["operador_legado"],
      capacidades: ["*"],
      permissoesEstritas: false,
    },
  });
});

test("documento staff legado sem campo ativo continua autorizado durante a migração", async () => {
  const resultado = await autenticarEquipePainel({
    authorization: "Bearer token-legado",
    auth: authCom({ uid: "operador-legado" }),
    db: bancoStaff({}),
  });
  assert.deepEqual(resultado, {
    ok: true,
    operador: {
      uid: "operador-legado",
      email: null,
      nome: null,
      papel: "operador_legado",
      papeis: ["operador_legado"],
      capacidades: ["*"],
      permissoesEstritas: false,
    },
  });
});

test("middleware não confunde indisponibilidade do banco com acesso negado", async () => {
  const resposta = {
    statusCode: null,
    corpo: null,
    status(code) { this.statusCode = code; return this; },
    json(corpo) { this.corpo = corpo; },
  };
  const operador = await exigirPainel(
    { headers: { authorization: "Bearer token" } },
    resposta,
    { auth: authCom({ uid: "operador" }), db: bancoStaff(undefined, { erro: new Error("indisponível") }) }
  );
  assert.equal(operador, null);
  assert.equal(resposta.statusCode, 500);
  assert.equal(resposta.corpo.codigo, "AUTORIZACAO_INDISPONIVEL");
});
