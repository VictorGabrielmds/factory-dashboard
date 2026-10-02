const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DURACAO_LEASE_MS, criarTrabalhoImpressao, validarComandoTrabalho, executarTrabalhoImpressao,
} = require("../src/impressao/trabalhos");

const APAGAR = Symbol("apagar");
function timestamp(ms) { return { toMillis: () => ms, toDate: () => new Date(ms) }; }
function bancoMemoria(inicial = {}) {
  const docs = new Map(Object.entries(inicial));
  const referencia = (colecao, id) => ({ caminho: `${colecao}/${id}`, id,
    async get() { return snapshot(this); } });
  const snapshot = (ref) => ({ id: ref.id, exists: docs.has(ref.caminho), data: () => docs.get(ref.caminho) });
  const gravar = (ref, valor, merge = false) => {
    const anterior = merge ? { ...(docs.get(ref.caminho) || {}) } : {};
    for (const [chave, dado] of Object.entries(valor)) {
      if (dado === APAGAR) delete anterior[chave]; else anterior[chave] = dado;
    }
    docs.set(ref.caminho, anterior);
  };
  return { docs, db: {
    collection(colecao) { return { doc: (id) => referencia(colecao, id) }; },
    async runTransaction(fn) {
      return fn({ get: async (ref) => snapshot(ref),
        create(ref, valor) { if (docs.has(ref.caminho)) throw new Error("EXISTS"); gravar(ref, valor); },
        update(ref, valor) { if (!docs.has(ref.caminho)) throw new Error("NOT_FOUND"); gravar(ref, valor, true); } });
    },
  } };
}
const FieldValue = { serverTimestamp: () => timestamp(100), delete: () => APAGAR };
const Timestamp = { fromMillis: timestamp };
const dispositivoA = "imp_aaaaaaaaaaaaaaaa";
const dispositivoB = "imp_bbbbbbbbbbbbbbbb";
const identidadeA = { uid: dispositivoA, credencialVersao: 1 };
const identidadeB = { uid: dispositivoB, credencialVersao: 1 };
const leaseA = "lease_11111111111111111111111111111111";
const leaseB = "lease_22222222222222222222222222222222";

function recibo(pedidoId = "148204781") {
  return { versao: 1, pedidoId, tipo: "delivery", nome: "Maria da Silva", horarioAgendado: "Hoje 14:00",
    pagamento: "PIX", pago: true, totalCentavos: 5350, observacoes: "Sem pimenta", segredoQueNaoPodeSair: "ignorar",
    entrega: { endereco: "Rua Um, 10", bairro: "Centro", contato: "999999999" },
    itens: [{ nome: "Coxinha", quantidade: 2, observacoes: "Quente" }] };
}
function baseAutorizada(extra = {}) {
  return {
    [`dispositivos_impressao/${dispositivoA}`]: { uid: dispositivoA, tipo: "impressao", ativo: true, credencialVersao: 1 },
    [`dispositivos_impressao/${dispositivoB}`]: { uid: dispositivoB, tipo: "impressao", ativo: true, credencialVersao: 1 },
    "configuracoes/impressao_api": { ativa: true, versao: 1 }, ...extra,
  };
}
async function novoTrabalho(db, opcoes = {}) {
  return criarTrabalhoImpressao({ db, FieldValue, Timestamp, pedidoId: "148204781", versaoFonte: "2026.09.09-1",
    dispositivoUid: dispositivoA, credencialVersao: 1, recibo: recibo(), agoraMs: 1000, ...opcoes });
}

test("trabalho: produtor é idempotente, projeta o recibo e não altera pedido", async () => {
  const { db, docs } = bancoMemoria({ "pedidos/148204781": { estado: "pronto", impresso: false } });
  const primeiro = await novoTrabalho(db);
  assert.equal(primeiro.status, 201);
  const segundo = await novoTrabalho(db);
  assert.deepEqual(segundo.corpo, { trabalhoId: primeiro.corpo.trabalhoId, duplicado: true });
  const job = docs.get(`trabalhos_impressao/${primeiro.corpo.trabalhoId}`);
  assert.equal(job.estado, "pendente");
  assert.equal(Object.hasOwn(job.recibo, "segredoQueNaoPodeSair"), false);
  assert.deepEqual(docs.get("pedidos/148204781"), { estado: "pronto", impresso: false });
  const conflito = await novoTrabalho(db, { dispositivoUid: dispositivoB });
  assert.equal(conflito.status, 409);
});

