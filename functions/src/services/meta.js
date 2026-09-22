// ============================================================================
// SERVIÇO META (WhatsApp Business Cloud API)
// Toda comunicação com a Graph API passa por aqui: timeout + retry + log.
// O token vem por parâmetro (lido do Secret Manager dentro da function).
// ============================================================================

const admin      = require("firebase-admin");
const os         = require("os");
const path       = require("path");
const fs         = require("fs");
const FormData   = require("form-data");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffmpeg     = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegPath);

const { http, clienteHttp, comRetentativa } = require("../lib/http");
const { GRAPH, PHONE_ID, WABA_ID }          = require("../config");
const { horaAtualSP, extrairLatLng }        = require("../lib/util");
const { resolverConversaRef }               = require("../lib/conversas");

const db      = () => admin.firestore();
const storage = () => admin.storage();

// ── Chamadas base à Graph API (com retry para erros transitórios) ────────────
function graphPost(token, caminho, payload, extraHeaders = {}) {
  return comRetentativa(
    () => http.post(`${GRAPH}/${caminho}`, payload, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders },
    }),
    { rotulo: `POST ${caminho}`, circuito: "meta" }
  );
}

function graphGet(token, caminho, opts = {}) {
  return comRetentativa(
    () => http.get(`${GRAPH}/${caminho}`, {
      headers: { Authorization: `Bearer ${token}` }, ...opts,
    }),
    { rotulo: `GET ${caminho}`, circuito: "meta" }
  );
}

// ── Persistência da mensagem enviada (chat + raiz da conversa) ───────────────
async function registrarSaida(telefone, msgId, texto, { mediaUrl, mediaType, replyToMsgId, nomeCliente, clientId } = {}) {
  const hora = horaAtualSP();

  // Reaproveita a conversa já existente do contato (pode ter sido criada com
  // um formato de número diferente) em vez de sempre gravar no ID cru
  // recebido — é isso que evitava (ou não) criar uma conversa duplicada.
  const conversaRef = await resolverConversaRef(telefone);
  if (!conversaRef) {
    console.error(`[registrarSaida] Telefone inválido, não é possível registrar a mensagem: "${telefone}"`);
    return;
  }

  // O nome do cliente já é mantido pelo nome do último pedido (ver
  // atualizarFichaCliente) ou por edição manual do operador. Só define aqui
  // se o contato ainda não tiver nenhum nome — nunca sobrescreve o que já existe.
  let definirNomeAqui = false;
  if (nomeCliente) {
    const snap = await conversaRef.get();
    definirNomeAqui = !snap.data()?.clientName;
  }

  const batch = db().batch();

  batch.set(
    conversaRef.collection("mensagens").doc(msgId),
    {
      id: msgId,
      sender: "outgoing",
      text: texto,
      time: hora,
      status: "sent",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ...(mediaUrl ? { mediaUrl, mediaType } : {}),
      ...(replyToMsgId ? { replyTo: replyToMsgId } : {}),
      ...(clientId ? { clientId } : {}),
    }
  );

  batch.set(
    conversaRef,
    {
      ...(definirNomeAqui ? { clientName: nomeCliente } : {}),
      phone: conversaRef.id,
      lastMessage: texto,
      time: hora,
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMessageSender: "outgoing",
      lastMessageStatus: "sent",
    },
    { merge: true }
  );

  await batch.commit();
}

// ── Mídia recebida do cliente → Storage → URL assinada ───────────────────────
async function descarregarMidiaMeta(token, mediaId, mimeType) {
  try {
    const resMeta = await graphGet(token, mediaId);
    const urlDownload = resMeta.data.url;

    const resFile = await comRetentativa(
      () => clienteHttp({ timeout: 30000 }).get(urlDownload, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: "arraybuffer",
      }),
      { rotulo: "download mídia", circuito: "meta" }
    );

    let extensao = mimeType.split("/")[1].split(";")[0];
    if (extensao === "webm" && mimeType.startsWith("audio/")) extensao = "ogg";

    const file = storage().bucket().file(`whatsapp_midia/${mediaId}.${extensao}`);
    await file.save(resFile.data, { metadata: { contentType: mimeType } });

    const [urlPublica] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, // 10 anos
    });
    return urlPublica;
  } catch (erro) {
    console.error("Erro ao processar mídia da Meta:", erro.message);
    return null;
  }
}

