const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DURACAO_PAREAMENTO_MS, criarSegredoPareamento, separarCodigo, hashCodigo, hashesIguais,
  iniciarPareamento, resgatarPareamento, confirmarPareamento, revogarDispositivo,
  criarHandlerGestaoImpressao, criarHandlerResgatePareamento,
} = require("../src/impressao/pareamento");
const { validarTokenDispositivo } = require("../src/impressao/acessoDispositivo");

const APAGAR = Symbol("apagar");
function timestamp(ms) { return { toMillis: () => ms, toDate: () => new Date(ms) }; }
function bancoMemoria(inicial = {}) {
  const docs = new Map(Object.entries(inicial));
  const ref = (c, id) => ({ caminho: `${c}/${id}`, id, async get() { return snap(this); },
    async set(valor, opcoes = {}) { gravar(this, valor, opcoes.merge); } });
  const snap = (r) => ({ exists: docs.has(r.caminho), data: () => docs.get(r.caminho) });
  const aplicar = (r, valor, merge) => {
    const anterior = merge ? { ...(docs.get(r.caminho) || {}) } : {};
    for (const [chave, dado] of Object.entries(valor)) {
      if (dado === APAGAR) delete anterior[chave]; else anterior[chave] = dado;
    }
    docs.set(r.caminho, anterior);
  };
  const gravar = (r, v, merge) => aplicar(r, v, merge);
  const db = {
    collection(c) { return { doc: (id) => ref(c, id), orderBy() { return this; }, limit() { return this; },
      async get() { const prefixo = `${c}/`; return { docs: [...docs.entries()].filter(([k]) => k.startsWith(prefixo))
        .map(([k, v]) => ({ id: k.slice(prefixo.length), data: () => v })) }; } }; },
    async runTransaction(fn) {
      return fn({ get: async (r) => snap(r), create(r, v) { if (docs.has(r.caminho)) throw new Error("EXISTS"); aplicar(r, v); },
        update(r, v) { if (!docs.has(r.caminho)) throw new Error("NOT_FOUND"); aplicar(r, v, true); } });
    },
  };
  return { db, docs };
}
const FieldValue = { serverTimestamp: () => timestamp(100), delete: () => APAGAR };
const Timestamp = { fromMillis: timestamp };
const operador = { uid: "gestor-1", nome: "Gestor" };
const bytes = (n) => Buffer.alloc(n, 7);
function bytesSequenciais() { let valor = 0; return (n) => Buffer.alloc(n, ++valor); }

test("pareamento: segredo tem formato verificável e só o hash pode ser persistido", () => {
  const segredo = criarSegredoPareamento({ randomBytes: bytes });
  assert.match(segredo.id, /^par_[a-f0-9]{32}$/);
  assert.match(segredo.dispositivoUid, /^imp_[a-f0-9]{40}$/);
  assert.equal(separarCodigo(segredo.codigo).id, segredo.id);
  assert.equal(hashesIguais(segredo.codigoHash, hashCodigo(segredo.codigo)), true);
  assert.equal(hashesIguais(segredo.codigoHash, hashCodigo(`${segredo.codigo}x`)), false);
  assert.equal(separarCodigo("par_x.codigo"), null);
});

test("pareamento: resgate cria só o próprio dispositivo, confirma e apaga o hash", async () => {
  const { db, docs } = bancoMemoria();
  const inicio = await iniciarPareamento({ db, Timestamp, FieldValue, operador, nome: "PC do caixa", agoraMs: 1000, randomBytes: bytes });
  const codigo = inicio.corpo.codigoPareamento;
  const codigoIncorreto = `${codigo.slice(0, -1)}${codigo.endsWith("a") ? "b" : "a"}`;
  const par = separarCodigo(codigo).id;
  const gravado = docs.get(`_pareamentos_impressao/${par}`);
  assert.equal(JSON.stringify(gravado).includes(codigo), false);
  assert.equal(gravado.codigoHash, hashCodigo(codigo));
  assert.equal((await resgatarPareamento({ db, FieldValue, codigo: codigoIncorreto, agoraMs: 1001 })).status, 403);
  const resgate = await resgatarPareamento({ db, FieldValue, codigo, agoraMs: 1002 });
  assert.equal(resgate.status, 200);
  assert.equal(docs.get(`dispositivos_impressao/${inicio.corpo.dispositivoId}`).ativo, true);
  // Repetir antes da confirmação suporta uma resposta HTTP perdida, sem criar outro dispositivo.
  assert.equal((await resgatarPareamento({ db, FieldValue, codigo, agoraMs: 1003 })).dispositivoUid, resgate.dispositivoUid);
  assert.equal((await confirmarPareamento({ db, FieldValue, agoraMs: 1004,
    identidade: { uid: resgate.dispositivoUid, credencialVersao: 1, pareamentoId: par } })).status, 200);
  assert.equal(Object.hasOwn(docs.get(`_pareamentos_impressao/${par}`), "codigoHash"), false);
  assert.equal((await resgatarPareamento({ db, FieldValue, codigo, agoraMs: 1005 })).status, 403);
});

