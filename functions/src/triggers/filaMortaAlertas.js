// ============================================================================
// ALERTA DE FILA MORTA (DEAD LETTER QUEUE)
// outbox/ (estado:"erro", ver triggers/outbox.js) e eventos_meta/
// (estado:"erro_permanente", ver webhooks/whatsapp.js) já desistem sozinhos
// depois de N tentativas — mas até agora esses itens ficavam invisíveis,
// só visíveis direto no console do Firestore. Esta função varre os dois
// periodicamente e cria uma pendência (mesma coleção/UI já usada em
// webhooks/asaas.js) pra cada falha permanente ainda não alertada.
//
// Diferente de roboSaude.js, aqui NÃO há resolução automática: uma mensagem
// que falhou de vez é uma perda real que exige decisão humana (reenviar
// manualmente, ligar pro cliente) — não é algo que "volta sozinho".
// ============================================================================

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin           = require("firebase-admin");

const { horaAtualSP } = require("../lib/util");

const db = () => admin.firestore();

async function alertarFalhasPermanentes({ colecao, valorEstado, tipo, descricaoBase }) {
  const snap = await db().collection(colecao).where("estado", "==", valorEstado).limit(50).get();

  for (const doc of snap.docs) {
    const dados = doc.data();
    if (dados.pendenciaCriada) continue; // já alertado numa varredura anterior

    await db().collection("pendencias").add({
      chatId: "sistema",
      tipo,
      descricao: `${descricaoBase} (${colecao}/${doc.id}).`,
      resolvida: false,
      criadaEm: horaAtualSP(),
      criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await doc.ref.set({ pendenciaCriada: true }, { merge: true });
    console.warn(`[filaMortaAlertas] Pendência criada para ${colecao}/${doc.id} (${tipo}).`);
  }
}

async function alertarEventosAsaasTravados() {
  const snap = await db().collection("eventos_asaas")
    .where("estado", "==", "erro_transitorio")
    .limit(50)
    .get();
  const limiteMs = Date.now() - 10 * 60 * 1000;

  for (const doc of snap.docs) {
    const dados = doc.data();
    if (dados.pendenciaCriada) continue;
    const falhouEm = dados.ultimaFalhaEm?.toMillis?.() || Date.now();
    if (falhouEm > limiteMs) continue;

    const paymentId = dados.paymentId || "desconhecido";
    const pendenciaRef = db().collection("pendencias").doc(`pix_processamento_${doc.id}`);
    await db().runTransaction(async (tx) => {
      const eventoSnap = await tx.get(doc.ref);
      if (eventoSnap.data()?.pendenciaCriada) return;
      tx.set(pendenciaRef, {
        chatId: "sistema",
        tipo: "pix_processamento_atrasado",
        descricao:
          `A confirmação do PIX ${paymentId} está há mais de 10 minutos sem conseguir ` +
          `consultar/processar o Asaas. O retry automático continua ativo.`,
        pagamentoId: paymentId,
        resolvida: false,
        criadaEm: horaAtualSP(),
        criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.set(doc.ref, { pendenciaCriada: true }, { merge: true });
    });
  }
}

const filaMortaAlertas = onSchedule(
  { schedule: "every 5 minutes", timeZone: "America/Sao_Paulo", memory: "256MiB", cpu: 1 },
  async () => {
    await Promise.all([
      alertarFalhasPermanentes({
        colecao: "outbox",
        valorEstado: "erro",
        tipo: "outbox_falhou",
        descricaoBase: "Mensagem do painel não foi entregue ao cliente após várias tentativas",
      }),
      alertarFalhasPermanentes({
        colecao: "eventos_meta",
        valorEstado: "erro_permanente",
        tipo: "whatsapp_falhou",
        descricaoBase: "Evento recebido do WhatsApp não foi processado após várias tentativas",
      }),
      alertarEventosAsaasTravados(),
    ]);
  }
);

module.exports = { filaMortaAlertas };
