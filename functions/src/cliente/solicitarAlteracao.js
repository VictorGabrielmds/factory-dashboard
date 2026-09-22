// ============================================================================
// SOLICITAÇÃO DE ALTERAÇÃO — App Cliente
// Em vez do cliente abrir o próprio WhatsApp e mandar uma mensagem manual
// (fluxo antigo, via wa.me), esta function injeta a solicitação DIRETO na
// conversa do painel, no mesmo formato que tratarMensagemRecebida grava pra
// uma mensagem recebida de verdade (webhooks/whatsapp.js) — some aparece pro
// time exatamente como se o cliente tivesse mandado, sem nenhuma mensagem
// real do WhatsApp ser enviada. O campo isAlteracao marca a mensagem pro
// painel mostrar o indicador visual "!" e diferenciar de uma mensagem digitada
// de verdade.
// ============================================================================

const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { resolverConversaRef } = require("../lib/conversas");
const { horaAtualSP } = require("../lib/util");

const db = () => admin.firestore();

// Mesmo conjunto usado no app cliente (CarrinhoContext.tsx,
// STATUS_PEDIDO_NAO_ENTREGUE) — duplicado aqui porque Cloud Functions não
// importam entre os dois repositórios.
const STATUS_PEDIDO_NAO_ENTREGUE = new Set([1, 2]);
const MAX_ITENS = 50;
const MAX_OBSERVACOES = 500;