// ── Áudio do painel (.webm) → .ogg/opus → upload direto na Meta ──────────────
async function processarAudioParaWhatsApp(token, urlAudioWebm) {
  const tmpWebm = path.join(os.tmpdir(), `audio_in_${Date.now()}.webm`);
  const tmpOgg  = path.join(os.tmpdir(), `audio_out_${Date.now()}.ogg`);

  try {
    const response = await comRetentativa(
      () => clienteHttp({ timeout: 30000 }).get(urlAudioWebm, { responseType: "arraybuffer" }),
      { rotulo: "download áudio painel" }
    );
    fs.writeFileSync(tmpWebm, response.data);

    await new Promise((resolve, reject) => {
      ffmpeg(tmpWebm)
        .audioCodec("libopus")
        .format("ogg")
        .on("end", resolve)
        .on("error", (err) => { console.error("FFmpeg falhou:", err.message); reject(err); })
        .save(tmpOgg);
    });
    if (!fs.existsSync(tmpOgg)) throw new Error("FFmpeg falhou: arquivo não existe.");

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", fs.createReadStream(tmpOgg), { contentType: "audio/ogg" });

    const metaRes = await comRetentativa(
      () => clienteHttp({ timeout: 30000 }).post(`${GRAPH}/${PHONE_ID}/media`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
      }),
      { rotulo: "upload áudio Meta", circuito: "meta" }
    );
    return metaRes.data.id;
  } finally {
    if (fs.existsSync(tmpWebm)) fs.unlinkSync(tmpWebm);
    if (fs.existsSync(tmpOgg))  fs.unlinkSync(tmpOgg);
  }
}

// ── Mensagem livre (texto/mídia/localização) ─────────────────────────────────
async function enviarMensagemMeta(token, telefone, texto, mediaUrl = null, mediaType = null, replyToMsgId = null, clientId = null) {
  let payload;
  let metaMediaId = null;

  if (mediaType === "audio" && mediaUrl) {
    metaMediaId = await processarAudioParaWhatsApp(token, mediaUrl);
  }

  if (mediaType === "location" && mediaUrl) {
    const [lat, lng] = extrairLatLng(mediaUrl);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      throw new Error(`Coordenadas de localização inválidas: "${mediaUrl}"`);
    }
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: telefone,
      type: "location",
      ...(replyToMsgId && { context: { message_id: replyToMsgId } }),
      location: { latitude: lat, longitude: lng },
    };
    mediaUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }

  if (!payload && mediaUrl && mediaType && mediaType !== "location") {
    const tipoMedia = ["image", "audio", "video", "document", "sticker"].includes(mediaType) ? mediaType : "image";
    // Figurinha na Cloud API não aceita "caption" — só { id } ou { link }.
    const mediaObject = metaMediaId
      ? { id: metaMediaId }
      : { link: mediaUrl, ...(texto && tipoMedia !== "sticker" ? { caption: texto } : {}) };

    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: telefone,
      type: tipoMedia,
      ...(replyToMsgId && { context: { message_id: replyToMsgId } }),
      [tipoMedia]: mediaObject,
    };
  } else if (!payload) {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: telefone,
      type: "text",
      ...(replyToMsgId && { context: { message_id: replyToMsgId } }),
      text: { body: texto },
    };
  }

  const response = await graphPost(token, `${PHONE_ID}/messages`, payload);
  const msgId  = response.data?.messages?.[0]?.id || `msg_auto_${Date.now()}`;
  const txtLog = texto || (mediaType === "image" ? "📷 Imagem" : mediaType === "sticker" ? "✨ Figurinha" : mediaType === "location" ? "📍 Localização" : "📎 Arquivo");

  await registrarSaida(telefone, msgId, txtLog, { mediaUrl, mediaType, replyToMsgId, clientId });
  return msgId;
}

