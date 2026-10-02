// ============================================================================
// SERVIÇO ASAAS — consulta de pagador via API (chave só-leitura)
// Usado como segunda linha de defesa no match de PIX (ver webhooks/asaas.js),
// só em colisão de valor: nenhuma escrita, nenhuma cobrança, só GET.
// A chave configurada tem permissão apenas PAYMENT:READ e
// FINANCIAL_TRANSACTION:READ — não consegue criar/alterar nada no Asaas.
// ============================================================================

const { http, comRetentativa } = require("../lib/http");
const { ASAAS_API_BASE } = require("../config");

function headersLeitura(apiKey) {
  return {
    access_token: apiKey,
    "User-Agent": "FabricaSalgadosDashboard/1.0",
  };
}

/**
 * Consulta a cobrança diretamente pelo identificador imutável do Asaas.
 * Diferente do payload do webhook, esta leitura é usada como fonte da
 * verdade imediatamente antes de qualquer alteração financeira no pedido.
 */
async function buscarPagamentoAsaas(paymentId, apiKey) {
  if (!paymentId) throw new Error("paymentId obrigatório para consultar o Asaas");

  const { data } = await comRetentativa(
    () => http.get(
      `${ASAAS_API_BASE}/payments/${encodeURIComponent(paymentId)}`,
      { headers: headersLeitura(apiKey) }
    ),
    { rotulo: `asaas:payments/${paymentId}`, circuito: "asaas" }
  );

  return data;
}

/**
 * Busca nome/CPF do pagador de um pagamento, via payment.customer.
 * Retorna null se o pagamento não existir, não tiver customer vinculado,
 * ou qualquer chamada falhar — nunca lança, quem chama trata como "sem dado".
 */
async function buscarPagadorDoPagamento(paymentId, apiKey) {
  const headers = headersLeitura(apiKey);

  try {
    const pagamento = await buscarPagamentoAsaas(paymentId, apiKey);

    if (!pagamento?.customer) return null;

    const { data: cliente } = await comRetentativa(
      () => http.get(`${ASAAS_API_BASE}/customers/${pagamento.customer}`, { headers }),
      { rotulo: `asaas:customers/${pagamento.customer}`, circuito: "asaas" }
    );

    return {
      nome: cliente?.name || null,
      cpfCnpj: cliente?.cpfCnpj || null,
      telefone: cliente?.mobilePhone || cliente?.phone || null,
    };
  } catch (erro) {
    console.error(`[asaas] Falha ao buscar pagador do pagamento ${paymentId}:`,
      erro.response?.status ?? erro.message);
    return null;
  }
}

// Remove acento/caixa/pontuação — "Giovanna" e "GIOVANNA SILVA" comparam limpo.
function normalizarNome(nome) {
  return String(nome || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim();
}

// Compara pelo primeiro nome — o pagador no Asaas costuma vir só com o
// primeiro nome ("Giovanna"), enquanto o pedido tem o nome completo
// ("Giovanna Silva Costa"). Exige pelo menos 3 letras pra evitar falso
// positivo em nomes curtos demais (ex.: "Ana" batendo com qualquer coisa).
function nomesProvavelmenteIguais(nomePagador, nomeDestinatario) {
  const a = normalizarNome(nomePagador).split(" ")[0] || "";
  const b = normalizarNome(nomeDestinatario).split(" ")[0] || "";
  return a.length >= 3 && a === b;
}

module.exports = {
  buscarPagamentoAsaas,
  buscarPagadorDoPagamento,
  nomesProvavelmenteIguais,
};
