// Pareamento do desktop: o código é temporário, de alta entropia e só fica
// armazenado como hash. Nenhuma conta de serviço é entregue ao computador.
const crypto = require("crypto");
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { ORIGENS_PAINEL } = require("../config");
const { exigirPainel } = require("../lib/seguranca");
const { exigirCapacidadeCriticaPainel } = require("../lib/permissoesPainel");
const { UID_DISPOSITIVO, ID_PAREAMENTO, validarTokenDispositivo } = require("./acessoDispositivo");

const COLECAO_PAREAMENTOS = "_pareamentos_impressao";
const DURACAO_PAREAMENTO_MS = 15 * 60 * 1000;
const MAX_TENTATIVAS_RESGATE = 5;
const CODIGO_PAREAMENTO = /^(par_[a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;

function textoCurto(valor, limite = 80) {
  if (typeof valor !== "string") return null;
  const texto = valor.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return texto && texto.length <= limite ? texto : null;
}
function hashCodigo(codigo) { return crypto.createHash("sha256").update(codigo, "utf8").digest("hex"); }
function hashesIguais(esperado, recebido) {
  if (typeof esperado !== "string" || !/^[a-f0-9]{64}$/.test(esperado)) return false;
  const a = Buffer.from(esperado, "hex"); const b = Buffer.from(recebido, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function criarSegredoPareamento({ randomBytes = crypto.randomBytes } = {}) {
  const id = `par_${randomBytes(16).toString("hex")}`;
  const dispositivoUid = `imp_${randomBytes(20).toString("hex")}`;
  const codigo = `${id}.${randomBytes(32).toString("base64url")}`;
  if (!ID_PAREAMENTO.test(id) || !UID_DISPOSITIVO.test(dispositivoUid) || !CODIGO_PAREAMENTO.test(codigo)) {
    throw new Error("ALEATORIEDADE_DE_PAREAMENTO_INVALIDA");
  }
  return { id, dispositivoUid, codigo, codigoHash: hashCodigo(codigo) };
}
function separarCodigo(codigo) {
  if (typeof codigo !== "string" || codigo.length > 128) return null;
  const match = CODIGO_PAREAMENTO.exec(codigo.trim());
  return match ? { id: match[1], codigo: codigo.trim() } : null;
}
function resultadoCodigoInvalido() { return { ok: false, status: 403, codigo: "CODIGO_DE_PAREAMENTO_INVALIDO" }; }
function serializarDispositivo(id, dados = {}) {
  const data = (valor) => valor?.toDate?.().toISOString?.() || null;
  return { id, nome: typeof dados.nome === "string" ? dados.nome : "Computador de impressão", ativo: dados.ativo === true,
    credencialVersao: Number.isSafeInteger(dados.credencialVersao) ? dados.credencialVersao : null,
    criadoEm: data(dados.criadoEm), pareadoEm: data(dados.pareadoEm), ultimaPresenca: data(dados.ultimaPresenca),
    versaoApp: typeof dados.versaoApp === "string" ? dados.versaoApp : null, revogadoEm: data(dados.revogadoEm) };
}

async function iniciarPareamento({ db, Timestamp, FieldValue, operador, nome, agoraMs = Date.now(), randomBytes }) {
  const nomeValido = textoCurto(nome);
  if (!nomeValido) return { ok: false, status: 400, codigo: "NOME_DISPOSITIVO_INVALIDO" };
  const segredo = criarSegredoPareamento({ randomBytes });
  const ref = db.collection(COLECAO_PAREAMENTOS).doc(segredo.id);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) throw new Error("COLISAO_DE_PAREAMENTO");
    tx.create(ref, { estado: "aguardando", codigoHash: segredo.codigoHash, dispositivoUid: segredo.dispositivoUid,
      credencialVersao: 1, nome: nomeValido, tentativas: 0, criadoPorUid: operador.uid,
      criadoPorNome: operador.nome || operador.email || null, criadoEm: FieldValue.serverTimestamp(),
      expiraEm: Timestamp.fromMillis(agoraMs + DURACAO_PAREAMENTO_MS) });
  });
  return { ok: true, status: 201, corpo: { dispositivoId: segredo.dispositivoUid, codigoPareamento: segredo.codigo,
    expiraEm: new Date(agoraMs + DURACAO_PAREAMENTO_MS).toISOString() } };
}

async function resgatarPareamento({ db, FieldValue, codigo, agoraMs = Date.now() }) {
  const recebido = separarCodigo(codigo); if (!recebido) return resultadoCodigoInvalido();
  const ref = db.collection(COLECAO_PAREAMENTOS).doc(recebido.id);
  return db.runTransaction(async (tx) => {
    const pareamento = await tx.get(ref);
    if (!pareamento.exists) return resultadoCodigoInvalido();
    const dados = pareamento.data();
    const expirou = !(dados.expiraEm?.toMillis?.() > agoraMs);
    const tentativas = Number.isSafeInteger(dados.tentativas) && dados.tentativas >= 0 ? dados.tentativas : 0;
    const hashValido = hashesIguais(dados.codigoHash, hashCodigo(recebido.codigo));
    const valido = !expirou && ["aguardando", "aguardando_confirmacao"].includes(dados.estado) &&
      tentativas < MAX_TENTATIVAS_RESGATE && hashValido;
    if (!valido) {
      // O quinto erro já encerra o código; não esperar uma sexta chamada para
      // eliminar o hash que não será mais aceito.
      if (expirou || tentativas >= MAX_TENTATIVAS_RESGATE || (!hashValido && tentativas + 1 >= MAX_TENTATIVAS_RESGATE)) {
        tx.update(ref, { estado: "expirado", codigoHash: FieldValue.delete(), expiradoEm: FieldValue.serverTimestamp() });
      } else tx.update(ref, { tentativas: tentativas + 1, ultimaTentativaEm: FieldValue.serverTimestamp() });
      return resultadoCodigoInvalido();
    }
    const dispositivoRef = db.collection("dispositivos_impressao").doc(dados.dispositivoUid);
    const [dispositivo, staff] = await Promise.all([
      tx.get(dispositivoRef), tx.get(db.collection("staff").doc(dados.dispositivoUid)),
    ]);
    // Mesmo em uma colisão improvável, uma identidade de desktop jamais pode
    // compartilhar UID com alguém da equipe.
    if (staff.exists) return resultadoCodigoInvalido();
    if (dados.estado === "aguardando") {
      if (dispositivo.exists) return resultadoCodigoInvalido();
      tx.create(dispositivoRef, { uid: dados.dispositivoUid, tipo: "impressao", ativo: true,
        credencialVersao: dados.credencialVersao, pareamentoId: pareamento.id, nome: dados.nome,
        criadoEm: FieldValue.serverTimestamp() });
      tx.update(ref, { estado: "aguardando_confirmacao", resgatadoEm: FieldValue.serverTimestamp() });
    } else if (!dispositivo.exists || dispositivo.data()?.ativo !== true ||
      dispositivo.data()?.credencialVersao !== dados.credencialVersao || dispositivo.data()?.pareamentoId !== pareamento.id) return resultadoCodigoInvalido();
    return { ok: true, status: 200, dispositivoUid: dados.dispositivoUid,
      credencialVersao: dados.credencialVersao, pareamentoId: pareamento.id };
  });
}

async function confirmarPareamento({ db, FieldValue, identidade, agoraMs = Date.now() }) {
  const pareamentoRef = db.collection(COLECAO_PAREAMENTOS).doc(identidade.pareamentoId);
  const dispositivoRef = db.collection("dispositivos_impressao").doc(identidade.uid);
  return db.runTransaction(async (tx) => {
    const [pareamento, dispositivo, staff] = await Promise.all([
      tx.get(pareamentoRef), tx.get(dispositivoRef), tx.get(db.collection("staff").doc(identidade.uid)),
    ]);
    const dados = pareamento.data();
    if (!pareamento.exists || !dispositivo.exists || dados.estado !== "aguardando_confirmacao" ||
      !(dados.expiraEm?.toMillis?.() > agoraMs) || dados.dispositivoUid !== identidade.uid ||
      dados.credencialVersao !== identidade.credencialVersao || dispositivo.data()?.pareamentoId !== pareamento.id ||
      dispositivo.data()?.ativo !== true || dispositivo.data()?.credencialVersao !== identidade.credencialVersao || staff.exists) return resultadoCodigoInvalido();
    tx.update(pareamentoRef, { estado: "confirmado", codigoHash: FieldValue.delete(), confirmadoEm: FieldValue.serverTimestamp() });
    tx.update(dispositivoRef, { pareadoEm: FieldValue.serverTimestamp() });
    return { ok: true, status: 200, corpo: { confirmado: true } };
  });
}

async function revogarDispositivo({ db, FieldValue, auth, dispositivoId, operador }) {
  if (!UID_DISPOSITIVO.test(dispositivoId || "")) return { ok: false, status: 400, codigo: "DISPOSITIVO_INVALIDO" };
  const ref = db.collection("dispositivos_impressao").doc(dispositivoId);
  const alterado = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); if (!snap.exists) return null;
    const dados = snap.data(); const proximaVersao = Math.max(1, Number.isSafeInteger(dados.credencialVersao) ? dados.credencialVersao + 1 : 1);
    tx.update(ref, { ativo: false, credencialVersao: proximaVersao, revogadoEm: FieldValue.serverTimestamp(),
      revogadoPorUid: operador.uid, revogadoPorNome: operador.nome || operador.email || null });
    return { uid: snap.id, jaEstavaInativo: dados.ativo !== true };
  });
  if (!alterado) return { ok: false, status: 404, codigo: "DISPOSITIVO_NAO_ENCONTRADO" };
  try {
    await auth.revokeRefreshTokens(alterado.uid);
    return { ok: true, status: 200, corpo: { revogado: true, jaEstavaInativo: alterado.jaEstavaInativo } };
  } catch (_) {
    // A doc já bloqueia a API; a pendência permite repetir a revogação do Auth.
    await ref.set({ revogacaoAuthPendente: true, ultimaFalhaRevogacaoEm: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true, status: 202, corpo: { revogado: true, jaEstavaInativo: alterado.jaEstavaInativo, revogacaoAuthPendente: true } };
  }
}
async function listarDispositivos({ db }) {
  const snap = await db.collection("dispositivos_impressao").orderBy("criadoEm", "desc").limit(50).get();
  return { ok: true, status: 200, corpo: { dispositivos: snap.docs.map((doc) => serializarDispositivo(doc.id, doc.data())) } };
}
function resposta(res, status, corpo) { return res.status(status).json(corpo); }
function corpoValido(body, campos) { return body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((campo) => campos.includes(campo)); }