test("pareamento: expiração e a quinta tentativa errada não produzem dispositivo", async () => {
  const { db, docs } = bancoMemoria();
  const randomBytes = bytesSequenciais();
  const inicio = await iniciarPareamento({ db, Timestamp, FieldValue, operador, nome: "PC", agoraMs: 500, randomBytes });
  const codigo = inicio.corpo.codigoPareamento;
  assert.equal((await resgatarPareamento({ db, FieldValue, codigo, agoraMs: 500 + DURACAO_PAREAMENTO_MS })).status, 403);
  assert.equal(docs.has(`dispositivos_impressao/${inicio.corpo.dispositivoId}`), false);
  assert.equal(Object.hasOwn(docs.get(`_pareamentos_impressao/${separarCodigo(codigo).id}`), "codigoHash"), false);
  const outro = await iniciarPareamento({ db, Timestamp, FieldValue, operador, nome: "Outro PC", agoraMs: 900, randomBytes });
  const outroIncorreto = `${outro.corpo.codigoPareamento.slice(0, -1)}${outro.corpo.codigoPareamento.endsWith("a") ? "b" : "a"}`;
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    assert.equal((await resgatarPareamento({ db, FieldValue, codigo: outroIncorreto, agoraMs: 901 + tentativa })).status, 403);
  }
  assert.equal(Object.hasOwn(docs.get(`_pareamentos_impressao/${separarCodigo(outro.corpo.codigoPareamento).id}`), "codigoHash"), false);
});

test("pareamento: revogação bloqueia primeiro e registra pendência do Auth sem reativar", async () => {
  const id = "imp_aaaaaaaaaaaaaaaa";
  const { db, docs } = bancoMemoria({ [`dispositivos_impressao/${id}`]: { uid: id, ativo: true, credencialVersao: 4 } });
  const auth = { async revokeRefreshTokens() { throw new Error("indisponível"); } };
  const r = await revogarDispositivo({ db, FieldValue, auth, dispositivoId: id, operador });
  assert.equal(r.status, 202);
  assert.deepEqual(docs.get(`dispositivos_impressao/${id}`).ativo, false);
  assert.equal(docs.get(`dispositivos_impressao/${id}`).credencialVersao, 5);
  assert.equal(docs.get(`dispositivos_impressao/${id}`).revogacaoAuthPendente, true);
});

test("pareamento: confirmação exige ID token de dispositivo com o ID do pareamento", async () => {
  const auth = { async verifyIdToken() { return { uid: "imp_aaaaaaaaaaaaaaaa", tipo: "dispositivo_impressao", credencialVersao: 1,
    firebase: { sign_in_provider: "custom" } }; } };
  assert.equal((await validarTokenDispositivo({ authorization: "Bearer t", auth, exigirPareamento: true })).status, 403);
  auth.verifyIdToken = async () => ({ uid: "imp_aaaaaaaaaaaaaaaa", tipo: "dispositivo_impressao", credencialVersao: 1,
    pareamentoId: "par_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", firebase: { sign_in_provider: "custom" } });
  assert.equal((await validarTokenDispositivo({ authorization: "Bearer t", auth, exigirPareamento: true })).ok, true);
});

function resposta() { return { statusCode: null, corpo: null, headers: {}, set(k, v) { this.headers[k] = v; }, status(s) { this.statusCode = s; return this; }, json(v) { this.corpo = v; return this; } }; }
test("handlers: painel exige equipe e resgate nunca devolve detalhe interno", async () => {
  let transacoes = 0;
  const r1 = resposta();
  await criarHandlerGestaoImpressao({ db: { runTransaction() { transacoes += 1; } }, auth: {}, Timestamp, FieldValue,
    exigirEquipe: async () => null, exigirCapacidade: () => true })({ method: "POST", body: { action: "iniciarPareamento", nome: "PC" }, headers: {} }, r1);
  assert.equal(r1.statusCode, null); assert.equal(transacoes, 0);
  const r2 = resposta();
  await criarHandlerResgatePareamento({ db: { runTransaction() { throw new Error("codigo-privado"); } }, auth: {}, FieldValue })
    ({ method: "POST", body: { codigo: "par_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, headers: {} }, r2);
  assert.equal(r2.statusCode, 503); assert.equal(JSON.stringify(r2.corpo).includes("codigo-privado"), false);
});
