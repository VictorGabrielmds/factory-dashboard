const test = require("node:test");
const assert = require("node:assert/strict");
const { autenticarDispositivo, autorizarCadastro } = require("../src/impressao/acessoDispositivo");
const { validarComando, projetarRecibo, criarHandlerConsultaImpressao } = require("../src/impressao/consultaRestrita");
const uid = "imp_dispositivo_teste_01";
const identidade = { uid, credencialVersao: 1 };
const tokenValido = { ...identidade, tipo: "dispositivo_impressao", firebase: { sign_in_provider: "custom" } };
const dispositivo = { ...identidade, ativo: true, tipo: "impressao" };
const configuracao = { ativa: true, versao: 1 };

function dependencias({ token = tokenValido, cadastro = dispositivo, config = configuracao, staff = false, erroAuth, erroBanco } = {}) {
  const chamadas = [];
  const registros = { [`dispositivos_impressao/${uid}`]: cadastro, "configuracoes/impressao_api": config,
    [`staff/${uid}`]: staff ? { ativo: true } : undefined };
  return { chamadas, auth: { async verifyIdToken(t, revogacao) {
    chamadas.push([t, revogacao]);
    if (erroAuth) throw erroAuth;
    return token;
  } }, db: { collection(c) { return { doc(d) { return { async get() {
    if (erroBanco) throw erroBanco;
    const dado = registros[`${c}/${d}`];
    return { exists: dado !== undefined, data: () => dado };
  } }; } }; } } };
}

