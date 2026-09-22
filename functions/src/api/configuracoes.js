// ============================================================================
// API — configuracoes + pendencias (painel)
// Autenticadas, CORS restrito, handlers organizados em mapa.
// ============================================================================

const { onRequest } = require("firebase-functions/v2/https");
const admin         = require("firebase-admin");

const { ORIGENS_PAINEL } = require("../config");
const { exigirPainel } = require("../lib/seguranca");
const { horaAtualSP }  = require("../lib/util");

const db = () => admin.firestore();

// ─────────────────────────────────────────────────────────────────────────────
// configuracoes
// ─────────────────────────────────────────────────────────────────────────────
const acoesConfiguracoes = {
  async salvarFrases({ frases }, res) {
    if (!Array.isArray(frases)) return res.status(400).send("Dados inválidos");
    await db().collection("configuracoes").doc("frases").set({ frases });
    return res.status(200).json({ success: true });
  },

  async reabrirConversa({ telefone }, res) {
    if (!telefone) return res.status(400).send("Falta telefone");
    await db().collection("conversas").doc(telefone).set({ finalizado: false }, { merge: true });
    return res.status(200).json({ success: true });
  },

  async finalizarConversa({ telefone }, res) {
    if (!telefone) return res.status(400).send("Falta telefone");
    await db().collection("conversas").doc(telefone).set({ finalizado: true }, { merge: true });
    return res.status(200).json({ success: true });
  },

  async salvarTags({ tags }, res) {
    if (!Array.isArray(tags)) return res.status(400).send("Dados inválidos");
    await db().collection("configuracoes").doc("tags").set({ tags });
    return res.status(200).json({ success: true });
  },

  async aplicarTags({ telefone, tags }, res) {
    if (!telefone || !Array.isArray(tags)) return res.status(400).send("Dados inválidos");
    await db().collection("conversas").doc(telefone).set({ tags }, { merge: true });
    return res.status(200).json({ success: true });
  },

  async fixarConversa({ telefone, pinned }, res) {
    if (!telefone || pinned === undefined) return res.status(400).send("Dados inválidos");
    await db().collection("conversas").doc(telefone).set({ pinned }, { merge: true });
    return res.status(200).json({ success: true });
  },

  async editarNomeCliente({ telefone, nome }, res) {
    if (!telefone || !nome?.trim()) return res.status(400).send("Dados inválidos");
    // Marca como edição manual para o próximo pedido não sobrescrever essa escolha.
    await db().collection("conversas").doc(telefone).set({ clientName: nome.trim(), nomeClienteManual: true }, { merge: true });
    return res.status(200).json({ success: true });
  },

  async excluirConversa({ telefone }, res) {
    if (!telefone) return res.status(400).send("Falta telefone");
    await db().recursiveDelete(db().collection("conversas").doc(telefone));
    return res.status(200).json({ success: true });
  },
};

const configuracoes = onRequest(
  // Não omitir secrets: isso preservaria vínculos antigos no Cloud Functions.
  { cors: ORIGENS_PAINEL, secrets: [], memory: "256MiB", cpu: 1 },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Método não permitido");
    if (!(await exigirPainel(req, res))) return;

    const { action } = req.body;
    const handler = acoesConfiguracoes[action];
    if (!handler) return res.status(400).json({ error: `Action desconhecida: ${action}` });

    try {
      return await handler(req.body, res);
    } catch (error) {
      console.error(`[configuracoes/${action}] Erro:`, error.message);
      return res.status(500).json({ error: "Erro interno" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// pendencias
// ─────────────────────────────────────────────────────────────────────────────
const acoesPendencias = {
  async listar(_dados, res) {
    const snap = await db().collection("pendencias")
      .orderBy("criadaEmTimestamp", "desc").limit(500).get();
    const pendencias = snap.docs.map((d) => {
      const p = d.data();
      return {
        id: d.id, chatId: p.chatId, tipo: p.tipo,
        descricao: p.descricao, resolvida: !!p.resolvida, criadaEm: p.criadaEm || "",
      };
    });
    return res.status(200).json({ pendencias });
  },

  async adicionar({ chatId, tipo, descricao, idempotencyKey }, res) {
    if (!chatId || !tipo || !descricao?.trim()) {
      return res.status(400).json({ error: "Dados inválidos" });
    }

    // Mesmo mecanismo já usado em api/chat.js: apiFetch reenvia sozinho em
    // timeout/5xx, e sem chave de idempotência isso podia criar a mesma
    // pendência duas vezes num reenvio automático.
    const idempotencyRef = idempotencyKey
      ? db().collection("_idempotency").doc(idempotencyKey)
      : null;

    if (idempotencyRef) {
      try {
        await idempotencyRef.create({
          estado: "criando",
          criadoEm: admin.firestore.FieldValue.serverTimestamp(),
          expiraEm: admin.firestore.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
        });
      } catch (e) {
        if (e.code === 6 /* ALREADY_EXISTS */) {
          const existente = (await idempotencyRef.get()).data();
          if (existente?.estado === "criada") {
            return res.status(200).json({ success: true, id: existente.pendenciaId, duplicate: true });
          }
          // "criando" (corrida rara) ou "falhou" (tentativa anterior não
          // completou) — deixa tentar de novo abaixo.
        } else {
          throw e;
        }
      }
    }

    let novoDoc;
    try {
      novoDoc = await db().collection("pendencias").add({
        chatId, tipo,
        descricao: descricao.trim(),
        resolvida: false,
        criadaEm: horaAtualSP(),
        criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (erroCriacao) {
      if (idempotencyRef) await idempotencyRef.set({ estado: "falhou" }, { merge: true });
      throw erroCriacao;
    }

    if (idempotencyRef) {
      await idempotencyRef.set({ estado: "criada", pendenciaId: novoDoc.id }, { merge: true });
    }
    return res.status(200).json({ success: true, id: novoDoc.id });
  },

  async resolver({ id }, res) {
    if (!id) return res.status(400).json({ error: "Falta id" });
    await db().collection("pendencias").doc(id).set({
      resolvida: true,
      resolvidaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return res.status(200).json({ success: true });
  },

  async reabrir({ id }, res) {
    if (!id) return res.status(400).json({ error: "Falta id" });
    await db().collection("pendencias").doc(id).set({ resolvida: false }, { merge: true });
    return res.status(200).json({ success: true });
  },

  async excluir({ id }, res) {
    if (!id) return res.status(400).json({ error: "Falta id" });
    await db().collection("pendencias").doc(id).delete();
    return res.status(200).json({ success: true });
  },
};

const pendencias = onRequest(
  { cors: ORIGENS_PAINEL, secrets: [], memory: "256MiB", cpu: 1 },
  async (req, res) => {
    if (!(await exigirPainel(req, res))) return;

    const dados = req.method === "GET" ? req.query : req.body;
    const { action } = dados;
    const handler = acoesPendencias[action];
    if (!handler) return res.status(400).json({ error: `Action desconhecida: ${action}` });

    // Mutação só via POST
    if (action !== "listar" && req.method !== "POST") {
      return res.status(405).send("Método não permitido");
    }

    try {
      return await handler(dados, res);
    } catch (error) {
      console.error(`[pendencias/${action}] Erro:`, error.message);
      return res.status(500).json({ error: "Erro interno" });
    }
  }
);

module.exports = { configuracoes, pendencias };
