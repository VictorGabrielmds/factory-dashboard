// ============================================================================
// WEBHOOK META (WhatsApp) — ARQUITETURA "ACK RÁPIDO + FILA"
//
// ANTES: o webhook baixava mídia, gravava várias coleções e mandava push
//        ANTES de responder. Com internet/CPU lenta, a Meta dá timeout,
//        REENVIA o evento e você recebe mensagem duplicada.
//
// AGORA:
//   1. Valida a assinatura HMAC (X-Hub-Signature-256) — bloqueia payload falso
//   2. Grava o evento bruto em `eventos_meta` com create() usando o ID da
//      própria mensagem como ID do documento → reentrega da Meta = colisão
//      de ID = ignorada de graça (deduplicação atômica, sem race condition)
//   3. Responde 200 em milissegundos
//   4. O trigger onDocumentCreated processa com calma (mídia, push, etc.)
//      e, se falhar por erro transitório, o Cloud Functions REPETE sozinho
//      (retry: true) — nada se perde com internet ruim.
// ============================================================================

const { onRequest }          = require("firebase-functions/v2/https");
const { onDocumentCreated }  = require("firebase-functions/v2/firestore");
const admin                  = require("firebase-admin");

const {
  TOKEN_META, META_APP_SECRET, META_VERIFY_TOKEN, SEGREDOS_META,
} = require("../config");
const { assinaturaMetaValida }              = require("../lib/seguranca");
const { horaAtualSP, garantirNonoDigito, idDocSeguro } = require("../lib/util");
const { descarregarMidiaMeta, enviarMensagemMeta }     = require("../services/meta");
const { resolverConversaRef }                          = require("../lib/conversas");

const db = () => admin.firestore();

// ─────────────────────────────────────────────────────────────────────────────
// 1) RECEPTOR — só valida, enfileira e responde
// ─────────────────────────────────────────────────────────────────────────────
const webhookWhatsApp = onRequest(
  { secrets: SEGREDOS_META, memory: "256MiB", cpu: 1, minInstances: 1 },
  async (req, res) => {
    // Verificação inicial do webhook no painel da Meta
    if (req.method === "GET") {
      if (
        req.query["hub.mode"] === "subscribe" &&
        req.query["hub.verify_token"] === META_VERIFY_TOKEN.value()
      ) {
        console.log("Webhook verificado pelo painel da Meta.");
        return res.status(200).send(req.query["hub.challenge"]);
      }
      return res.sendStatus(403);
    }

    if (req.method !== "POST") return res.sendStatus(405);

    // 🔒 Assinatura obrigatória — sem ela, qualquer um injeta mensagens falsas
    if (!assinaturaMetaValida(req, META_APP_SECRET.value())) {
      console.warn("Webhook Meta com assinatura inválida. Descartado.");
      return res.sendStatus(401);
    }

    const body = req.body;
    if (body.object !== "whatsapp_business_account") return res.sendStatus(200);

    try {
      const gravacoes = [];

      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};

          for (const message of value.messages ?? []) {
            const docId = idDocSeguro(`msg_${message.id}`);
            gravacoes.push(
              db().collection("eventos_meta").doc(docId).create({
                tipo: "mensagem",
                message,
                contacts: value.contacts ?? [],
                recebidoEm: admin.firestore.FieldValue.serverTimestamp(),
              }).catch((e) => {
                if (e.code === 6 /* ALREADY_EXISTS */) {
                  console.log(`Evento duplicado ignorado: ${docId}`);
                } else { throw e; }
              })
            );
          }

          for (const statusObj of value.statuses ?? []) {
            const docId = idDocSeguro(`st_${statusObj.id}_${statusObj.status}`);
            gravacoes.push(
              db().collection("eventos_meta").doc(docId).create({
                tipo: "status",
                statusObj,
                recebidoEm: admin.firestore.FieldValue.serverTimestamp(),
              }).catch((e) => {
                if (e.code !== 6) throw e;
              })
            );
          }
        }
      }

      await Promise.all(gravacoes);
    } catch (error) {
      console.error("Erro ao enfileirar evento da Meta:", error);
      // Mesmo com erro respondemos 200: a Meta reenviará e o create() deduplica.
    }

    return res.sendStatus(200);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 2) PROCESSADOR — trabalho pesado, com retry automático da plataforma
