// ============================================================================
// LOGIN DO APP CLIENTE — CÓDIGO VIA WHATSAPP
// Diferente de src/api/ (painel, já autenticado) e src/webhooks/ (assinado
// por terceiro confiável), este módulo é chamado por QUALQUER pessoa antes
// de existir qualquer sessão — a única defesa de origem é o App Check.
//
// Fluxo:
//   1. solicitarLoginWhatsApp: gera um código de 6 dígitos, guarda só o HASH
//      (HMAC) em login_otps/{telefone} com expiração e limites de uso, e
//      envia por WhatsApp (template de Autenticação aprovado na Meta).
//   2. validarLoginWhatsApp: confere o código contra o hash, cria/atualiza
//      clientes/{uid} e devolve um custom token do Firebase Auth.
//
// O código NUNCA é gravado em texto puro — mesmo que uma regra do Firestore
// seja configurada errada amanhã, o pior vazamento possível é o hash.
// ============================================================================

const crypto = require("crypto");
const admin  = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

const { TOKEN_META, OTP_HMAC_SECRET, PHONE_ID } = require("../config");
const { comparaSegura } = require("../lib/seguranca");
const { normalizarTelefone } = require("../lib/util");
const { graphPost } = require("../services/meta");

const db = () => admin.firestore();

const EXPIRACAO_MS       = 5 * 60 * 1000;   // 5 min
const COOLDOWN_REENVIO_MS = 60 * 1000;      // 60s entre pedidos de código
const MAX_ENVIOS_POR_HORA = 5;
const MAX_TENTATIVAS_VALIDACAO = 5;

const emulador = () => process.env.FUNCTIONS_EMULATOR === "true";

function gerarCodigo() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCodigo(telefone, codigo, segredo) {
  // Telefone entra no HMAC para que o mesmo código de 6 dígitos gere hashes
  // diferentes por número — sem isso, dois clientes com o mesmo código
  // teriam o mesmo hash gravado no Firestore.
  return crypto.createHmac("sha256", segredo).update(`${telefone}:${codigo}`).digest("hex");
}

const solicitarLoginWhatsApp = onCall(
  {
    region: "southamerica-east1",
    secrets: [TOKEN_META, OTP_HMAC_SECRET],
    enforceAppCheck: true,
  },
  async (request) => {
    const telefone = normalizarTelefone(request.data?.telefone);
    if (!telefone) {
      throw new HttpsError("invalid-argument", "Telefone inválido.");
    }

    const ref  = db().collection("login_otps").doc(telefone);
    const agora = Date.now();

    const codigoGerado = await db().runTransaction(async (tx) => {
      const snap  = await tx.get(ref);
      const dados = snap.exists ? snap.data() : null;

      if (dados?.ultimoEnvioEm && agora - dados.ultimoEnvioEm.toMillis() < COOLDOWN_REENVIO_MS) {
        throw new HttpsError("resource-exhausted", "Aguarde um pouco antes de pedir um novo código.");
      }

      const envios = (dados?.enviosNaUltimaHora || []).filter(
        (ts) => agora - ts.toMillis() < 60 * 60 * 1000
      );
      if (envios.length >= MAX_ENVIOS_POR_HORA) {
        throw new HttpsError("resource-exhausted", "Muitos pedidos de código. Tente novamente mais tarde.");
      }

      const codigo = gerarCodigo();
      tx.set(ref, {
        codigoHash: hashCodigo(telefone, codigo, OTP_HMAC_SECRET.value()),
        expiraEm: admin.firestore.Timestamp.fromMillis(agora + EXPIRACAO_MS),
        tentativas: 0,
        ultimoEnvioEm: admin.firestore.Timestamp.fromMillis(agora),
        enviosNaUltimaHora: [...envios, admin.firestore.Timestamp.fromMillis(agora)],
      });

      return codigo;
    });

    if (emulador()) {
      console.log(`[solicitarLoginWhatsApp][EMULADOR] Código para ${telefone}: ${codigoGerado}`);
    } else {
      try {
        // Chamada direta à Graph API (graphPost), SEM passar por enviarTemplate:
        // enviarTemplate grava o texto enviado em conversas/{telefone}/mensagens
        // (o inbox de suporte que qualquer operador do painel enxerga) — um
        // código de login em texto puro não pode parar lá.
        await graphPost(TOKEN_META.value(), `${PHONE_ID}/messages`, {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: telefone,
          type: "template",
          template: {
            name: "login_codigo_verificacao",
            language: { code: "pt_BR" },
            components: [
              { type: "body", parameters: [{ type: "text", text: codigoGerado }] },
              {
                // O botão "Copiar código" do template é implementado pela Meta
                // como um botão de URL dinâmica — confirmado pelo erro #132018
                // ("Button at index 0 must be of type Url") na primeira tentativa.
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [{ type: "text", text: codigoGerado }],
              },
            ],
          },
        });
      } catch (erro) {
        // Erro do axios trunca em profundidade no log padrão (vira "[Object]")
        // — igual ao resto do código, loga o corpo da resposta em JSON puro.
        console.error(
          `[solicitarLoginWhatsApp] Falha ao enviar template para ${telefone}:`,
          JSON.stringify(erro.response?.data ?? erro.message)
        );
        throw new HttpsError("internal", "Erro ao enviar código pelo WhatsApp.");
      }
    }

    // Nunca revela se o número já é cliente — resposta sempre igual.
    return { ok: true };
  }
);

