// ============================================================================
// REGRAS PURAS DE CONCILIAÇÃO PIX
//
// Este arquivo não acessa Firestore nem rede. Toda decisão crítica sobre um
// pagamento fica centralizada aqui e pode ser testada sem emulador.
// ============================================================================

const EVENTOS_ASAAS_RELEVANTES = new Set([
  "PAYMENT_RECEIVED",
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
]);

const EVENTOS_ESTORNO = new Set([
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
]);

const STATUS_INSTA_ATIVOS = new Set([1, 2, 3, 5]);
const JANELA_INSTA_MINIMA_MINUTOS = 6 * 60;
const MAX_DIAS_ANTECEDENCIA_CONCILIACAO = 30;
const STATUS_VISIVEIS_NO_PAINEL = new Set([1, 2, 3, 5]);

function parseValor(bruto) {
  if (typeof bruto === "number") return Number.isFinite(bruto) ? bruto : 0;
  let texto = String(bruto ?? "0").trim();
  if (texto.includes(",")) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  }
  const numero = Number.parseFloat(texto);
  return Number.isFinite(numero) ? numero : 0;
}

function paraCentavos(valor) {
  return Math.round(parseValor(valor) * 100);
}

function normalizarStatus(status) {
  return String(status || "").trim().toUpperCase();
}

