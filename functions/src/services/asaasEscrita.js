// ============================================================================
// SERVIÇO ASAAS — ESCRITA (criação de cliente e cobrança PIX)
// Diferente de services/asaas.js (chave só-leitura, usada só pra desempate
// de PIX em colisão vindo do InstaDelivery), este usa uma chave com
// permissão de criar cliente e cobrança — só para o checkout do app
// cliente (ver src/cliente/pedidos.js). Nunca cria nada além de cliente e
// cobrança PIX: sem saque, sem transferência, sem alterar dados da conta.
// ============================================================================

const { http, comRetentativa } = require("../lib/http");
const { ASAAS_API_BASE } = require("../config");
const { selecionarCobrancasExatas } = require("./pixConfiavel");

function headers(apiKey) {
  return {
    access_token: apiKey,
    "User-Agent": "FabricaSalgadosAppCliente/1.0",
    "Content-Type": "application/json",
  };
}

// AAAA-MM-DD no fuso de São Paulo — Asaas exige dueDate mesmo pra PIX.
function dataHojeSP() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function somenteDigitos(valor) {
  return String(valor || "").replace(/\D/g, "");
}

async function buscarClientePorCpf(cpf, apiKey) {
  const { data } = await comRetentativa(
    () => http.get(`${ASAAS_API_BASE}/customers`, {
      headers: headers(apiKey),
      params: { cpfCnpj: cpf, limit: 20 },
    }),
    { tentativas: 2, baseMs: 400, rotulo: "asaas:customers:cpf", circuito: "asaas" }
  );
  const exatos = (Array.isArray(data?.data) ? data.data : [])
    .filter((cliente) => somenteDigitos(cliente.cpfCnpj) === somenteDigitos(cpf))
    .filter((cliente) => cliente.deleted !== true);
  return exatos[0]?.id || null;
}

async function criarClienteAsaas({ nome, telefone, cpf }, apiKey) {
  const existente = await buscarClientePorCpf(cpf, apiKey);
  if (existente) return existente;

  try {
    // Assim como em /payments, este POST não é repetido às cegas: uma
    // resposta perdida pode significar que o cliente já foi criado.
    const { data } = await http.post(
      `${ASAAS_API_BASE}/customers`,
      { name: nome, mobilePhone: telefone, cpfCnpj: cpf },
      { headers: headers(apiKey) }
    );
    const customerId = String(data?.id || "").trim();
    if (!customerId) {
      throw new Error("O Asaas respondeu à criação do cliente sem um identificador.");
    }
    return customerId;
  } catch (erroCriacao) {
    const status = erroCriacao.response?.status;
    const inconclusivo = !status || status === 429 || status >= 500;
    if (!inconclusivo) throw erroCriacao;

    for (const esperaMs of [1000, 2000, 4000]) {
      await dormir(esperaMs);
      try {
        const recuperado = await buscarClientePorCpf(cpf, apiKey);
        if (recuperado) return recuperado;
      } catch (erroConsulta) {
        console.warn(
          `[asaas:customers:create] Não foi possível reconciliar ${somenteDigitos(cpf)}:`,
          erroConsulta.response?.status ?? erroConsulta.message
        );
      }
    }

    const erroSeguro = new Error(
      "O resultado da criação do cliente no Asaas ficou inconclusivo; a recuperação continuará sem repetir o cadastro às cegas."
    );
    erroSeguro.resultadoInconclusivo = true;
    erroSeguro.cause = erroCriacao;
    throw erroSeguro;
  }
}

async function listarCobrancasPorReferencia(orderId, apiKey) {
  const { data } = await comRetentativa(
    () => http.get(`${ASAAS_API_BASE}/payments`, {
      headers: headers(apiKey),
      params: { externalReference: orderId, limit: 20 },
    }),
    { tentativas: 2, baseMs: 400, rotulo: `asaas:payments:externalReference:${orderId}`, circuito: "asaas" }
  );
  return Array.isArray(data?.data) ? data.data : [];
}

async function criarCobrancaPix({ customerId, valor, orderId }, apiKey) {
  const parametros = { customerId, valor, orderId };

  // POST /payments não é tratado como idempotente. Antes de criar, procura
  // uma cobrança exata da tentativa anterior (por exemplo, uma resposta que
  // se perdeu depois de o Asaas já ter criado a cobrança).
  const existentes = selecionarCobrancasExatas(
    await listarCobrancasPorReferencia(orderId, apiKey),
    parametros
  );
  if (existentes.length === 1) return existentes[0].id;
  if (existentes.length > 1) {
    throw new Error(
      `Existem ${existentes.length} cobranças PIX idênticas para o pedido ${orderId}; ` +
      "a criação foi interrompida para não escolher uma cobrança arbitrariamente."
    );
  }

  try {
    // Deliberadamente sem comRetentativa: repetir um POST cujo resultado foi
    // inconclusivo pode criar uma segunda cobrança real.
    const { data } = await http.post(
      `${ASAAS_API_BASE}/payments`,
      {
        customer: customerId,
        billingType: "PIX",
        value: valor,
        dueDate: dataHojeSP(),
        externalReference: orderId,
        description: `Pedido ${orderId}`,
      },
      { headers: headers(apiKey) }
    );
    const paymentId = String(data?.id || "").trim();
    if (!paymentId) {
      throw new Error("O Asaas respondeu à criação da cobrança sem um identificador.");
    }
    return paymentId;
  } catch (erroCriacao) {
    const status = erroCriacao.response?.status;
    const resultadoPodeSerInconclusivo = !status || status === 429 || status >= 500;
    if (!resultadoPodeSerInconclusivo) throw erroCriacao;

    // A resposta pode ter se perdido depois da criação. Aguarda a
    // consistência da listagem e recupera a MESMA cobrança; nunca repete o
    // POST automaticamente.
    for (const esperaMs of [1000, 2000, 4000]) {
      await dormir(esperaMs);
      try {
        const encontradas = selecionarCobrancasExatas(
          await listarCobrancasPorReferencia(orderId, apiKey),
          parametros
        );
        if (encontradas.length === 1) return encontradas[0].id;
        if (encontradas.length > 1) {
          throw new Error(
            `Foram encontradas ${encontradas.length} cobranças PIX para o pedido ${orderId} após resposta inconclusiva.`
          );
        }
      } catch (erroConsulta) {
        console.warn(
          `[asaas:payments:create] Não foi possível reconciliar ${orderId} após ${esperaMs}ms:`,
          erroConsulta.response?.status ?? erroConsulta.message
        );
      }
    }

    const erroSeguro = new Error(
      `O resultado da criação do PIX do pedido ${orderId} ficou inconclusivo. ` +
      "Nenhuma nova cobrança foi criada automaticamente; tente novamente após a conciliação."
    );
    erroSeguro.resultadoInconclusivo = true;
    erroSeguro.cause = erroCriacao;
    throw erroSeguro;
  }
}

async function buscarQrCodePix(paymentId, apiKey) {
  const { data } = await comRetentativa(
    () => http.get(`${ASAAS_API_BASE}/payments/${paymentId}/pixQrCode`, { headers: headers(apiKey) }),
    { rotulo: "asaas:payments:pixQrCode", circuito: "asaas" }
  );
  if (!data?.encodedImage || !data?.payload) {
    const erro = new Error(`O Asaas retornou um QR Code incompleto para ${paymentId}.`);
    erro.resultadoInconclusivo = true;
    throw erro;
  }
  return { qrCodeBase64: data.encodedImage, copiaCola: data.payload, expiracao: data.expirationDate };
}

module.exports = { criarClienteAsaas, criarCobrancaPix, buscarQrCodePix };