const validarLoginWhatsApp = onCall(
  {
    region: "southamerica-east1",
    secrets: [TOKEN_META, OTP_HMAC_SECRET],
    enforceAppCheck: true,
  },
  async (request) => {
    const telefone = normalizarTelefone(request.data?.telefone);
    const codigo   = String(request.data?.codigo || "").trim();
    if (!telefone || !/^\d{6}$/.test(codigo)) {
      throw new HttpsError("invalid-argument", "Telefone ou código inválido.");
    }

    const ref = db().collection("login_otps").doc(telefone);
    const uid = `cliente_${telefone}`;
    const clienteRef = db().collection("clientes").doc(uid);

    await db().runTransaction(async (tx) => {
      // Regra do Firestore: todas as leituras antes de qualquer escrita.
      const snap = await tx.get(ref);
      const clienteSnap = await tx.get(clienteRef);

      if (!snap.exists) {
        throw new HttpsError("failed-precondition", "Código incorreto ou expirado.");
      }
      const dados = snap.data();

      if (Date.now() > dados.expiraEm.toMillis()) {
        tx.delete(ref);
        throw new HttpsError("failed-precondition", "Código incorreto ou expirado.");
      }

      if ((dados.tentativas || 0) >= MAX_TENTATIVAS_VALIDACAO) {
        tx.delete(ref);
        throw new HttpsError("resource-exhausted", "Muitas tentativas. Peça um novo código.");
      }

      const hashRecebido = hashCodigo(telefone, codigo, OTP_HMAC_SECRET.value());
      if (!comparaSegura(hashRecebido, dados.codigoHash)) {
        tx.update(ref, { tentativas: (dados.tentativas || 0) + 1 });
        throw new HttpsError("failed-precondition", "Código incorreto ou expirado.");
      }

      // Código correto e de uso único — remove antes de qualquer outra coisa.
      tx.delete(ref);

      tx.set(
        clienteRef,
        {
          telefone,
          ultimoLoginEm: admin.firestore.FieldValue.serverTimestamp(),
          ...(clienteSnap.exists ? {} : { criadoEm: admin.firestore.FieldValue.serverTimestamp() }),
        },
        { merge: true }
      );
    });

    const token = await admin.auth().createCustomToken(uid);
    return { token };
  }
);

module.exports = { solicitarLoginWhatsApp, validarLoginWhatsApp };
