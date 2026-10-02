const crypto = require("crypto");

function normalizarParaHash(valor) {
  if (Array.isArray(valor)) return valor.map(normalizarParaHash);
  if (valor && typeof valor === "object") {
    return Object.keys(valor)
      .sort()
      .reduce((resultado, chave) => {
        if (valor[chave] !== undefined) {
          resultado[chave] = normalizarParaHash(valor[chave]);
        }
        return resultado;
      }, {});
  }
  return valor;
}

function gerarHashCheckout(payload) {
  const semChave = { ...(payload || {}) };
  delete semChave.idempotencyKey;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizarParaHash(semChave)))
    .digest("hex");
}

function timestampEmMillis(valor) {
  if (typeof valor?.toMillis === "function") return valor.toMillis();
  if (typeof valor === "number") return valor;
  return 0;
}

function decidirReivindicacao(registro, { uid, payloadHash, agoraMs }) {
  if (!registro) return { acao: "criar" };
  if (registro.uid && registro.uid !== uid) return { acao: "recusar_usuario" };
  if (registro.payloadHash && registro.payloadHash !== payloadHash) {
    return { acao: "recusar_conteudo" };
  }
  if (registro.estado === "concluido" && registro.resultado) {
    return { acao: "retornar", resultado: registro.resultado };
  }

  const leaseAteMs = timestampEmMillis(registro.leaseAte);
  if (registro.estado === "processando" && leaseAteMs > agoraMs) {
    return { acao: "aguardar", leaseAteMs };
  }
  return { acao: "retomar", pedidoId: registro.pedidoId || null };
}

function resultadoDoPedidoPersistido(orderId, pedido) {
  if (!pedido || Number(pedido.status) < 2) return null;

  const ehPix = Array.isArray(pedido.forma_pagamento) &&
    pedido.forma_pagamento.map(String).includes("17");
  if (ehPix && (!pedido.pix_qrcode_base64 || !pedido.pix_copia_cola)) return null;

  return {
    orderId,
    pix: ehPix
      ? {
          qrCodeBase64: pedido.pix_qrcode_base64,
          copiaCola: pedido.pix_copia_cola,
        }
      : null,
    numeroPedidoCliente: pedido.numero_pedido_cliente || null,
  };
}

const STATUS_PIX_COM_FATO_FINANCEIRO = new Set([
  "RECEIVED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "REFUND_IN_PROGRESS",
  "REFUND_REQUESTED",
]);

// O webhook financeiro pode chegar antes de o checkout receber o QR. A
// transação que conclui o QR é repetida pelo Firestore se isso acontecer;
// nesta segunda leitura, ela deve acrescentar o QR sem rebaixar um fato
// financeiro já registrado para PENDING.
function montarConclusaoQrPix({ pedido, paymentId, qrCode }) {
  const statusPixAtual = String(pedido?.pix_status || "").trim().toUpperCase();
  const preservarEstadoFinanceiro =
    pedido?.pix_confirmado === true || STATUS_PIX_COM_FATO_FINANCEIRO.has(statusPixAtual);
  const statusOperacional = Number(pedido?.status);

  const atualizacao = {
    // Criar o QR significa apenas que existe uma cobrança aguardando o cliente.
    // A promoção para 2 pertence ao webhook/reconciliador que comprovou o
    // recebimento. Se o webhook venceu a corrida, preservamos o 2 já gravado;
    // caso contrário o pedido continua em 1 e aparece em "Aguardando PIX".
    status: Number.isFinite(statusOperacional) ? statusOperacional : 1,
    pix_pagamento_id: paymentId,
    pix_qrcode_base64: qrCode.qrCodeBase64,
    pix_copia_cola: qrCode.copiaCola,
    pix_checkout_pendente: false,
  };

  if (!preservarEstadoFinanceiro) {
    atualizacao.pix_confirmado = false;
    atualizacao.pix_status = "PENDING";
    atualizacao.pix_auditoria_etapa = -1;
  }

  return {
    atualizacao,
    deveAgendarVerificacaoInicial: !preservarEstadoFinanceiro,
  };
}

function erroAsaasEhDefinitivo(erro) {
  if (erro?.resultadoInconclusivo === true) return false;
  const status = Number(erro?.response?.status);
  if (!Number.isInteger(status) || status < 400 || status >= 500) return false;
  return ![408, 409, 425, 429].includes(status);
}

module.exports = {
  gerarHashCheckout,
  decidirReivindicacao,
  resultadoDoPedidoPersistido,
  montarConclusaoQrPix,
  erroAsaasEhDefinitivo,
};
