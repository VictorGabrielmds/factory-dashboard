// ============================================================================
// SEGURANÇA
// - Validação da assinatura X-Hub-Signature-256 da Meta (HMAC do rawBody)
// - Autenticação do painel: sessão Firebase de membro ativo da equipe
// - Comparações sempre em tempo constante (timingSafeEqual) contra timing attacks
// ============================================================================

const crypto = require("crypto");
const admin  = require("firebase-admin");
const { montarOperadorPainel } = require("./permissoesPainel");

function comparaSegura(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Valida a assinatura HMAC-SHA256 que a Meta envia em todo webhook.
 * Sem isso, qualquer pessoa que descubra a URL pode injetar mensagens falsas
 * no seu painel e disparar automações.
 */
function assinaturaMetaValida(req, appSecret) {
  const assinatura = req.headers["x-hub-signature-256"];
  if (!assinatura || !req.rawBody) return false;
  const esperada = "sha256=" + crypto
    .createHmac("sha256", appSecret)
    .update(req.rawBody)
    .digest("hex");
  return comparaSegura(assinatura, esperada);
}

/**
 * Verifica uma sessão Firebase revogável e o documento staff correspondente.
 * Esta é a fronteira de autorização do painel: ter uma conta Firebase (por
 * exemplo, como cliente) não concede acesso administrativo. `ativo` ausente é
 * aceito temporariamente para não derrubar documentos staff legados; `false`
 * revoga o acesso imediatamente.
 *
 * Dependências injetáveis mantêm os testes locais sem acessar Firebase real.
 */
async function autenticarEquipePainel({ authorization, auth = admin.auth(), db = admin.firestore() }) {
  const header = typeof authorization === "string" ? authorization : "";
  if (!header.startsWith("Bearer ") || header.length > 16000) {
    return { ok: false, status: 401, codigo: "SESSAO_NECESSARIA" };
  }

  let usuario;
  try {
    usuario = await auth.verifyIdToken(header.slice(7), true);
  } catch (_) {
    return { ok: false, status: 401, codigo: "SESSAO_INVALIDA" };
  }

  const uid = typeof usuario?.uid === "string" ? usuario.uid : "";
  if (!uid) return { ok: false, status: 401, codigo: "SESSAO_INVALIDA" };

  const staff = await db.collection("staff").doc(uid).get();
  if (!staff.exists || staff.data()?.ativo === false) {
    return { ok: false, status: 403, codigo: "ACESSO_EQUIPE_NEGADO" };
  }

  return { ok: true, operador: montarOperadorPainel({ usuario, staff: staff.data() || {} }) };
}

/**
 * Responde de forma uniforme e devolve o operador autenticado. Não existe
 * alternativa por chave compartilhada: qualquer valor embutido no navegador é público.
 */
async function exigirPainel(req, res, dependencias = {}) {
  let resultado;
  try {
    resultado = await autenticarEquipePainel({
      authorization: req.headers?.authorization,
      ...dependencias,
    });
  } catch (_) {
    // Falha interna de consulta não deve virar "sem acesso" nem expor detalhe.
    res.status(500).json({ error: "Não foi possível validar o acesso da equipe.", codigo: "AUTORIZACAO_INDISPONIVEL" });
    return null;
  }

  if (!resultado.ok) {
    const mensagem = resultado.status === 401 ? "Entre novamente para continuar." : "Este acesso não está autorizado para a equipe.";
    res.status(resultado.status).json({ error: mensagem, codigo: resultado.codigo });
    return null;
  }

  return resultado.operador;
}

module.exports = { comparaSegura, assinaturaMetaValida, autenticarEquipePainel, exigirPainel };