function extrairCodigosPagamentoSemDependencia(formaPagamento) {
  const itens = Array.isArray(formaPagamento) ? formaPagamento : [formaPagamento];
  return itens
    .flatMap((item) => String(item ?? "").split(/[,+/]/))
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function pedidoEhPix(pedido) {
  return extrairCodigosPagamentoSemDependencia(pedido?.forma_pagamento)
    .some((codigo) => codigo === "17" || codigo.includes("PIX"));
}

/**
 * Pagamento e operação são estados diferentes, mas um pedido criado pelo
 * checkout próprio fica em status 1 apenas enquanto a criação do PIX ainda
 * não terminou. Se o Asaas confirmar antes desse fechamento, promover o
 * pedido junto com a confirmação evita um PIX pago invisível no painel.
 *
 * Pedidos legados/InstaDelivery não são aceitos automaticamente aqui: nesses
 * canais o status operacional continua sendo responsabilidade da origem.
 */
function atualizacaoOperacionalAoConfirmarPix(pedido) {
  if (pedido?.origem === "app" && Number(pedido?.status) === 1) {
    return {
      status: 2,
      status_interno: "aceito",
    };
  }
  return {};
}

function pedidoVisivelNoPainel(pedido) {
  return STATUS_VISIVEIS_NO_PAINEL.has(Number(pedido?.status));
}

function eventoEhRelevante(tipo) {
  return EVENTOS_ASAAS_RELEVANTES.has(normalizarStatus(tipo));
}

function eventoEhEstorno(tipo) {
  return EVENTOS_ESTORNO.has(normalizarStatus(tipo));
}

function statusDoEvento(tipo, pagamento = {}) {
  const evento = normalizarStatus(tipo);
  if (evento === "PAYMENT_REFUNDED") return "REFUNDED";
  if (evento === "PAYMENT_PARTIALLY_REFUNDED") return "PARTIALLY_REFUNDED";
  if (evento === "PAYMENT_REFUND_IN_PROGRESS") return "REFUND_IN_PROGRESS";
  return normalizarStatus(pagamento.status) || "UNKNOWN";
}

/**
 * PIX criado pelo InstaDelivery usa referência genérica (ORDER_PIX), então o
 * vínculo depende também do tempo. A janela acompanha o limite de
 * agendamento configurado no PDV: se a loja aceita pedidos para daqui a 5
 * dias, um PIX desse pedido pode ser pago até cinco dias após a criação.
 *
 * A janela mínima de 6h preserva os pedidos do mesmo dia quando a loja só
 * aceita agendamento para hoje. O teto acompanha o máximo exposto no PDV e
 * impede que uma configuração corrompida transforme a consulta numa busca
 * histórica excessiva.
 */
function calcularJanelaInstaSeguraMinutos(diasAntecedencia) {
  const dias = Math.min(
    Math.max(Math.trunc(Number(diasAntecedencia) || 0), 0),
    MAX_DIAS_ANTECEDENCIA_CONCILIACAO
  );
  return Math.max(JANELA_INSTA_MINIMA_MINUTOS, dias * 24 * 60);
}

function eventoParaStatusConsultado(status) {
  const atual = normalizarStatus(status);
  if (atual === "RECEIVED") return "PAYMENT_RECEIVED";
  if (atual === "REFUNDED") return "PAYMENT_REFUNDED";
  if (atual === "PARTIALLY_REFUNDED") return "PAYMENT_PARTIALLY_REFUNDED";
  if (atual === "REFUND_IN_PROGRESS" || atual === "REFUND_REQUESTED") {
    return "PAYMENT_REFUND_IN_PROGRESS";
  }
  return null;
}

function selecionarCobrancasExatas(cobrancas, { customerId, valor, orderId }) {
  return (Array.isArray(cobrancas) ? cobrancas : []).filter((cobranca) =>
    String(cobranca?.customer || "") === String(customerId) &&
    normalizarStatus(cobranca?.billingType) === "PIX" &&
    String(cobranca?.externalReference || "") === String(orderId) &&
    paraCentavos(cobranca?.value) === paraCentavos(valor) &&
    !["DELETED", "REFUNDED"].includes(normalizarStatus(cobranca?.status))
  );
}

/**
 * Validação forte usada antes de confirmar um pedido.
 *
 * Para cobranças criadas pelo app, exigirIdSalvo e exigirReferencia ficam
 * habilitados: os dois identificadores independentes precisam apontar para o
 * mesmo pedido. Para integrações legadas, um vínculo manual previamente
 * auditado pode dispensar a externalReference, mas nunca dispensa paymentId,
 * PIX, status RECEIVED e valor exato.
 */
function normalizarNomeCompleto(nome) {
  return String(nome || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function nomesCompletosCompativeis(nomePagador, nomeCliente) {
  if (!nomePagador || !nomeCliente) return false;
  if (nomePagador === nomeCliente) return true;

  const menor = nomePagador.length <= nomeCliente.length ? nomePagador : nomeCliente;
  const maior = menor === nomePagador ? nomeCliente : nomePagador;
  return menor.length >= 24 && maior.startsWith(menor);
}

function origemEhInstadelivery(origem) {
  if (origem === 1) return true;
  const rotulo = String(origem || "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/[\s_-]+/g, "");
  return rotulo === "instadelivery" || rotulo === "insta";
}

function statusInstaAtivo(status) {
  return STATUS_INSTA_ATIVOS.has(Number(status));
}

function instanteEmMs(valor) {
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : Number.NaN;
  if (valor && typeof valor.toMillis === "function") {
    const millis = valor.toMillis();
    return Number.isFinite(millis) ? millis : Number.NaN;
  }

  const segundos = valor?.seconds ?? valor?._seconds;
  if (Number.isFinite(segundos)) {
    const nanos = valor?.nanoseconds ?? valor?._nanoseconds ?? 0;
    return segundos * 1000 + Math.floor(nanos / 1e6);
  }

  const texto = String(valor || "").trim();
  if (!texto || /^\d{4}-\d{2}-\d{2}$/.test(texto)) return Number.NaN;

  // data_venda usa o horario de parede de Sao Paulo, sem offset.
  const horarioSemFuso =
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(texto);
  const normalizado = horarioSemFuso
    ? `${texto.replace(" ", "T")}-03:00`
    : texto;
  return Date.parse(normalizado);
}

function instanteDoPedidoEmMs(pedido) {
  for (const valor of [pedido?.criadoEmTimestamp, pedido?.data_venda]) {
    const millis = instanteEmMs(valor);
    if (Number.isFinite(millis)) return millis;
  }
  return Number.NaN;
}

/**
 * Escolhe um pedido do InstaDelivery apenas quando todos os sinais fortes
 * convergem para um unico candidato. Nao confirma pagamento nem faz I/O.
 *
 * Cada item pode ser o pedido diretamente ou `{ id, pedido }`. O retorno
 * preserva o item original para o chamador manter seu ID/referencia.
 */
function selecionarCandidatoInstaSeguro({
  pagamento,
  pagador,
  candidatos,
  eventoRecebidoEm,
  janelaMinutos = 360,
} = {}) {
  if (pagamento?.externalReference !== "ORDER_PIX") return null;
  if (!Number.isFinite(janelaMinutos) || janelaMinutos < 0) return null;

  const valorPagamentoCentavos = paraCentavos(pagamento?.value);
  if (valorPagamentoCentavos <= 0) return null;

  const nomePagador = normalizarNomeCompleto(pagador?.nome);
  const eventoEmMs = instanteEmMs(eventoRecebidoEm);
  if (!nomePagador || !Number.isFinite(eventoEmMs)) return null;

  const janelaMs = janelaMinutos * 60 * 1000;
  let selecionado = null;

  for (const candidato of Array.isArray(candidatos) ? candidatos : []) {
    const pedido = candidato?.pedido ?? candidato;
    const nomeCliente = normalizarNomeCompleto(pedido?.nome_destinatario);
    const pedidoEmMs = instanteDoPedidoEmMs(pedido);
    const diferencaMs = eventoEmMs - pedidoEmMs;
    const atende = (
      origemEhInstadelivery(pedido?.origem) &&
      statusInstaAtivo(pedido?.status) &&
      pedido?.pix_confirmado !== true &&
      !String(pedido?.pix_pagamento_id || "").trim() &&
      paraCentavos(pedido?.valor_venda) === valorPagamentoCentavos &&
      nomesCompletosCompativeis(nomePagador, nomeCliente) &&
      Number.isFinite(pedidoEmMs) &&
      diferencaMs >= 0 &&
      diferencaMs <= janelaMs
    );

    if (!atende) continue;
    if (selecionado) return null;
    selecionado = candidato;
  }

  return selecionado;
}

function validarPagamentoRecebido({
  pagamento,
  pedido,
  orderId,
  paymentId,
  exigirIdSalvo = true,
  exigirReferencia = true,
}) {
  const erros = [];
  const orderIdEsperado = String(orderId ?? pedido?.order_id ?? "").trim();
  const paymentIdEsperado = String(paymentId || "").trim();
  const idConsultado = String(pagamento?.id || "").trim();
  const idSalvo = String(pedido?.pix_pagamento_id || "").trim();
  const referencia = String(pagamento?.externalReference || "").trim();

  if (!pedido) erros.push("pedido_ausente");
  if (!paymentIdEsperado || !idConsultado || idConsultado !== paymentIdEsperado) {
    erros.push("payment_id_divergente");
  }
  if (!pedidoEhPix(pedido)) erros.push("pedido_nao_pix");
  if (normalizarStatus(pagamento?.billingType) !== "PIX") {
    erros.push("billing_type_nao_pix");
  }
  if (normalizarStatus(pagamento?.status) !== "RECEIVED") {
    erros.push("status_nao_recebido");
  }
  if (exigirIdSalvo && (!idSalvo || idSalvo !== paymentIdEsperado)) {
    erros.push("payment_id_nao_confere_com_pedido");
  }
  if (idSalvo && idSalvo !== paymentIdEsperado) {
    erros.push("pedido_vinculado_a_outro_pagamento");
  }
  if (exigirReferencia && (!orderIdEsperado || referencia !== orderIdEsperado)) {
    erros.push("external_reference_divergente");
  }
  if (paraCentavos(pagamento?.value) !== paraCentavos(pedido?.valor_venda)) {
    erros.push("valor_divergente");
  }

  return {
    ok: erros.length === 0,
    erros: [...new Set(erros)],
    valorPagamentoCentavos: paraCentavos(pagamento?.value),
    valorPedidoCentavos: paraCentavos(pedido?.valor_venda),
  };
}

module.exports = {
  EVENTOS_ASAAS_RELEVANTES,
  EVENTOS_ESTORNO,
  parseValor,
  paraCentavos,
  normalizarStatus,
  pedidoEhPix,
  atualizacaoOperacionalAoConfirmarPix,
  pedidoVisivelNoPainel,
  eventoEhRelevante,
  eventoEhEstorno,
  statusDoEvento,
  calcularJanelaInstaSeguraMinutos,
  eventoParaStatusConsultado,
  selecionarCobrancasExatas,
  selecionarCandidatoInstaSeguro,
  validarPagamentoRecebido,
};
