// ============================================================================
// RESOLUÇÃO DE CONVERSA POR TELEFONE
// Diferente de lib/util.js (funções puras, sem I/O), este arquivo lê o
// Firestore — por isso vive à parte.
//
// O mesmo contato pode chegar em formatos diferentes dependendo da origem
// (wa_id da Meta, número digitado no painel, telefone_destinatario de um
// pedido) — com e sem DDI, com e sem o 9º dígito. Sem checar se já existe
// uma conversa numa variante equivalente antes de decidir o ID do documento,
// cada formato novo virava uma conversa duplicada pro mesmo cliente.
// ============================================================================

const admin = require("firebase-admin");
const { normalizarTelefone, variantesNumero } = require("./util");

const db = () => admin.firestore();

/**
 * Resolve a referência do documento em conversas/ para um número bruto:
 * procura entre as variantes plausíveis (com/sem 9º dígito) um documento já
 * existente e reaproveita ele; se nenhum existir, decide o ID canônico
 * normalizado (DDI + DDD + 9 dígitos). Retorna null se o número não puder
 * ser normalizado (ex.: sem DDD, dado incompleto demais pra adivinhar).
 */
async function resolverConversaRef(telefoneBruto) {
  const numero = normalizarTelefone(telefoneBruto);
  if (!numero) return null;

  for (const variante of variantesNumero(numero)) {
    const ref = db().collection("conversas").doc(variante);
    if ((await ref.get()).exists) return ref;
  }
  return db().collection("conversas").doc(numero);
}

module.exports = { resolverConversaRef };