// ── Template aprovado ────────────────────────────────────────────────────────
async function enviarTemplate(token, telefone, templateName, parameters, nomeCliente = "Cliente", textoPreview = null) {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: telefone,
    type: "template",
    template: {
      name: templateName,
      language: { code: "pt_BR" },
      components: [{ type: "body", parameters }],
    },
  };

  const response = await graphPost(token, `${PHONE_ID}/messages`, payload);
  const msgId = response.data?.messages?.[0]?.id || `msg_auto_${Date.now()}`;
  const textoFinal = textoPreview
    || `🤖 Template enviado: ${templateName}\n[ ${parameters.map((p) => p.text).join(" | ")} ]`;

  await registrarSaida(telefone, msgId, textoFinal, { nomeCliente });
  console.log(`[enviarTemplate] [${templateName}] enviado para ${telefone}`);
  return msgId;
}

// ── Template crítico: uma única tentativa, com confirmação inequívoca ───────
//
// `graphPost` repete POSTs transitórios para conversas comuns. Em um evento
// operacional crítico isso seria perigoso: se a Meta aceitou a mensagem mas a
// resposta se perdeu, repetir pode avisar o cliente duas vezes. Esta função
// chama a Graph API uma vez só e só devolve sucesso se receber o ID real da
// mensagem. Quem a usa deve transformar timeout/rede/5xx em revisão humana,
// nunca em novo envio automático.
async function enviarTemplateConfirmadoUmaVez(
  token,
  telefone,
  templateName,
  parameters,
  { nomeCliente = "Cliente", textoPreview = null, clientId = null } = {}
) {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: telefone,
    type: "template",
    template: {
      name: templateName,
      language: { code: "pt_BR" },
      components: [{ type: "body", parameters }],
    },
  };

  // Intencionalmente não passa por `graphPost` / `comRetentativa`.
  const response = await http.post(`${GRAPH}/${PHONE_ID}/messages`, payload, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const msgId = response.data?.messages?.[0]?.id;
  if (!msgId || typeof msgId !== "string") {
    const erro = new Error("A Meta respondeu sem o identificador da mensagem.");
    erro.metaRespostaIncompleta = true;
    throw erro;
  }

  const textoFinal = textoPreview
    || `🤖 Template enviado: ${templateName}\n[ ${parameters.map((p) => p.text).join(" | ")} ]`;
  let registroChatPendente = null;
  try {
    // O aceite da Meta já aconteceu. Uma falha no espelho do chat não pode
    // parecer falha do envio nem disparar outro POST.
    await registrarSaida(telefone, msgId, textoFinal, { nomeCliente, clientId });
  } catch (erroRegistro) {
    registroChatPendente = String(erroRegistro?.message || "Falha ao registrar a mensagem no chat.").slice(0, 500);
    console.error(
      `[enviarTemplateConfirmadoUmaVez] Meta aceitou ${msgId}, mas o chat não foi registrado:`,
      registroChatPendente,
    );
  }

  return { msgId, registroChatPendente };
}

// ── Utilidades diversas da Graph API ─────────────────────────────────────────
const marcarLida = (token, messageId) =>
  graphPost(token, `${PHONE_ID}/messages`, {
    messaging_product: "whatsapp", status: "read", message_id: messageId,
  });

const enviarDigitando = (token, telefone) =>
  graphPost(token, `${PHONE_ID}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: telefone,
    type: "typing_indicator",
    typing_indicator: { type: "text" },
  });

const buscarTemplates = (token) =>
  graphGet(token, `${WABA_ID}/message_templates?status=APPROVED&limit=50`);

module.exports = {
  enviarMensagemMeta, enviarTemplate, descarregarMidiaMeta,
  processarAudioParaWhatsApp, marcarLida, enviarDigitando,
  buscarTemplates, registrarSaida, graphPost, enviarTemplateConfirmadoUmaVez,
};
