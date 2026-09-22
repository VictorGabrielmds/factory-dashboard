// Ciclo conservador de trabalhos de impressão. Este módulo ainda não é
// exportado como Cloud Function: ele será ligado ao desktop somente depois do
// piloto de pareamento. O backend nunca reimprime automaticamente um trabalho.
const crypto = require("crypto");
const { autenticarDispositivo, autorizarCadastro, COLECAO_DISPOSITIVOS, UID_DISPOSITIVO } = require("./acessoDispositivo");
const { COLECAO_TRABALHOS, projetarRecibo } = require("./consultaRestrita");

const ID_PEDIDO = /^[A-Za-z0-9_-]{1,128}$/;
const ID_LEASE = /^lease_[a-f0-9]{32}$/;
const VERSAO_FONTE = /^[A-Za-z0-9._:-]{1,160}$/;
const DURACAO_LEASE_MS = 2 * 60 * 1000;
const DURACAO_TRABALHO_MS = 30 * 60 * 1000;
const RESULTADOS = new Set(["aceito_transporte", "falha_definitiva", "inconclusivo"]);
const CODIGO_FALHA = /^[A-Z][A-Z0-9_]{0,63}$/;

function hash(valor) { return crypto.createHash("sha256").update(valor, "utf8").digest("hex"); }
function idTrabalhoDeterministico(pedidoId, versaoFonte) {
  if (!ID_PEDIDO.test(pedidoId || "") || !VERSAO_FONTE.test(versaoFonte || "")) throw new Error("TRABALHO_INVALIDO");
  return `trb_${hash(`${pedidoId}\n${versaoFonte}`).slice(0, 40)}`;
}
function mesmaIdentidadeTrabalho(atual, esperado) {
  return atual?.pedidoId === esperado.pedidoId && atual?.versaoFonte === esperado.versaoFonte &&
    atual?.reciboHash === esperado.reciboHash && atual?.dispositivoUid === esperado.dispositivoUid &&
    atual?.credencialVersao === esperado.credencialVersao;
}
function indisponivel() { return { ok: false, status: 404, codigo: "TRABALHO_INDISPONIVEL" }; }
function dataMs(data) { return data?.toMillis?.() || 0; }

// Só código de servidor confiável chama esta função. Ela não toca em /pedidos
// nem em campos legados como `impresso`: aceitação de bytes não prova papel.
async function criarTrabalhoImpressao({ db, FieldValue, Timestamp, pedidoId, versaoFonte, dispositivoUid,
  credencialVersao, recibo, agoraMs = Date.now(), duracaoMs = DURACAO_TRABALHO_MS }) {
  if (!UID_DISPOSITIVO.test(dispositivoUid || "") || !Number.isSafeInteger(credencialVersao) || credencialVersao < 1 ||
      !Number.isSafeInteger(duracaoMs) || duracaoMs < 60000 || duracaoMs > 2 * 60 * 60 * 1000) {
    throw new Error("TRABALHO_INVALIDO");
  }
  const reciboSeguro = projetarRecibo(recibo);
  if (reciboSeguro.pedidoId !== pedidoId) throw new Error("TRABALHO_INVALIDO");
  const id = idTrabalhoDeterministico(pedidoId, versaoFonte);
  const esperado = { pedidoId, versaoFonte, dispositivoUid, credencialVersao,
    reciboHash: hash(JSON.stringify(reciboSeguro)) };
  const ref = db.collection(COLECAO_TRABALHOS).doc(id);
  return db.runTransaction(async (tx) => {
    const existente = await tx.get(ref);
    if (existente.exists) {
      return mesmaIdentidadeTrabalho(existente.data(), esperado)
        ? { ok: true, status: 200, corpo: { trabalhoId: id, duplicado: true } }
        : { ok: false, status: 409, codigo: "CONTRATO_DE_IMPRESSAO_CONFLITANTE" };
    }
    tx.create(ref, { ...esperado, estado: "pendente", recibo: reciboSeguro, tentativasReivindicacao: 0,
      criadoEm: FieldValue.serverTimestamp(), expiraEm: Timestamp.fromMillis(agoraMs + duracaoMs) });
    return { ok: true, status: 201, corpo: { trabalhoId: id, duplicado: false } };
  });
}

function validarComandoTrabalho(dados) {
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return false;
  const comum = typeof dados.trabalhoId === "string" && /^trb_[a-f0-9]{40}$/.test(dados.trabalhoId) &&
    typeof dados.leaseId === "string" && ID_LEASE.test(dados.leaseId);
  if (!comum) return false;
  if (dados.action === "reivindicarTrabalho") {
    return Object.keys(dados).every((chave) => ["action", "trabalhoId", "leaseId"].includes(chave));
  }
  if (dados.action !== "registrarResultado") return false;
  if (!Object.keys(dados).every((chave) => ["action", "trabalhoId", "leaseId", "resultado", "codigoFalha"].includes(chave)) ||
      !RESULTADOS.has(dados.resultado)) return false;
  if (dados.resultado === "aceito_transporte") return dados.codigoFalha === undefined;
  return typeof dados.codigoFalha === "string" && CODIGO_FALHA.test(dados.codigoFalha);
}

function validarDono(job, identidade) {
  return job?.dispositivoUid === identidade.uid && job?.credencialVersao === identidade.credencialVersao;
}
function resultadoFinalIgual(job, leaseHash, dados) {
  return ["aceito_transporte", "falha_definitiva", "inconclusivo"].includes(job?.estado) &&
    job?.leaseHash === leaseHash && job?.resultado?.tipo === dados.resultado &&
    (job?.resultado?.codigoFalha || undefined) === dados.codigoFalha;
}
function registroResultado(dados) {
  return { tipo: dados.resultado, ...(dados.codigoFalha ? { codigoFalha: dados.codigoFalha } : {}) };
}

