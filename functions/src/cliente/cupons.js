// ============================================================================
// VALIDAÇÃO DE CUPOM — App Cliente
// Desconto NUNCA é calculado nem confiado no cliente: ele manda um código,
// o servidor devolve { tipo, valor } vindos de cupons/{codigo} — coleção que
// o app cliente nunca lê direto (só esta function, via Admin SDK). A conta
// de uso (usosCount) só é incrementada quando a fase de finalizar pedido
// existir; até lá, isto é sempre uma pré-visualização, nunca um consumo.
// ============================================================================

const crypto = require("crypto");
const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

const db = () => admin.firestore();

const MAX_TENTATIVAS_POR_MINUTO = 10;
const JANELA_MS = 60 * 1000;

function normalizarCodigo(bruto) {
  return String(bruto || "").trim().toUpperCase();
}

function ipDaRequisicao(request) {
  const encaminhado = request.rawRequest?.headers?.["x-forwarded-for"];
  if (typeof encaminhado === "string" && encaminhado.trim()) return encaminhado.split(",")[0].trim();
  return request.rawRequest?.ip || null;
}

// Janela deslizante de tentativas — mesmo padrão de solicitarLoginWhatsApp
// (ver src/cliente/authWhatsApp.js). Cliente logado usa o doc que já existe
// (clientes/{uid}); visitante (sem login, ver "Cardápio completo" — a busca
// de cupom funciona antes de logar) usa o IP como chave, guardado só como
// hash (nunca o IP em texto puro). Frear script de enumeração de códigos,
// não atrapalhar alguém digitando errado.
async function checarLimiteTentativas(chaveRef, campo) {
  const agora = Date.now();
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(chaveRef);
    const dados = snap.exists ? snap.data() : null;
    const tentativas = (dados?.[campo] || []).filter((ts) => agora - ts.toMillis() < JANELA_MS);
    if (tentativas.length >= MAX_TENTATIVAS_POR_MINUTO) {
      throw new HttpsError("resource-exhausted", "Muitas tentativas. Aguarde um minuto.");
    }
    tx.set(chaveRef, { [campo]: [...tentativas, admin.firestore.Timestamp.fromMillis(agora)] }, { merge: true });
  });
}

const validarCupom = onCall(
  {
    region: "southamerica-east1",
    enforceAppCheck: true,
  },
  async (request) => {
    const codigo = normalizarCodigo(request.data?.codigo);
    const subtotal = Number(request.data?.subtotal);
    if (!codigo || !Number.isFinite(subtotal) || subtotal < 0) {
      throw new HttpsError("invalid-argument", "Cupom ou carrinho inválido.");
    }

    if (request.auth) {
      await checarLimiteTentativas(db().collection("clientes").doc(request.auth.uid), "cupomTentativasRecentes");
    } else {
      const ip = ipDaRequisicao(request);
      if (ip) {
        const hashIp = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 32);
        await checarLimiteTentativas(db().collection("_cupomTentativasAnonimas").doc(hashIp), "tentativas");
      }
      // Sem IP disponível (raríssimo): segue sem limite dedicado — App Check
      // já barra origem fora do app.
    }

    const cupomSnap = await db().collection("cupons").doc(codigo).get();
    if (!cupomSnap.exists) {
      throw new HttpsError("failed-precondition", "Cupom não encontrado.");
    }

    const cupom = cupomSnap.data();
    if (!cupom.ativo) {
      throw new HttpsError("failed-precondition", "Este cupom não está mais ativo.");
    }
    if (cupom.expiraEm && Date.now() > cupom.expiraEm.toMillis()) {
      throw new HttpsError("failed-precondition", "Este cupom expirou.");
    }
    if (cupom.limiteUsos != null && (cupom.usosCount || 0) >= cupom.limiteUsos) {
      throw new HttpsError("failed-precondition", "Este cupom já atingiu o limite de usos.");
    }

    // Só o mínimo pro cliente calcular o desconto exibido — nunca o
    // documento inteiro (nada de vazar limiteUsos/usosCount/expiraEm).
    return { tipo: cupom.tipo, valor: cupom.valor };
  }
);

module.exports = { validarCupom };