// ─────────────────────────────────────────────────────────────────────────────
const processarEventoMeta = onDocumentCreated(
  {
    document: "eventos_meta/{eventoId}",
    secrets: SEGREDOS_META,
    memory: "512MiB",
    cpu: 1,
    retry: true, // falhou (ex.: rede caiu no download da mídia)? A GCP repete.
  },
  async (event) => {
    const dados = event.data?.data();
    if (!dados) return;

    // Guarda contra retry infinito: após 5 tentativas, marca como erro e para.
    // Read-modify-write numa TRANSAÇÃO — o Eventarc garante entrega "pelo
    // menos uma vez", ou seja, o MESMO evento pode disparar esta function
    // mais de uma vez em paralelo; sem transação, duas execuções concorrentes
    // podiam ler o mesmo "tentativas" e escrever o mesmo valor, deixando a
    // contagem nunca ultrapassar 5 de verdade (retry infinito na prática).
    const ref  = event.data.ref;
    const tentativas = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const novoValor = (snap.data()?.tentativas ?? 0) + 1;
      tx.set(ref, { tentativas: novoValor }, { merge: true });
      return novoValor;
    });
    if (tentativas > 5) {
      await ref.set({ estado: "erro_permanente" }, { merge: true });
      console.error(`Evento ${event.params.eventoId} abandonado após 5 tentativas.`);
      return;
    }

    const token = TOKEN_META.value();

    if (dados.tipo === "mensagem") {
      await tratarMensagemRecebida(token, dados.message, dados.contacts);
    } else if (dados.tipo === "status") {
      await tratarStatusMensagem(dados.statusObj);
    }

    await ref.set({ estado: "processado", processadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
);

// ── Mensagem recebida do cliente ─────────────────────────────────────────────
async function tratarMensagemRecebida(token, message, contacts) {
  const nomeCliente   = contacts?.[0]?.profile?.name ?? "Cliente Novo";
  const numeroCliente = garantirNonoDigito(message.from);
  const hora          = horaAtualSP();

  console.log(`Mensagem de ${numeroCliente} (${nomeCliente}), tipo: ${message.type}`);

  // Reaproveita a conversa já existente do contato (pode ter sido criada por
  // um pedido, com um formato de número diferente) em vez de sempre criar
  // uma nova a partir do wa_id cru da Meta.
  const conversaRef = await resolverConversaRef(numeroCliente);
  if (!conversaRef) {
    console.error(`[tratarMensagemRecebida] wa_id inválido, mensagem ignorada: "${numeroCliente}"`);
    return;
  }

  // ── Botão de resposta rápida ───────────────────────────────────────────────
  if (message.type === "button") {
    const buttonText = message.button.text;
    const conversaRefBotao = conversaRef;
    const jaExisteBotao = (await conversaRefBotao.get()).exists;

    await conversaRefBotao
      .collection("mensagens").doc(message.id)
      .set({
        id: message.id, sender: "incoming", text: `🔘 ${buttonText}`,
        time: hora, timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

    await conversaRefBotao.set({
      phone: conversaRefBotao.id,
      // Nome do WhatsApp só é usado para criar o contato. Depois disso, o
      // nome do último pedido (ou edição manual) é a fonte de verdade.
      ...(jaExisteBotao ? {} : { clientName: nomeCliente }),
      lastMessage: `🔘 ${buttonText}`,
      time: hora,
      unreadCount: admin.firestore.FieldValue.increment(1),
      lastIncomingCount: admin.firestore.FieldValue.increment(1),
      isOnline: true,
      lastMessageSender: "incoming",
      lastIncomingAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return;
  }

  // ── Texto e mídias ─────────────────────────────────────────────────────────
  if (["text", "image", "audio", "sticker", "document", "video", "location"].includes(message.type)) {
    let textoRecebido = "";
    let mediaUrl = null;
    let mediaType = null;

    switch (message.type) {
      case "text":
        textoRecebido = message.text.body;
        break;
      case "image":
        mediaType = "image";
        textoRecebido = message.image.caption || "";
        mediaUrl = await descarregarMidiaMeta(token, message.image.id, message.image.mime_type);
        break;
      case "audio":
        mediaType = "audio";
        mediaUrl = await descarregarMidiaMeta(token, message.audio.id, message.audio.mime_type);
        break;
      case "location":
        mediaType = "location";
        textoRecebido = message.location.name || message.location.address || "📍 Localização";
        mediaUrl = `https://www.google.com/maps/search/?api=1&query=${message.location.latitude},${message.location.longitude}`;
        break;
      case "sticker":
        mediaType = "sticker";
        mediaUrl = await descarregarMidiaMeta(token, message.sticker.id, message.sticker.mime_type);
        if (mediaUrl) {
          await db().collection("configuracoes").doc("figurinhas").set({
            lista: admin.firestore.FieldValue.arrayUnion({
              url: mediaUrl, de: numeroCliente, salvaEm: new Date().toISOString(),
            }),
          }, { merge: true });
        }
        break;
      case "document":
        mediaType = "document";
        textoRecebido = message.document.filename || "";
        mediaUrl = await descarregarMidiaMeta(token, message.document.id, message.document.mime_type);
        break;
      case "video":
        mediaType = "video";
        textoRecebido = message.video.caption || "";
        mediaUrl = await descarregarMidiaMeta(token, message.video.id, message.video.mime_type);
        break;
    }

    const conversaSnap = await conversaRef.get();
    const jaExiste     = conversaSnap.exists;

    const batch = db().batch();
    batch.set(conversaRef.collection("mensagens").doc(message.id), {
      id: message.id, sender: "incoming", text: textoRecebido,
      time: hora, timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ...(mediaUrl ? { mediaUrl, mediaType } : {}),
    });

    const lastMessageLabel =
      mediaType === "image"    ? (textoRecebido || "📷 Imagem")
      : mediaType === "audio"  ? "🎵 Áudio"
      : mediaType === "sticker" ? "✨ Figurinha"
      : mediaType === "document" ? `📄 ${textoRecebido || "Arquivo"}`
      : mediaType === "video"  ? "🎬 Vídeo"
      : textoRecebido;

    batch.set(conversaRef, {
      phone: conversaRef.id,
      // Nome do WhatsApp só é usado para criar o contato. Depois disso, o
      // nome do último pedido (ou edição manual) é a fonte de verdade.
      ...(jaExiste ? {} : { clientName: nomeCliente }),
      lastMessage: lastMessageLabel,
      lastIncomingMessageId: message.id,
      lastIncomingAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      time: hora,
      unreadCount: admin.firestore.FieldValue.increment(1),
      isOnline: true,
      ...(jaExiste ? {} : { criadoEm: admin.firestore.FieldValue.serverTimestamp(), tags: [] }),
      lastMessageSender: "incoming",
    }, { merge: true });

    await batch.commit();

    // Push para o operador — falha aqui não pode derrubar o processamento
    try {
      const configDoc = await db().collection("configuracoes").doc("notificacoes").get();
      if (configDoc.exists && configDoc.data().tokenAdmin) {
        await admin.messaging().send({
          token: configDoc.data().tokenAdmin,
          data: {
            title: `Nova mensagem de ${nomeCliente}`,
            body: textoRecebido || lastMessageLabel,
            chatId: conversaRef.id,
          },
        });
      }
    } catch (erroPush) {
      console.error("Falha ao enviar notificação push:", erroPush.message);
    }
    return;
  }

  // ── Permissão de ligação ───────────────────────────────────────────────────
  if (message.type === "call_permission") {
    if (message.call_permission?.status === "accepted") {
      await conversaRef.set({
        hasCallPermission: true,
        callPermissionGrantedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return;
  }

  // ── Chamada de voz ─────────────────────────────────────────────────────────
  if (message.type === "call") {
    const statusChamada = message.call?.status;
    const duracao = message.call?.duration ?? 0;
    const textoLog =
      statusChamada === "missed" ? "📵 Chamada perdida"
      : statusChamada === "ended" ? `📞 Chamada encerrada (${duracao}s)`
      : "📞 Chamada recebida";

    await conversaRef
      .collection("mensagens").doc(message.id)
      .set({
        id: message.id, sender: "incoming", text: textoLog,
        time: hora, timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

    await conversaRef.set({
      lastMessage: textoLog,
      lastMessageSender: "incoming",
      time: hora,
      lastIncomingAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      unreadCount: admin.firestore.FieldValue.increment(1),
    }, { merge: true });

    if (statusChamada === "missed") {
      await enviarMensagemMeta(token, numeroCliente,
        "Oi! Vi que você tentou nos ligar. Como posso te ajudar? 😊");
    }
  }
}

// ── Atualização de status (entregue, lida, falhou) ───────────────────────────
const { variantesNumero } = require("../lib/util");
const {
  COLECAO_NOTIFICACOES_PEDIDO,
  ESTADOS_NOTIFICACAO,
  TIPO_CANCELAMENTO,
  dadosPendenciaNotificacao,
  idPendenciaNotificacaoCancelamento,
  visaoNotificacaoPedido,
} = require("../services/notificacoesPedido");

async function refletirStatusMetaNaNotificacao({ msgId, statusString, motivoFalha }) {
  const notificacoes = await db().collection(COLECAO_NOTIFICACOES_PEDIDO)
    .where("metaMensagemId", "==", msgId)
    .limit(10)
    .get();
  if (notificacoes.empty) return;

  await Promise.all(notificacoes.docs.map(async (notificacaoDoc) => {
    await db().runTransaction(async (tx) => {
      const jobSnap = await tx.get(notificacaoDoc.ref);
      if (!jobSnap.exists) return;
      const job = jobSnap.data() || {};
      if (job.tipo !== TIPO_CANCELAMENTO) return;

      const falhou = statusString === "failed";
      const pendenciaRef = falhou
        ? db().collection("pendencias").doc(idPendenciaNotificacaoCancelamento(job.pedidoId))
        : null;
      const pendenciaSnap = pendenciaRef ? await tx.get(pendenciaRef) : null;
      const agora = admin.firestore.FieldValue.serverTimestamp();

      const atualizacao = {
        statusMeta: statusString,
        ...(motivoFalha ? { motivoStatusMeta: String(motivoFalha).slice(0, 1000) } : {}),
        statusMetaAtualizadoEm: agora,
      };
      if (falhou && job.estado === ESTADOS_NOTIFICACAO.ACEITO_PELA_META) {
        atualizacao.estado = ESTADOS_NOTIFICACAO.FALHOU;
        atualizacao.motivo = motivoFalha || "A Meta informou falha ao entregar o aviso de cancelamento.";
        atualizacao.falhouEm = agora;
      }
      tx.set(notificacaoDoc.ref, atualizacao, { merge: true });

      if (falhou && job.estado === ESTADOS_NOTIFICACAO.ACEITO_PELA_META) {
        tx.set(db().collection("pedidos").doc(String(job.pedidoId)), {
          notificacao_cancelamento: {
            ...visaoNotificacaoPedido({
              id: notificacaoDoc.id,
              estado: ESTADOS_NOTIFICACAO.FALHOU,
              motivo: atualizacao.motivo,
              msgId,
              tentativa: job.tentativas,
            }),
            atualizadaEm: agora,
          },
        }, { merge: true });
      }

      if (falhou && (!pendenciaSnap?.exists || pendenciaSnap.data()?.resolvida !== true)) {
        tx.set(pendenciaRef, {
          ...dadosPendenciaNotificacao({
            pedidoId: job.pedidoId,
            notificacaoId: notificacaoDoc.id,
            estado: ESTADOS_NOTIFICACAO.FALHOU,
            motivo: motivoFalha || "A Meta informou falha ao entregar o aviso de cancelamento.",
            agora: horaAtualSP(),
          }),
          criadaEmTimestamp: agora,
          atualizadaEm: agora,
        }, { merge: true });
      }
    });
  }));
}

async function tratarStatusMensagem(statusObj) {
  const msgId = statusObj.id;
  const statusString = statusObj.status;

  // A Meta manda o motivo real da falha em statusObj.errors[0] (ex.: número
  // inválido, janela de 24h fechada, mensagem bloqueada) — antes isso só era
  // logado no console e descartado; agora persiste no doc pro painel mostrar.
  const detalheErro = statusObj.errors?.[0];
  const motivoFalha = detalheErro
    ? (detalheErro.title || detalheErro.error_data?.details || detalheErro.message || `Erro ${detalheErro.code}`)
    : null;

  if (statusString === "failed") {
    console.error("Status FAILED completo:", JSON.stringify(statusObj, null, 2));
  }

  const variantes = [...variantesNumero(statusObj.recipient_id)];
  const batch = db().batch();
  variantes.forEach((phone) => {
    batch.set(
      db().collection("conversas").doc(phone).collection("mensagens").doc(msgId),
      { status: statusString, ...(motivoFalha ? { erro: motivoFalha } : {}) }, { merge: true }
    );
    batch.set(
      db().collection("conversas").doc(phone),
      { lastMessageStatus: statusString }, { merge: true }
    );
  });
  await batch.commit();

  // Guarda o callback mesmo se ele chegar antes de o worker conseguir gravar
  // o ID no job. O worker consulta esse documento ao finalizar o aceite.
  await db().collection("status_meta_saida").doc(idDocSeguro(msgId)).set({
    status: statusString,
    recipientId: statusObj.recipient_id || null,
    ...(motivoFalha ? { motivo: String(motivoFalha).slice(0, 1000) } : {}),
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await refletirStatusMetaNaNotificacao({ msgId, statusString, motivoFalha });
}

module.exports = { webhookWhatsApp, processarEventoMeta, tratarStatusMensagem };
