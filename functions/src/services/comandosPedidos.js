// ============================================================================
// DECISÕES PURAS DE COMANDOS DE PEDIDO
//
// Estas funções não fazem I/O. O endpoint usa a decisão DENTRO de uma
// transação Firestore, para que um retry do navegador ou dois operadores não
// gerem dois cancelamentos nem dois efeitos externos.
// ============================================================================

const STATUS_CANCELADO = 4;
const STATUS_CANCELAVEIS_PELO_PAINEL = new Set([1, 2]);

function normalizarIdPedido(valor) {
  const id = String(valor ?? "").trim();
  // O documento de pedido é endereçado pelo próprio ID. Não aceitar barra ou
  // caminho composto evita que o payload escolha outra coleção/documento.
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return null;
  return id;
}

// Uma atualização atrasada do parceiro não pode reabrir um cancelamento já
// confirmado e auditado pelo sistema. Reativação, quando existir, precisa de
// outro comando explícito, não de um merge genérico de webhook.
function devePreservarCancelamento(statusAtual, statusRecebido) {
  return Number(statusAtual) === STATUS_CANCELADO && Number(statusRecebido) !== STATUS_CANCELADO;
}

function decidirCancelamento(pedido) {
  if (!pedido || typeof pedido !== "object") {
    return {
      encontrado: false, deveAtualizar: false, jaCancelado: false,
      permitido: false, motivo: "PEDIDO_NAO_ENCONTRADO", pixConfirmado: false,
    };
  }

  const jaCancelado = Number(pedido.status) === STATUS_CANCELADO;
  const origem = String(pedido.origem || "").trim().toLowerCase();
  const status = Number(pedido.status);
  // Esta é a mesma política da interface: apenas pedidos criados pelo App
  // Cliente, antes de ficarem prontos/em rota. A verificação vive aqui, no
  // servidor, porque alguém pode chamar a API sem passar pelo botão da tela.
  const permitido = origem === "app" && STATUS_CANCELAVEIS_PELO_PAINEL.has(status);
  return {
    encontrado: true,
    deveAtualizar: permitido && !jaCancelado,
    jaCancelado,
    permitido: jaCancelado || permitido,
    motivo: jaCancelado
      ? "PEDIDO_JA_CANCELADO"
      : permitido
        ? null
        : origem !== "app"
          ? "ORIGEM_NAO_SUPORTADA"
          : "STATUS_NAO_CANCELAVEL",
    // A tela usa isso apenas para orientar o operador. Não é um estorno e
    // jamais dispara chamada ao Asaas dentro da transação.
    pixConfirmado: pedido.pix_confirmado === true || String(pedido.pix_status || "").toUpperCase() === "RECEIVED",
  };
}

module.exports = {
  STATUS_CANCELADO,
  STATUS_CANCELAVEIS_PELO_PAINEL,
  normalizarIdPedido,
  devePreservarCancelamento,
  decidirCancelamento,
};