function dadosGestaoValidos(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const camposPorAcao = { iniciarPareamento: ["action", "nome"], listarDispositivos: ["action"], revogarDispositivo: ["action", "dispositivoId"] };
  const campos = camposPorAcao[body.action];
  return !!campos && Object.keys(body).length === campos.length && Object.keys(body).every((campo) => campos.includes(campo));
}
function criarHandlerGestaoImpressao({ db, auth, Timestamp, FieldValue, exigirEquipe = exigirPainel, exigirCapacidade = exigirCapacidadeCriticaPainel }) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store"); res.set("X-Content-Type-Options", "nosniff");
    if (req.method !== "POST") return resposta(res, 405, { codigo: "METODO_NAO_PERMITIDO" });
    if (req.rawBody?.length > 4096 || !dadosGestaoValidos(req.body)) return resposta(res, 400, { codigo: "REQUISICAO_INVALIDA" });
    const operador = await exigirEquipe(req, res, { db, auth }); if (!operador) return;
    if (!exigirCapacidade(res, operador, "impressao.parear")) return;
    try {
      let resultado;
      if (req.body.action === "iniciarPareamento") resultado = await iniciarPareamento({ db, Timestamp, FieldValue, operador, nome: req.body.nome });
      else if (req.body.action === "listarDispositivos") resultado = await listarDispositivos({ db });
      else if (req.body.action === "revogarDispositivo") resultado = await revogarDispositivo({ db, FieldValue, auth, dispositivoId: req.body.dispositivoId, operador });
      else return resposta(res, 400, { codigo: "ACAO_INVALIDA" });
      return resposta(res, resultado.status, resultado.ok ? resultado.corpo : { codigo: resultado.codigo });
    } catch (_) { return resposta(res, 503, { codigo: "IMPRESSAO_TEMPORARIAMENTE_INDISPONIVEL" }); }
  };
}
function criarHandlerResgatePareamento({ db, auth, FieldValue }) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store"); res.set("X-Content-Type-Options", "nosniff");
    if (req.method !== "POST") return resposta(res, 405, { codigo: "METODO_NAO_PERMITIDO" });
    if (req.rawBody?.length > 1024 || !corpoValido(req.body, ["codigo"]) || Object.keys(req.body).length !== 1) return resposta(res, 400, { codigo: "REQUISICAO_INVALIDA" });
    try {
      const resgate = await resgatarPareamento({ db, FieldValue, codigo: req.body.codigo });
      if (!resgate.ok) return resposta(res, resgate.status, { codigo: resgate.codigo });
      // Reemite somente até confirmar: evita travar se a resposta se perder.
      const customToken = await auth.createCustomToken(resgate.dispositivoUid, { tipo: "dispositivo_impressao",
        credencialVersao: resgate.credencialVersao, pareamentoId: resgate.pareamentoId });
      return resposta(res, 200, { customToken });
    } catch (_) { return resposta(res, 503, { codigo: "IMPRESSAO_TEMPORARIAMENTE_INDISPONIVEL" }); }
  };
}
function criarHandlerConfirmacaoPareamento({ db, auth, FieldValue }) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store"); res.set("X-Content-Type-Options", "nosniff");
    if (req.method !== "POST" || req.rawBody?.length > 256 || !corpoValido(req.body, []) || Object.keys(req.body).length) return resposta(res, 400, { codigo: "REQUISICAO_INVALIDA" });
    const sessao = await validarTokenDispositivo({ authorization: req.headers?.authorization, auth, exigirPareamento: true });
    if (!sessao.ok) return resposta(res, sessao.status, { codigo: sessao.codigo });
    try { const resultado = await confirmarPareamento({ db, FieldValue, identidade: sessao.identidade });
      return resposta(res, resultado.status, resultado.ok ? resultado.corpo : { codigo: resultado.codigo });
    } catch (_) { return resposta(res, 503, { codigo: "IMPRESSAO_TEMPORARIAMENTE_INDISPONIVEL" }); }
  };
}

