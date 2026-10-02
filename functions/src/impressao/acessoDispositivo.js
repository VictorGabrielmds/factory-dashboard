// Base de migração, ainda não publicada/exportada como Cloud Function.
// Dispositivo não é staff: token de operador/cliente nunca substitui pareamento.
const UID_DISPOSITIVO = /^imp_[A-Za-z0-9_-]{16,80}$/;
const COLECAO_DISPOSITIVOS = "dispositivos_impressao";
const ID_PAREAMENTO = /^par_[a-f0-9]{32}$/;

function autorizarCadastro({ identidade, dispositivo, staffExiste, configuracao }) {
  if (configuracao?.ativa !== true || configuracao?.versao !== 1) {
    return { ok: false, status: 503, codigo: "IMPRESSAO_NAO_ATIVADA" };
  }
  if (staffExiste || dispositivo?.ativo !== true || dispositivo?.tipo !== "impressao" ||
      dispositivo?.uid !== identidade.uid || dispositivo?.credencialVersao !== identidade.credencialVersao) {
    return { ok: false, status: 403, codigo: "DISPOSITIVO_NAO_AUTORIZADO" };
  }
  return { ok: true };
}

async function validarTokenDispositivo({ authorization, auth, exigirPareamento = false }) {
  if (typeof authorization !== "string" || authorization.length > 16000 || !/^Bearer \S+$/.test(authorization)) {
    return { ok: false, status: 401, codigo: "SESSAO_DISPOSITIVO_NECESSARIA" };
  }
  let token;
  try { token = await auth.verifyIdToken(authorization.slice(7), true); }
  catch (erro) {
    const negados = new Set(["auth/argument-error", "auth/invalid-id-token", "auth/id-token-expired",
      "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found"]);
    return negados.has(erro?.code)
      ? { ok: false, status: 401, codigo: "SESSAO_DISPOSITIVO_INVALIDA" }
      : { ok: false, status: 503, codigo: "AUTORIZACAO_INDISPONIVEL" };
  }
  if (!UID_DISPOSITIVO.test(token?.uid || "") || token?.tipo !== "dispositivo_impressao" ||
      token?.firebase?.sign_in_provider !== "custom" || !Number.isSafeInteger(token?.credencialVersao) || token.credencialVersao < 1) {
    return { ok: false, status: 403, codigo: "IDENTIDADE_DISPOSITIVO_NECESSARIA" };
  }
  const identidade = { uid: token.uid, credencialVersao: token.credencialVersao };
  if (typeof token.pareamentoId === "string" && ID_PAREAMENTO.test(token.pareamentoId)) {
    identidade.pareamentoId = token.pareamentoId;
  }
  if (exigirPareamento && !identidade.pareamentoId) {
    return { ok: false, status: 403, codigo: "SESSAO_DE_PAREAMENTO_NECESSARIA" };
  }
  return { ok: true, identidade };
}

async function autenticarDispositivo({ authorization, auth, db }) {
  const sessao = await validarTokenDispositivo({ authorization, auth });
  if (!sessao.ok) return sessao;
  const identidade = sessao.identidade;
  try {
    const [cadastro, staff, configuracao] = await Promise.all([
      db.collection(COLECAO_DISPOSITIVOS).doc(identidade.uid).get(),
      db.collection("staff").doc(identidade.uid).get(),
      db.collection("configuracoes").doc("impressao_api").get(),
    ]);
    const decisao = autorizarCadastro({ identidade, dispositivo: cadastro.data(), staffExiste: staff.exists,
      configuracao: configuracao.data() });
    return decisao.ok ? { ok: true, identidade } : decisao;
  } catch { return { ok: false, status: 503, codigo: "AUTORIZACAO_INDISPONIVEL" }; }
}

module.exports = {
  UID_DISPOSITIVO,
  ID_PAREAMENTO,
  autenticarDispositivo,
  validarTokenDispositivo,
  autorizarCadastro,
  COLECAO_DISPOSITIVOS,
};