test("trabalho: comandos só aceitam contrato mínimo, sem texto livre", () => {
  assert.equal(validarComandoTrabalho({ action: "reivindicarTrabalho", trabalhoId: "trb_a".padEnd(44, "a"), leaseId: leaseA }), true);
  assert.equal(validarComandoTrabalho({ action: "reivindicarTrabalho", trabalhoId: "trb_a".padEnd(44, "a"), leaseId: leaseA, recibo: {} }), false);
  assert.equal(validarComandoTrabalho({ action: "registrarResultado", trabalhoId: "trb_a".padEnd(44, "a"),
    leaseId: leaseA, resultado: "aceito_transporte", codigoFalha: "NAO" }), false);
  assert.equal(validarComandoTrabalho({ action: "registrarResultado", trabalhoId: "trb_a".padEnd(44, "a"),
    leaseId: leaseA, resultado: "falha_definitiva", codigoFalha: "SEM_PAPEL", detalhes: "telefone" }), false);
});

test("trabalho: só o computador atribuído reivindica; a mesma lease suporta resposta perdida", async () => {
  const { db, docs } = bancoMemoria(baseAutorizada());
  const criado = await novoTrabalho(db);
  const dados = { action: "reivindicarTrabalho", trabalhoId: criado.corpo.trabalhoId, leaseId: leaseA };
  const outro = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeB, dados, agoraMs: 1100 });
  assert.equal(outro.status, 404);
  const primeiro = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA, dados, agoraMs: 1100 });
  assert.equal(primeiro.corpo.autorizacaoDeImpressao, true);
  assert.equal(primeiro.corpo.repetido, false);
  const job = docs.get(`trabalhos_impressao/${criado.corpo.trabalhoId}`);
  assert.equal(job.estado, "reivindicado");
  assert.equal(JSON.stringify(job).includes(leaseA), false);
  const repetido = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA, dados, agoraMs: 1101 });
  assert.equal(repetido.corpo.repetido, true);
  const leaseDiferente = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA,
    dados: { ...dados, leaseId: leaseB }, agoraMs: 1102 });
  assert.equal(leaseDiferente.status, 404);
  const expirado = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA, dados,
    agoraMs: 1100 + DURACAO_LEASE_MS });
  assert.equal(expirado.status, 409);
  assert.equal(docs.get(`trabalhos_impressao/${criado.corpo.trabalhoId}`).estado, "inconclusivo");
});

test("trabalho: resultado é terminal, idempotente e nunca altera o pedido", async () => {
  const { db, docs } = bancoMemoria(baseAutorizada({ "pedidos/148204781": { impresso: false, estado: "pronto" } }));
  const criado = await novoTrabalho(db);
  const reivindicar = { action: "reivindicarTrabalho", trabalhoId: criado.corpo.trabalhoId, leaseId: leaseA };
  await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA, dados: reivindicar, agoraMs: 1001 });
  const resultado = { action: "registrarResultado", trabalhoId: criado.corpo.trabalhoId, leaseId: leaseA, resultado: "aceito_transporte" };
  const primeiro = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA, dados: resultado, agoraMs: 1002 });
  assert.equal(primeiro.corpo.repetido, false);
  const repetido = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA, dados: resultado, agoraMs: 1003 });
  assert.equal(repetido.corpo.repetido, true);
  assert.equal(docs.get(`trabalhos_impressao/${criado.corpo.trabalhoId}`).estado, "aceito_transporte");
  assert.deepEqual(docs.get("pedidos/148204781"), { impresso: false, estado: "pronto" });
  const estranho = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA,
    dados: { ...resultado, leaseId: leaseB }, agoraMs: 1004 });
  assert.equal(estranho.status, 404);
  const comFalha = await novoTrabalho(db, { versaoFonte: "2026.09.09-2" });
  await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA,
    dados: { action: "reivindicarTrabalho", trabalhoId: comFalha.corpo.trabalhoId, leaseId: leaseB }, agoraMs: 1005 });
  await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA,
    dados: { action: "registrarResultado", trabalhoId: comFalha.corpo.trabalhoId, leaseId: leaseB,
      resultado: "falha_definitiva", codigoFalha: "SEM_PAPEL" }, agoraMs: 1006 });
  assert.deepEqual(docs.get(`trabalhos_impressao/${comFalha.corpo.trabalhoId}`).resultado,
    { tipo: "falha_definitiva", codigoFalha: "SEM_PAPEL" });
});

test("trabalho: revogação/configuração concorrente bloqueia antes de tocar no job", async () => {
  const { db, docs } = bancoMemoria(baseAutorizada({ "configuracoes/impressao_api": { ativa: false, versao: 1 } }));
  const criado = await novoTrabalho(db);
  const resultado = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: identidadeA,
    dados: { action: "reivindicarTrabalho", trabalhoId: criado.corpo.trabalhoId, leaseId: leaseA }, agoraMs: 1001 });
  assert.equal(resultado.status, 503);
  assert.equal(docs.get(`trabalhos_impressao/${criado.corpo.trabalhoId}`).estado, "pendente");
});
