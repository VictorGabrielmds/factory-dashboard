const { ErroFiscal } = require("./modelo");

async function exigirEquipeFiscal(req, { auth, db }) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 16000) {
    throw new ErroFiscal("LOGIN_NECESSARIO", "Entre no painel para acessar o módulo fiscal.", 401);
  }
  let usuario;
  try { usuario = await auth.verifyIdToken(header.slice(7), true); }
  catch { throw new ErroFiscal("SESSAO_INVALIDA", "Sua sessão expirou. Entre novamente no painel.", 401); }
  const staff = await db.collection("staff").doc(usuario.uid).get();
  if (!staff.exists || staff.data()?.ativo === false) {
    throw new ErroFiscal("ACESSO_FISCAL_NEGADO", "Este acesso é exclusivo da equipe cadastrada no painel.", 403);
  }
  return { uid: usuario.uid };
}

module.exports = { exigirEquipeFiscal };
