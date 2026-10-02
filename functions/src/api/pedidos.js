// ============================================================================
// API — comandos sensíveis de pedidos
//
// O browser não troca mais um status crítico diretamente. Cada comando passa
// por sessão revogável, capacidade, transação, idempotência do estado e uma
// trilha de auditoria append-only.
// ============================================================================

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const { ORIGENS_PAINEL } = require("../config");
const { exigirPainel } = require("../lib/seguranca");
const { exigirCapacidadePainel } = require("../lib/permissoesPainel");
const { normalizarIdPedido } = require("../services/comandosPedidos");
const { executarCancelamento } = require("../services/operacoesPedidos");

const db = () => admin.firestore();

async function cancelar({ orderId }, res, operador, decisaoPermissao) {
  const pedidoId = normalizarIdPedido(orderId);
  if (!pedidoId) return res.status(400).json({ error: "Identificador do pedido inválido." });

  const resultado = await executarCancelamento({
    db: db(),
    FieldValue: admin.firestore.FieldValue,
    pedidoId,
    operador,
    decisaoPermissao,
  });

  if (!resultado.encontrado) return res.status(404).json({ error: "Pedido não encontrado." });
  if (!resultado.permitido) {
    return res.status(409).json({
      error: "Este pedido não pode mais ser cancelado por aqui.",
      codigo: resultado.motivo || "CANCELAMENTO_NAO_PERMITIDO",
    });
  }
  return res.status(200).json({
    success: true,
    pedidoId,
    jaCancelado: resultado.jaCancelado,
    pixConfirmado: resultado.pixConfirmado,
    notificacaoId: resultado.notificacaoId || null,
    notificacaoEstado: resultado.notificacaoEstado || null,
  });
}

const acoesPedidos = Object.freeze({ cancelar });

const pedidos = onRequest(
  { cors: ORIGENS_PAINEL, memory: "256MiB", cpu: 1 },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Método não permitido");
    const operador = await exigirPainel(req, res);
    if (!operador) return;

    const { action } = req.body || {};
    if (typeof action !== "string" || !Object.hasOwn(acoesPedidos, action)) {
      return res.status(400).json({ error: "Ação desconhecida." });
    }
    const handler = acoesPedidos[action];

    const capacidadesPorAcao = { cancelar: "pedidos.cancelar" };
    const decisaoPermissao = exigirCapacidadePainel(
      res,
      operador,
      capacidadesPorAcao[action]
    );
    if (!decisaoPermissao) return;

    try {
      return await handler(req.body, res, operador, decisaoPermissao);
    } catch (erro) {
      console.error(`[pedidos/${action}] erro:`, erro.message);
      return res.status(500).json({ error: "Não foi possível concluir a ação no pedido." });
    }
  }
);

module.exports = { pedidos, cancelar };
