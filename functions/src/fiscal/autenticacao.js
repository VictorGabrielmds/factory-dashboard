const { ErroFiscal } = require("./modelo");
const {
  avaliarCapacidade,
  montarOperadorPainel,
  temCapacidade,
} = require("../lib/permissoesPainel");

const CAPACIDADES_ACAO_FISCAL = Object.freeze({
  resumo: "fiscal.preparar",
  salvarVinculo: "fiscal.preparar",
  conferirPedido: "fiscal.preparar",
  consultarConferencia: "fiscal.preparar",
  testarConexao: "fiscal.preparar",
  prepararOperacao: "fiscal.preparar",
  emitir: "fiscal.emitir",
  autorizar: "fiscal.emitir",
  retransmitir: "fiscal.emitir",
  cancelar: "fiscal.cancelar",
});

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
  return montarOperadorPainel({ usuario, staff: staff.data() || {} });
}

function autorizarAcaoFiscal(operador, acao) {
  const capacidade = CAPACIDADES_ACAO_FISCAL[acao];
  if (!capacidade) {
    throw new ErroFiscal("ACAO_INVALIDA", "Ação fiscal inválida.");
  }
  const critica = ["fiscal.emitir", "fiscal.cancelar"].includes(capacidade);
  const legado = operador?.papeis?.includes("operador_legado");
  const decisao = critica
    ? {
        autorizada: !legado && temCapacidade(operador, capacidade),
        modo: "permitida",
        capacidade,
        permitidaPorPerfil: !legado && temCapacidade(operador, capacidade),
      }
    : avaliarCapacidade(operador, capacidade);
  if (!decisao.autorizada) {
    throw new ErroFiscal(
      "ACESSO_FISCAL_NEGADO",
      "Seu acesso não permite executar esta ação fiscal.",
      403
    );
  }
  return decisao;
}

module.exports = { CAPACIDADES_ACAO_FISCAL, exigirEquipeFiscal, autorizarAcaoFiscal };