const opcoes = { region: "southamerica-east1", cors: ORIGENS_PAINEL, memory: "256MiB", cpu: "gcf_gen1", concurrency: 1, minInstances: 0, maxInstances: 2, timeoutSeconds: 20 };
const deps = () => ({ db: admin.firestore(), auth: admin.auth(), Timestamp: admin.firestore.Timestamp, FieldValue: admin.firestore.FieldValue });
const impressao = onRequest(opcoes, (req, res) => criarHandlerGestaoImpressao(deps())(req, res));
const resgatarPareamentoImpressao = onRequest(opcoes, (req, res) => criarHandlerResgatePareamento(deps())(req, res));
const confirmarPareamentoImpressao = onRequest(opcoes, (req, res) => criarHandlerConfirmacaoPareamento(deps())(req, res));

module.exports = { COLECAO_PAREAMENTOS, DURACAO_PAREAMENTO_MS, criarSegredoPareamento, separarCodigo, hashCodigo, hashesIguais,
  iniciarPareamento, resgatarPareamento, confirmarPareamento, revogarDispositivo, listarDispositivos, dadosGestaoValidos,
  criarHandlerGestaoImpressao, criarHandlerResgatePareamento, criarHandlerConfirmacaoPareamento,
  impressao, resgatarPareamentoImpressao, confirmarPareamentoImpressao };