const solicitarAlteracao = onCall(
  { region: "southamerica-east1", enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Faça login para solicitar uma alteração.");
    }
    const uid = request.auth.uid;
    const {
      orderId, idempotencyKey, itensAdicionar, itensRemoverIndices, trocarEntrega, novoEndereco, observacoes,
    } = request.data || {};

    if (typeof orderId !== "string" || !orderId) {
      throw new HttpsError("invalid-argument", "Pedido inválido.");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 10) {
      throw new HttpsError("invalid-argument", "Requisição inválida — atualize o app e tente novamente.");
    }

    // ── Idempotência: mesmo padrão/coleção já usado por criarPedido ─────────
    const idempotencyRef = db().collection("_idempotency").doc(idempotencyKey);
    try {
      await idempotencyRef.create({
        estado: "processando",
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        expiraEm: admin.firestore.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      });
    } catch (e) {
      if (e.code !== 6 /* ALREADY_EXISTS */) throw e;

      const existente = (await idempotencyRef.get()).data();
      if (existente?.estado === "concluido") return existente.resultado;
      if (existente?.estado === "processando") {
        throw new HttpsError("already-exists", "Sua solicitação já está sendo processada — aguarde um instante.");
      }
      await idempotencyRef.set(
        { estado: "processando", criadoEm: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }

    try {
      const pedidoRef = db().collection("pedidos").doc(orderId);
      const pedidoSnap = await pedidoRef.get();
      if (!pedidoSnap.exists) {
        throw new HttpsError("not-found", "Pedido não encontrado.");
      }
      const pedido = pedidoSnap.data();

      if (pedido.clienteUid !== uid) {
        throw new HttpsError("permission-denied", "Este pedido não pertence a você.");
      }
      if (!STATUS_PEDIDO_NAO_ENTREGUE.has(Number(pedido.status))) {
        throw new HttpsError("failed-precondition", "Este pedido não pode mais ser alterado.");
      }

      // Nunca confia em telefone vindo do cliente — sempre lido do próprio pedido.
      const telefone = pedido.telefone_destinatario;
      if (!telefone) {
        throw new HttpsError(
          "failed-precondition",
          "Não foi possível localizar sua conversa — entre em contato pela loja."
        );
      }

      // ── Itens a adicionar: valida cada um contra produtos/ de verdade ─────
      const linhasAdicionar = [];
      if (Array.isArray(itensAdicionar)) {
        if (itensAdicionar.length > MAX_ITENS) {
          throw new HttpsError("invalid-argument", "Muitos itens.");
        }
        for (const item of itensAdicionar) {
          const produtoId = String(item?.produtoId || "");
          const quantidade = Number(item?.quantidade);
          if (!produtoId || !Number.isInteger(quantidade) || quantidade <= 0 || quantidade > 100) continue;
          const produtoSnap = await db().collection("produtos").doc(produtoId).get();
          if (produtoSnap.exists) {
            linhasAdicionar.push(`- ${quantidade}x ${produtoSnap.data().nome}`);
          }
        }
      }

      // ── Itens a remover: valida índices contra o pedido de verdade ────────
      const descricaoItem = pedido.descricao_item || [];
      const quantidadeItem = pedido.quantidade_item || [];
      const linhasRemover = [];
      if (Array.isArray(itensRemoverIndices)) {
        const indicesUnicos = [...new Set(itensRemoverIndices.map(Number))]
          .filter((i) => Number.isInteger(i) && i >= 0 && i < descricaoItem.length)
          .sort((a, b) => a - b);
        for (const i of indicesUnicos) {
          linhasRemover.push(`- ${quantidadeItem[i]}x ${descricaoItem[i]}`);
        }
      }

      // ── Troca de tipo de entrega: sempre o OPOSTO do atual, decidido aqui ─
      const tipoEntregaAtual = pedido.tipo_entrega === "delivery" ? "delivery" : "retirada";
      const tipoEntregaOposto = tipoEntregaAtual === "delivery" ? "retirada" : "delivery";
      let linhaTroca = null;
      if (trocarEntrega === true) {
        if (tipoEntregaOposto === "delivery") {
          const endereco = novoEndereco || {};
          const partes = [
            [String(endereco.logradouro || "").trim(), String(endereco.numero || "").trim()]
              .filter(Boolean)
              .join(", "),
            String(endereco.complemento || "").trim(),
            String(endereco.bairro || "").trim(),
          ].filter(Boolean);
          linhaTroca = `🔄 Mudar para: Delivery — ${partes.join(" — ") || "(endereço a combinar)"}`;
        } else {
          linhaTroca = "🔄 Mudar para: Retirada no balcão";
        }
      }

      const observacoesLimpa = String(observacoes || "").trim().slice(0, MAX_OBSERVACOES);

      if (linhasAdicionar.length === 0 && linhasRemover.length === 0 && !linhaTroca && !observacoesLimpa) {
        throw new HttpsError("invalid-argument", "Nenhuma alteração informada.");
      }

      const linhas = [
        `Olá! Gostaria de alterar meu pedido #${orderId}${pedido.agendamento ? ` (${pedido.agendamento})` : ""}:`,
        "",
      ];
      if (linhasAdicionar.length) linhas.push("➕ Adicionar:", ...linhasAdicionar, "");
      if (linhasRemover.length) linhas.push("➖ Remover:", ...linhasRemover, "");
      if (linhaTroca) linhas.push(linhaTroca, "");
      if (observacoesLimpa) linhas.push(`📝 Observações: ${observacoesLimpa}`, "");
      linhas.push("Pode me ajudar com isso?");
      const mensagemTexto = linhas.join("\n");

      const conversaRef = await resolverConversaRef(telefone);
      if (!conversaRef) {
        console.error(`[solicitarAlteracao] Telefone não normalizável no pedido ${orderId}: ${telefone}`);
        throw new HttpsError(
          "failed-precondition",
          "Não foi possível localizar sua conversa — entre em contato pela loja."
        );
      }

      const conversaSnap = await conversaRef.get();
      const jaExiste = conversaSnap.exists;
      const hora = horaAtualSP();
      const msgId = `alteracao_${orderId}_${Date.now()}`;

      const batch = db().batch();
      batch.set(conversaRef.collection("mensagens").doc(msgId), {
        id: msgId,
        sender: "incoming",
        text: mensagemTexto,
        time: hora,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        // Marca a mensagem como uma solicitação automática (não digitada de
        // verdade pelo cliente) — o painel usa isso pro indicador visual "!".
        isAlteracao: true,
        orderIdReferencia: orderId,
      });
      batch.set(
        conversaRef,
        {
          phone: conversaRef.id,
          ...(jaExiste ? {} : { clientName: pedido.nome_destinatario || "" }),
          lastMessage: "⚠️ Solicitação de alteração",
          lastMessageIsAlteracao: true,
          lastIncomingMessageId: msgId,
          lastIncomingAt: admin.firestore.FieldValue.serverTimestamp(),
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
          time: hora,
          unreadCount: admin.firestore.FieldValue.increment(1),
          isOnline: true,
          ...(jaExiste ? {} : { criadoEm: admin.firestore.FieldValue.serverTimestamp(), tags: [] }),
          lastMessageSender: "incoming",
        },
        { merge: true }
      );
      await batch.commit();

      // Push pro operador — mesma lógica best-effort de webhooks/whatsapp.js;
      // falha aqui não pode derrubar a solicitação, que já foi gravada.
      try {
        const configDoc = await db().collection("configuracoes").doc("notificacoes").get();
        if (configDoc.exists && configDoc.data().tokenAdmin) {
          await admin.messaging().send({
            token: configDoc.data().tokenAdmin,
            data: {
              title: `Solicitação de alteração — ${pedido.nome_destinatario || "Cliente"}`,
              body: mensagemTexto,
              chatId: conversaRef.id,
            },
          });
        }
      } catch (erroPush) {
        console.error("[solicitarAlteracao] Falha ao enviar notificação push:", erroPush.message);
      }

      const resultado = { sucesso: true };
      await idempotencyRef.set(
        { estado: "concluido", resultado, concluidoEm: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      return resultado;
    } catch (erro) {
      await idempotencyRef.set({ estado: "falhou" }, { merge: true }).catch(() => {
        // Falha ao marcar não pode mascarar o erro original abaixo.
      });
      throw erro;
    }
  }
);

module.exports = { solicitarAlteracao };
