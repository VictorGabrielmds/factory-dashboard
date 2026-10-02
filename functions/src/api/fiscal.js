const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { EFICIENCIA_FISCAL_TOKEN, ORIGENS_PAINEL } = require("../config");
const { ErroFiscal } = require("../fiscal/modelo");
const { exigirEquipeFiscal, autorizarAcaoFiscal } = require("../fiscal/autenticacao");
const { criarServicoFiscal } = require("../fiscal/servico");
const { criarConsultaEficiencia } = require("../fiscal/eficiencia");
const { PREPARACAO_FISCAL } = require("../runtime/capacidade");

const fiscal = onRequest({ ...PREPARACAO_FISCAL, cors: ORIGENS_PAINEL, secrets: [EFICIENCIA_FISCAL_TOKEN],
  timeoutSeconds: 60 }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST.", codigo: "METODO_INVALIDO" });
  try {
    const db = admin.firestore();
    // O módulo fiscal requer sessão real da equipe, sem chave compartilhada como alternativa.
    const usuario = await exigirEquipeFiscal(req, { db, auth: admin.auth() });
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        req.rawBody?.length > 16000) throw new ErroFiscal("REQUISICAO_INVALIDA", "Requisição fiscal inválida.");
    const decisaoPermissao = autorizarAcaoFiscal(usuario, req.body.acao);
    const executar = criarServicoFiscal({ db, Timestamp: admin.firestore.Timestamp,
      testarConexao: () => criarConsultaEficiencia({ token: EFICIENCIA_FISCAL_TOKEN.value() })() });
    return res.json(await executar(req.body.acao, {
      ...req.body,
      autorizacao: decisaoPermissao,
    }, usuario));
  } catch (erro) {
    if (erro instanceof ErroFiscal) return res.status(erro.status).json({ error: erro.message, codigo: erro.codigo });
    // Do not log the error object: provider request errors can contain tokens.
    console.error("[fiscal] falha interna sem dados sensíveis");
    return res.status(500).json({ error: "Não foi possível concluir a operação fiscal. Tente novamente.", codigo: "ERRO_INTERNO" });
  }
});

module.exports = { fiscal };
