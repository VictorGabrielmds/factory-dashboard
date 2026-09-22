// ============================================================================
// API — chat (painel)
// Mudanças de segurança/robustez:
//   - AUTENTICAÇÃO obrigatória (sessão Firebase de equipe ativa) — antes qualquer
//     pessoa na internet podia mandar WhatsApp em nome da loja
//   - CORS restrito aos domínios do painel
//   - Idempotência ATÔMICA com create(): dois cliques simultâneos não passam
//     mais pelo "get → set" (race condition do código antigo)
//
// Obs.: para envio de mensagens, prefira o OUTBOX (triggers/outbox.js) —
// este endpoint continua existindo para compatibilidade com o painel atual.
// ============================================================================

const { onRequest } = require("firebase-functions/v2/https");
const admin         = require("firebase-admin");

const { SEGREDOS_CHAT, TOKEN_META, ORIGENS_PAINEL } = require("../config");
const { exigirPainel } = require("../lib/seguranca");
const { enviarMensagemMeta, marcarLida, enviarDigitando } = require("../services/meta");

const db = () => admin.firestore();

const chat = onRequest(
  { cors: ORIGENS_PAINEL, secrets: SEGREDOS_CHAT, minInstances: 1, memory: "512MiB", cpu: 1 },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Método não permitido");
    if (!(await exigirPainel(req, res))) return;

    const { action, telefone, texto, messageId, mediaUrl, mediaType, idempotencyKey, replyToMsgId } = req.body;
    if (!action) return res.status(400).json({ error: "Falta action" });

    const token = TOKEN_META.value();

    try {
      // ── enviarMensagem ─────────────────────────────────────────────────────
      if (action === "enviarMensagem") {
        if (!telefone) return res.status(400).send("Falta telefone");

        const idempotencyRef = idempotencyKey
          ? db().collection("_idempotency").doc(idempotencyKey)
          : null;

        if (idempotencyRef) {
          // create() é atômico: só uma requisição "reivindica" a chave, evitando
          // clique duplo. Mas o envio ainda não aconteceu aqui — por isso o
          // estado começa como "enviando", nunca respondemos sucesso ainda.
          try {
            await idempotencyRef.create({
              estado: "enviando",
              criadoEm: admin.firestore.FieldValue.serverTimestamp(),
              expiraEm: admin.firestore.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
            });
          } catch (e) {
            if (e.code === 6 /* ALREADY_EXISTS */) {
              const existente = (await idempotencyRef.get()).data();
              if (existente?.estado === "enviado") {
                // Reenvio de uma chamada que já tinha concluído com sucesso —
                // aí sim é seguro responder sucesso sem enviar de novo.
                return res.status(200).json({ success: true, duplicate: true, msgId: existente.msgId });
              }
              // estado "enviando" (corrida rara) ou "falhou" (tentativa anterior
              // não completou) — deixa tentar de novo em vez de mentir que deu certo
            } else {
              throw e;
            }
          }
        }

        let msgId;
        try {
          // enviarMensagemMeta já manda pra Meta E grava a mensagem no
          // histórico (registrarSaida) antes de devolver o msgId — se
          // chegou até aqui sem lançar, a mensagem já foi entregue de verdade.
          msgId = await enviarMensagemMeta(token, telefone, texto, mediaUrl, mediaType, replyToMsgId, idempotencyKey);
        } catch (erroEnvio) {
          // Erro ANTES/DURANTE o envio de verdade — aí sim é seguro liberar a
          // chave pra uma retentativa futura tentar do zero.
          if (idempotencyRef) await idempotencyRef.set({ estado: "falhou" }, { merge: true });
          throw erroEnvio;
        }

        // A partir daqui a mensagem já está entregue — nunca mais deixamos
        // uma retentativa mandar de novo pra Meta, mesmo que só esta última
        // gravação falhe (se falhar, só loga; ainda respondemos sucesso,
        // porque a mensagem realmente foi enviada).
        if (idempotencyRef) {
          try {
            await idempotencyRef.set({ estado: "enviado", msgId }, { merge: true });
          } catch (erroFinal) {
            console.error(
              `[chat/enviarMensagem] Mensagem ${msgId} enviada com sucesso, mas falhou ao marcar a ` +
              `idempotencyKey ${idempotencyKey} como concluída:`, erroFinal.message,
            );
          }
        }
        return res.status(200).json({ success: true, msgId });
      }

      // ── editarMensagem ─────────────────────────────────────────────────────
      if (action === "editarMensagem") {
        const { chatMsgId, novoTexto } = req.body;
        if (!telefone || !chatMsgId || !novoTexto?.trim()) {
          return res.status(400).send("Dados inválidos");
        }

        const msgRef  = db().collection("conversas").doc(telefone).collection("mensagens").doc(chatMsgId);
        const msgSnap = await msgRef.get();
        if (!msgSnap.exists) return res.status(404).json({ error: "Mensagem não encontrada" });

        const msgData = msgSnap.data();
        if (msgData.sender !== "outgoing") {
          return res.status(403).json({ error: "Só é possível editar mensagens enviadas por você" });
        }

        const enviadaEm = msgData.timestamp?.toMillis ? msgData.timestamp.toMillis() : 0;
        if (!enviadaEm || Date.now() - enviadaEm > 30 * 60 * 1000) {
          return res.status(403).json({ error: "Prazo de 30 minutos para edição expirado" });
        }

        await msgRef.set({
          text: novoTexto.trim(),
          editada: true,
          editedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        const ultimaMsgSnap = await db().collection("conversas").doc(telefone)
          .collection("mensagens").orderBy("timestamp", "desc").limit(1).get();
        if (!ultimaMsgSnap.empty && ultimaMsgSnap.docs[0].id === chatMsgId) {
          await db().collection("conversas").doc(telefone).set({ lastMessage: novoTexto.trim() }, { merge: true });
        }
        return res.status(200).json({ success: true });
      }

      // ── marcarLida ─────────────────────────────────────────────────────────
      if (action === "marcarLida") {
        if (!messageId) return res.status(400).send("Falta messageId");
        await marcarLida(token, messageId);
        return res.status(200).json({ success: true });
      }

      // ── enviarDigitando ────────────────────────────────────────────────────
      if (action === "enviarDigitando") {
        if (!telefone) return res.status(400).send("Falta telefone");
        await enviarDigitando(token, telefone);
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: `Action desconhecida: ${action}` });
    } catch (error) {
      const detalheMeta = error.response?.data?.error;
      const motivo = detalheMeta?.error_data?.details || detalheMeta?.message || error.message || "Erro interno";
      console.error(`[chat/${action}] Erro:`, detalheMeta || error.message);
      return res.status(500).json({ error: motivo });
    }
  }
);

module.exports = { chat };
