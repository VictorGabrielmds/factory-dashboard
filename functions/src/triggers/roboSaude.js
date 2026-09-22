// ============================================================================
// SAÚDE DO ROBÔ DE IMPRESSÃO
// O robô (RoboImpressaoDelivery, PC físico ao lado da impressora) grava um
// heartbeat em sistema/robo_impressao a cada ~1 min enquanto está de pé.
// Sem isso, ninguém do time sabia que o robô tinha caído até um cliente
// reclamar que o pedido nunca chegou. Esta função checa periodicamente se o
// heartbeat parou e abre uma pendência (mesmo mecanismo já usado para colisão
// de PIX em webhooks/asaas.js) — resolve sozinha quando o robô volta.
// ============================================================================

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin           = require("firebase-admin");

const { horaAtualSP } = require("../lib/util");

const db = () => admin.firestore();

const MINUTOS_TOLERANCIA = 4; // heartbeat do robô é a cada 1 min; folga pro round-trip
const TIPO_PENDENCIA = "robo_offline";

const checarSaudeRobo = onSchedule(
  { schedule: "every 5 minutes", timeZone: "America/Sao_Paulo", memory: "256MiB", cpu: 1 },
  async () => {
    const refStatus = db().collection("sistema").doc("robo_impressao");
    const snapStatus = await refStatus.get();

    // Robô nunca rodou com a versão que grava heartbeat — nada a fazer ainda.
    if (!snapStatus.exists) return;

    const dados = snapStatus.data();
    const ultimoHeartbeat = dados.ultimoHeartbeat?.toDate?.() ?? null;
    const minutosDesdeUltimoHeartbeat = ultimoHeartbeat
      ? (Date.now() - ultimoHeartbeat.getTime()) / 60000
      : Infinity;

    const online = dados.online === true && minutosDesdeUltimoHeartbeat <= MINUTOS_TOLERANCIA;

    const snapPendencia = await db().collection("pendencias")
      .where("tipo", "==", TIPO_PENDENCIA)
      .where("resolvida", "==", false)
      .limit(1)
      .get();

    if (!online) {
      if (snapPendencia.empty) {
        const descricao = ultimoHeartbeat
          ? `Robô de impressão sem contato há ${minutosDesdeUltimoHeartbeat.toFixed(0)} min. Verificar o PC ao lado da impressora (rede, energia, se o app está aberto).`
          : "Robô de impressão nunca reportou heartbeat. Verificar o PC ao lado da impressora.";

        await db().collection("pendencias").add({
          chatId: "sistema",
          tipo: TIPO_PENDENCIA,
          descricao,
          resolvida: false,
          criadaEm: horaAtualSP(),
          criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.warn("[roboSaude] Robô de impressão offline — pendência criada.");
      }
      return;
    }

    // Voltou a ficar online: resolve a pendência aberta automaticamente, sem
    // exigir que alguém entre no painel só para fechar o alerta.
    if (!snapPendencia.empty) {
      await snapPendencia.docs[0].ref.set({
        resolvida: true,
        resolvidaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      console.log("[roboSaude] Robô de impressão voltou a ficar online — pendência resolvida.");
    }
  }
);

module.exports = { checarSaudeRobo };
