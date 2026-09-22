// ============================================================================
// OUTBOX — ENVIO À PROVA DE INTERNET RUIM NO PAINEL
//
// Problema real: o operador clica "enviar", a internet dele cai no meio do
// HTTP para a function, e a mensagem some (ou é enviada 2x no re-clique).
//
// Solução: o painel NÃO chama HTTP para enviar. Ele grava um documento em
// `outbox/` usando o SDK do Firestore — que tem PERSISTÊNCIA OFFLINE nativa:
//   - Sem internet? O SDK enfileira localmente e sincroniza quando voltar.
//   - Computador lento? A gravação local é instantânea; a UI nunca trava.
//   - Duplicidade? O painel gera o ID do documento (uuid); reenvio do mesmo
//     ID é a MESMA gravação — impossível duplicar.
//
// Este gatilho pega cada documento novo do outbox e entrega via Meta,
// com retry automático para erros transitórios.
//
// Formato esperado do documento:
// outbox/{uuidGeradoNoPainel} = {
//   telefone: "5592...", texto: "...",
//   mediaUrl?: string, mediaType?: "image"|"audio"|"video"|"document"|"location",
//   replyToMsgId?: string
// }
// ============================================================================

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin                 = require("firebase-admin");

const { TOKEN_META }        = require("../config");
const { enviarMensagemMeta } = require("../services/meta");

const db = () => admin.firestore();

const processarOutbox = onDocumentCreated(
  {
    document: "outbox/{itemId}",
    secrets: [TOKEN_META],
    memory: "512MiB", // áudio usa ffmpeg
    cpu: 1,
    retry: true,
  },
  async (event) => {
    const ref   = event.data?.ref;
    const dados = event.data?.data();
    if (!dados) return;

    // Trava atômica: garante que apenas UMA execução envia este item
    // (protege contra retry após envio bem-sucedido mas gravação falha)
    const podeEnviar = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const atual = snap.data() || {};
      if (atual.estado === "enviado" || atual.estado === "enviando" || atual.estado === "erro") return false;
      tx.set(ref, { estado: "enviando", tentativas: (atual.tentativas ?? 0) + 1 }, { merge: true });
      return (atual.tentativas ?? 0) < 5;
    });
    if (!podeEnviar) return;

    const { telefone, texto, mediaUrl = null, mediaType = null, replyToMsgId = null } = dados;

    if (!telefone || (!texto && !mediaUrl)) {
      await ref.set({ estado: "erro", erro: "Dados inválidos" }, { merge: true });
      return;
    }

    let msgId;
    try {
      // clientId = o próprio ID do item do outbox — o painel usa esse mesmo
      // ID como identificador da bolha otimista, então quando a mensagem
      // real aparece em conversas/{telefone}/mensagens com esse clientId, a
      // UI casa as duas e remove a bolha sozinha (ver ChatDashboard.tsx).
      msgId = await enviarMensagemMeta(
        TOKEN_META.value(), telefone, texto, mediaUrl, mediaType, replyToMsgId, event.params.itemId
      );
    } catch (erro) {
      const status = erro.response?.status;
      const transitorio = !status || status >= 500 || status === 429;
      const detalhe = JSON.stringify(erro.response?.data ?? erro.message);

      if (transitorio) {
        // Libera a trava e relança: a plataforma repete a execução. Seguro
        // porque a Meta ainda NÃO confirmou o envio nesse ponto.
        await ref.set({ estado: "pendente", ultimoErro: detalhe }, { merge: true });
        throw erro;
      }
      // Erro permanente (número inválido, janela de 24h fechada etc.)
      await ref.set({ estado: "erro", erro: detalhe }, { merge: true });
      console.error(`[outbox] Erro permanente no item ${event.params.itemId}:`, detalhe);
      return;
    }

    // A Meta já confirmou o envio (mensagem de verdade entregue ao cliente,
    // e enviarMensagemMeta já gravou ela em conversas/.../mensagens) — daqui
    // pra frente NUNCA deixamos uma retentativa mandar de novo pra Meta,
    // mesmo que só esta última gravação falhe. Se falhar, só loga pra
    // investigação manual e NÃO relança: o item fica em "enviando", que a
    // trava do topo já trata como bloqueado (sem reprocessar sozinho).
    try {
      await ref.set({
        estado: "enviado",
        msgId,
        enviadoEm: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (erroFinal) {
      console.error(
        `[outbox] Mensagem ${msgId} enviada com sucesso pra ${telefone}, mas falhou ao marcar o item ` +
        `${event.params.itemId} como concluído — checar manualmente:`, erroFinal.message,
      );
    }
  }
);

module.exports = { processarOutbox };