test("dispositivo: exige Bearer e verificação real de revogação", async () => {
  const deps = dependencias();
  assert.equal((await autenticarDispositivo({ ...deps })).status, 401);
  assert.equal(deps.chamadas.length, 0);
  assert.equal((await autenticarDispositivo({ ...deps, authorization: "Bearer token-teste" })).ok, true);
  assert.deepEqual(deps.chamadas, [["token-teste", true]]);
});
test("dispositivo: token expirado/revogado é negado; indisponibilidade não vira permissão", async () => {
  for (const code of ["auth/id-token-expired", "auth/id-token-revoked", "auth/invalid-id-token"]) {
    const r = await autenticarDispositivo({ ...dependencias({ erroAuth: { code } }), authorization: "Bearer teste" });
    assert.equal(r.status, 401);
  }
  assert.equal((await autenticarDispositivo({ ...dependencias({ erroAuth: new Error("interno") }), authorization: "Bearer teste" })).status, 503);
});
test("dispositivo: token de cliente/operador, versão adulterada e provedor comum são negados", async () => {
  for (const token of [{ uid: "cliente" }, { uid: "gestor", admin: true }, { ...tokenValido, credencialVersao: "1" },
    { ...tokenValido, firebase: { sign_in_provider: "anonymous" } }, { ...tokenValido, uid: "../outro" }]) {
    assert.equal((await autenticarDispositivo({ ...dependencias({ token }), authorization: "Bearer teste" })).status, 403);
  }
});
test("dispositivo: legado sem ativo, desativado, rotação ou cadastro ausente não autoriza", async () => {
  for (const cadastro of [null, {}, { ...dispositivo, ativo: false }, { ...dispositivo, ativo: undefined },
    { ...dispositivo, credencialVersao: 2 }, { ...dispositivo, uid: "outro" }]) {
    assert.equal((await autenticarDispositivo({ ...dependencias({ cadastro }), authorization: "Bearer teste" })).status, 403);
  }
});
test("dispositivo: staff mesmo com claim de dispositivo é negado; indisponibilidade do banco é segura", async () => {
  assert.equal((await autenticarDispositivo({ ...dependencias({ staff: true }), authorization: "Bearer teste" })).status, 403);
  assert.equal((await autenticarDispositivo({ ...dependencias({ erroBanco: new Error("segredo-interno") }), authorization: "Bearer teste" })).status, 503);
});
test("dispositivo: ativação explícita é obrigatória", () => {
  for (const configuracao of [undefined, {}, { ativa: false, versao: 1 }, { ativa: true, versao: 2 }]) {
    assert.equal(autorizarCadastro({ identidade, dispositivo, configuracao, staffExiste: false }).status, 503);
  }
});
test("dispositivo: cliente não pode indicar dono, status, recibo ou caminho arbitrário", () => {
  assert.equal(validarComando({ action: "consultarTrabalho", trabalhoId: "job-1" }), true);
  for (const body of [null, [], { action: "marcarImpresso" }, { action: "consultarTrabalho", trabalhoId: "../job" },
    { action: "consultarTrabalho", trabalhoId: "job", dispositivoUid: uid },
    { action: "registrarPresenca", versaoApp: "1.2.4", ativo: true },
    { action: "registrarPresenca", versaoApp: "segredo" }]) assert.equal(validarComando(body), false);
});
function recibo() {
  return { versao: 1, pedidoId: "pedido-1", tipo: "retirada", nome: "Cliente teste", horarioAgendado: "10/09 às 10:30",
    pagamento: "PIX", pago: true, totalCentavos: 1000, itens: [{ nome: "Bolinha", quantidade: 10 }] };
}
test("recibo: devolve só campos permitidos e remove controles de impressora", () => {
  const r = projetarRecibo({ ...recibo(), cpf: "privado", clienteUid: "privado", asaasPaymentId: "privado", token: "privado",
    nome: "Cliente\u001b@", entrega: { endereco: "não necessário na retirada" },
    itens: [{ nome: "Bolinha", quantidade: 10, custo: 999, codigoFiscal: "privado" }] });
  assert.equal(JSON.stringify(r).includes("privado"), false);
  assert.equal(r.nome.includes("\u001b"), false);
  assert.equal(Object.hasOwn(r, "entrega"), false);
});
test("recibo: sem horário, itens excessivos, dados inválidos e strings grandes falham", () => {
  for (const r of [{ ...recibo(), horarioAgendado: undefined }, { ...recibo(), itens: [] },
    { ...recibo(), itens: Array(101).fill({ nome: "a", quantidade: 1 }) },
    { ...recibo(), totalCentavos: 1.5 }, { ...recibo(), pago: "true" },
    { ...recibo(), nome: "a".repeat(161) }, { ...recibo(), tipo: "delivery" }]) assert.throws(() => projetarRecibo(r), /RECIBO_INVALIDO/);
});
test("recibo: endereço de entrega só recebe campos operacionais explícitos", () => {
  const r = projetarRecibo({ ...recibo(), tipo: "delivery", entrega: { endereco: "Rua de teste", bairro: "Centro",
    contato: "00000000000", geoponto: "privado", cpf: "privado" } });
  assert.equal(r.entrega.endereco, "Rua de teste");
  assert.equal(JSON.stringify(r).includes("privado"), false);
});
test("handler em preparação: sem sessão não chama transação e não expõe dados", async () => {
  const deps = dependencias();
  deps.db.runTransaction = () => { throw new Error("Não deveria executar"); };
  const resposta = { headers: {}, set(k, v) { this.headers[k] = v; }, status(s) { this.statusCode = s; return this; }, json(v) { this.body = v; return this; } };
  await criarHandlerConsultaImpressao({ ...deps, FieldValue: {} })({ method: "POST", headers: {}, body: { action: "consultarTrabalho", trabalhoId: "job" } }, resposta);
  assert.equal(resposta.statusCode, 401);
  assert.equal(resposta.headers["Cache-Control"], "no-store");
  assert.deepEqual(resposta.body, { codigo: "SESSAO_DISPOSITIVO_NECESSARIA" });
});
test("handler em preparação: indisponibilidade retorna erro genérico sem detalhe privado", async () => {
  const deps = dependencias();
  deps.db.runTransaction = async () => { throw new Error("token-privado"); };
  const res = { set() {}, status(s) { this.s = s; return this; }, json(v) { this.body = v; return this; } };
  await criarHandlerConsultaImpressao({ ...deps, FieldValue: {} })({ method: "POST", headers: { authorization: "Bearer teste" },
    body: { action: "consultarTrabalho", trabalhoId: "job" } }, res);
  assert.equal(res.s, 503);
  assert.equal(JSON.stringify(res.body).includes("token-privado"), false);
});