async function revalidarDispositivo(tx, db, identidade) {
  const [cadastro, staff, config] = await Promise.all([
    tx.get(db.collection(COLECAO_DISPOSITIVOS).doc(identidade.uid)),
    tx.get(db.collection("staff").doc(identidade.uid)),
    tx.get(db.collection("configuracoes").doc("impressao_api")),
  ]);
  return autorizarCadastro({ identidade, dispositivo: cadastro.data(), staffExiste: staff.exists, configuracao: config.data() });
}

async function executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade, dados, agoraMs = Date.now(),
  duracaoLeaseMs = DURACAO_LEASE_MS }) {
  const leaseHash = hash(dados.leaseId);
  const refTrabalho = db.collection(COLECAO_TRABALHOS).doc(dados.trabalhoId);
  return db.runTransaction(async (tx) => {
    const acesso = await revalidarDispositivo(tx, db, identidade);
    if (!acesso.ok) return acesso;
    const snap = await tx.get(refTrabalho);
    const job = snap.data();
    if (!snap.exists || !validarDono(job, identidade)) return indisponivel();

    if (dados.action === "reivindicarTrabalho") {
      if (job.estado === "reivindicado") {
        if (job.leaseHash !== leaseHash) return indisponivel();
        if (dataMs(job.leaseExpiraEm) <= agoraMs) {
          tx.update(refTrabalho, { estado: "inconclusivo", resultado: { tipo: "inconclusivo", codigoFalha: "LEASE_EXPIRADA" },
            finalizadoEm: FieldValue.serverTimestamp() });
          return { ok: false, status: 409, codigo: "TRABALHO_INCONCLUSIVO" };
        }
        try {
          return { ok: true, status: 200, corpo: { trabalhoId: snap.id, recibo: projetarRecibo(job.recibo),
            autorizacaoDeImpressao: true, leaseExpiraEm: job.leaseExpiraEm.toDate().toISOString(), repetido: true } };
        } catch { return { ok: false, status: 409, codigo: "RECIBO_INDISPONIVEL" }; }
      }
      if (job.estado !== "pendente") return indisponivel();
      if (dataMs(job.expiraEm) <= agoraMs) {
        tx.update(refTrabalho, { estado: "expirado", finalizadoEm: FieldValue.serverTimestamp() });
        return indisponivel();
      }
      try {
        const recibo = projetarRecibo(job.recibo);
        const leaseExpiraEm = Timestamp.fromMillis(agoraMs + duracaoLeaseMs);
        tx.update(refTrabalho, { estado: "reivindicado", leaseHash, leaseExpiraEm,
          reivindicadoEm: FieldValue.serverTimestamp(), tentativasReivindicacao: (job.tentativasReivindicacao || 0) + 1 });
        return { ok: true, status: 200, corpo: { trabalhoId: snap.id, recibo, autorizacaoDeImpressao: true,
          leaseExpiraEm: new Date(agoraMs + duracaoLeaseMs).toISOString(), repetido: false } };
      } catch { return { ok: false, status: 409, codigo: "RECIBO_INDISPONIVEL" }; }
    }

    // Um retry da própria chamada de resultado, após resposta perdida, é seguro
    // e não recoloca o trabalho na fila.
    if (resultadoFinalIgual(job, leaseHash, dados)) {
      return { ok: true, status: 200, corpo: { trabalhoId: snap.id, registrado: true, repetido: true } };
    }
    if (job.estado !== "reivindicado" || job.leaseHash !== leaseHash) return indisponivel();
    if (dataMs(job.leaseExpiraEm) <= agoraMs) {
      tx.update(refTrabalho, { estado: "inconclusivo", resultado: { tipo: "inconclusivo", codigoFalha: "LEASE_EXPIRADA" },
        finalizadoEm: FieldValue.serverTimestamp() });
      return { ok: false, status: 409, codigo: "TRABALHO_INCONCLUSIVO" };
    }
    tx.update(refTrabalho, { estado: dados.resultado, resultado: registroResultado(dados),
      finalizadoEm: FieldValue.serverTimestamp() });
    return { ok: true, status: 200, corpo: { trabalhoId: snap.id, registrado: true, repetido: false } };
  });
}

// Sem onRequest/export no index por enquanto. Também não aceita recibo, pedido,
// impressora ou mensagem do desktop: só IDs/estado rigorosamente validados.
function criarHandlerTrabalhosImpressao({ db, auth, FieldValue, Timestamp }) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ codigo: "METODO_NAO_PERMITIDO" });
    if (req.rawBody?.length > 2048) return res.status(413).json({ codigo: "REQUISICAO_MUITO_GRANDE" });
    if (!validarComandoTrabalho(req.body)) return res.status(400).json({ codigo: "COMANDO_INVALIDO" });
    const sessao = await autenticarDispositivo({ authorization: req.headers?.authorization, auth, db });
    if (!sessao.ok) return res.status(sessao.status).json({ codigo: sessao.codigo });
    try {
      const resultado = await executarTrabalhoImpressao({ db, FieldValue, Timestamp, identidade: sessao.identidade, dados: req.body });
      return res.status(resultado.status).json(resultado.ok ? resultado.corpo : { codigo: resultado.codigo });
    } catch { return res.status(503).json({ codigo: "IMPRESSAO_TEMPORARIAMENTE_INDISPONIVEL" }); }
  };
}

module.exports = {
  COLECAO_TRABALHOS, ID_LEASE, DURACAO_LEASE_MS, DURACAO_TRABALHO_MS,
  idTrabalhoDeterministico, criarTrabalhoImpressao, validarComandoTrabalho,
  executarTrabalhoImpressao, criarHandlerTrabalhosImpressao,
};
