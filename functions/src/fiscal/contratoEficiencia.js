// ============================================================================
// CONTRATO EFICIENCIA FISCAL — somente construcao e validacao local
//
// Este modulo nao possui fetch, token ou repeticao automatica. Ele transforma
// um snapshot fiscal imutavel em comandos revisaveis e valida respostas
// sinteticas/do provedor sem registrar XML, DANFE ou dados pessoais em logs.
// ============================================================================

const { CNPJ_EMITENTE, ErroFiscal, hash } = require("./modelo");

const MODELO_NFCE = 65;
const CAMINHO_VENDAS = "/api/vendas/v1/venda";

function moeda(centavos) {
  if (!Number.isSafeInteger(centavos) || centavos < 0 || centavos > 100000000) {
    throw new ErroFiscal("VALOR_FISCAL_INVALIDO", "O valor fiscal precisa estar expresso em centavos exatos.", 422);
  }
  return `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, "0")}`;
}

function dataVendaValida(valor) {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(valor)) return false;
  const [data, hora] = valor.split(" ");
  const [ano, mes, dia] = data.split("-").map(Number);
  const [h, m, s] = hora.split(":").map(Number);
  const instante = new Date(Date.UTC(ano, mes - 1, dia, h, m, s));
  return instante.getUTCFullYear() === ano && instante.getUTCMonth() === mes - 1 &&
    instante.getUTCDate() === dia && instante.getUTCHours() === h &&
    instante.getUTCMinutes() === m && instante.getUTCSeconds() === s;
}

function exigirOperacaoPreparada(operacao) {
  if (!operacao || operacao.estado !== "preparada" || operacao.ambiente !== "homologacao" ||
      operacao.cnpjEmitente !== CNPJ_EMITENTE || !operacao.snapshot) {
    throw new ErroFiscal(
      "OPERACAO_FISCAL_INVALIDA",
      "A operacao fiscal nao esta preparada de forma valida para homologacao.",
      422
    );
  }
  const referencia = String(operacao.referenciaExterna || "");
  if (!/^FDAPP_[a-f0-9]{32}$/.test(referencia) ||
      referencia !== operacao.snapshot.referenciaExterna) {
    throw new ErroFiscal(
      "REFERENCIA_FISCAL_INVALIDA",
      "A referencia fiscal da operacao nao corresponde ao snapshot conferido.",
      422
    );
  }
  return operacao.snapshot;
}

function construirComandoPreVenda(operacao) {
  const snapshot = exigirOperacaoPreparada(operacao);
  if (!dataVendaValida(snapshot.criadoEm)) {
    throw new ErroFiscal("DATA_VENDA_INVALIDA", "A data da venda nao segue o contrato fiscal confirmado.", 422);
  }
  if (snapshot.formaPagamento !== "17" || snapshot.pagamento !== "pix_confirmado_no_pedido" ||
      !/^pay_[A-Za-z0-9_-]+$/.test(snapshot.pagamentoId || "")) {
    throw new ErroFiscal(
      "PAGAMENTO_FISCAL_NAO_CONFIRMADO",
      "Somente um PIX exatamente confirmado pode gerar este contrato de homologacao.",
      422
    );
  }

  const resumo = snapshot.resumo || {};
  for (const campo of ["itensCentavos", "descontoCentavos", "entregaCentavos", "taxaCartaoCentavos", "totalCentavos"]) {
    moeda(resumo[campo]);
  }
  if (resumo.entregaCentavos !== 0 || resumo.taxaCartaoCentavos !== 0) {
    throw new ErroFiscal(
      "POLITICA_TAXAS_NAO_CONFIRMADA",
      "Entrega e taxa de cartao ainda dependem de classificacao fiscal confirmada.",
      423
    );
  }

  const itens = Array.isArray(snapshot.itens) ? snapshot.itens : [];
  if (!itens.length || itens.length > 200) {
    throw new ErroFiscal("ITENS_FISCAIS_INVALIDOS", "A operacao nao possui uma lista de itens valida.", 422);
  }
  const codigos = [];
  const descricoes = [];
  const quantidades = [];
  const unitarios = [];
  const totais = [];
  let soma = 0;
  for (const item of itens) {
    if (!/^[1-9]\d{0,14}$/.test(item.codigoProduto || "") ||
        !Number.isSafeInteger(item.quantidade) || item.quantidade <= 0 || item.quantidade > 10000 ||
        !Number.isSafeInteger(item.totalCentavos) || item.totalCentavos <= 0) {
      throw new ErroFiscal("ITEM_FISCAL_INVALIDO", "Um item nao atende ao contrato fiscal conferido.", 422);
    }
    const descricao = String(item.nomeEf || item.descricao || "").trim();
    if (!descricao || descricao.length > 160 || /[\r\n]/.test(descricao)) {
      throw new ErroFiscal("DESCRICAO_FISCAL_INVALIDA", "Um item nao possui descricao fiscal valida.", 422);
    }
    if (item.totalCentavos % item.quantidade !== 0) {
      throw new ErroFiscal(
        "VALOR_UNITARIO_NAO_CONFIRMADO",
        "Um item nao permite obter valor unitario exato em centavos. O contrato precisa ser confirmado antes do envio.",
        423
      );
    }
    codigos.push(item.codigoProduto);
    descricoes.push(descricao);
    quantidades.push(String(item.quantidade));
    unitarios.push(moeda(item.totalCentavos / item.quantidade));
    totais.push(moeda(item.totalCentavos));
    soma += item.totalCentavos;
  }
  if (soma !== resumo.itensCentavos ||
      resumo.itensCentavos - resumo.descontoCentavos !== resumo.totalCentavos) {
    throw new ErroFiscal("TOTAL_FISCAL_DIVERGENTE", "Os totais do snapshot fiscal nao fecham.", 422);
  }

  const corpo = {
    cadastro_nacional: CNPJ_EMITENTE,
    codigo_parceiro: operacao.referenciaExterna,
    modelo: MODELO_NFCE,
    data_venda: snapshot.criadoEm,
    valor_venda: moeda(resumo.totalCentavos),
    valor_desconto: moeda(resumo.descontoCentavos),
    desconto_real: true,
    valor_acrescimo: "0.00",
    acrescimo_real: true,
    valor_taxa: "0.00",
    codigo_produto: codigos,
    descricao_item: descricoes,
    quantidade_item: quantidades,
    valor_unitario_item: unitarios,
    valor_total: totais,
    forma_pagamento: ["17"],
    valor_pago: [moeda(resumo.totalCentavos)],
    qtd_vezes: "1",
  };
  return { metodo: "POST", caminho: CAMINHO_VENDAS, corpo };
}

function interpretarRespostaPreVenda(resposta, operacao) {
  if (!resposta || typeof resposta !== "object" || Array.isArray(resposta) ||
      String(resposta.cadastro_nacional || "").replace(/\D/g, "") !== CNPJ_EMITENTE ||
      resposta.codigo_parceiro !== operacao?.referenciaExterna) {
    throw new ErroFiscal(
      "EF_RESPOSTA_PRE_VENDA_INVALIDA",
      "A Eficiência Fiscal retornou uma pre-venda que nao corresponde a operacao solicitada.",
      503
    );
  }
  const codigoEf = String(resposta.codigo_ef ?? "");
  if (!/^[1-9]\d{0,18}$/.test(codigoEf)) {
    throw new ErroFiscal("EF_CODIGO_PRE_VENDA_INVALIDO", "A pre-venda nao retornou um identificador fiscal valido.", 503);
  }
  return {
    codigoEf,
    referenciaExterna: operacao.referenciaExterna,
    respostaHash: hash({
      cadastro_nacional: CNPJ_EMITENTE,
      codigo_parceiro: resposta.codigo_parceiro,
      codigo_ef: codigoEf,
    }),
  };
}

function construirComandoAutorizacao(operacao) {
  if (!operacao || operacao.estado !== "pre_venda_criada" ||
      operacao.cnpjEmitente !== CNPJ_EMITENTE ||
      !/^FDAPP_[a-f0-9]{32}$/.test(operacao.referenciaExterna || "") ||
      !/^[1-9]\d{0,18}$/.test(String(operacao.provedor?.codigoEf ?? ""))) {
    throw new ErroFiscal(
      "PRE_VENDA_NAO_CONFIRMADA",
      "A pre-venda exata precisa estar persistida antes da autorizacao.",
      409
    );
  }
  return {
    metodo: "POST",
    caminho: `${CAMINHO_VENDAS}/${encodeURIComponent(operacao.referenciaExterna)}/autorizar`,
    corpo: { cadastro_nacional: CNPJ_EMITENTE },
  };
}

function interpretarRespostaAutorizacao(resposta) {
  if (!resposta || typeof resposta !== "object" || Array.isArray(resposta) ||
      String(resposta.modelo) !== String(MODELO_NFCE) ||
      typeof resposta.xml !== "string" || resposta.xml.length < 20 || resposta.xml.length > 5 * 1024 * 1024 ||
      !/<nfeProc(?:\s|>)/.test(resposta.xml) ||
      typeof resposta.danfe !== "string" || resposta.danfe.length < 8 || resposta.danfe.length > 15 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(resposta.danfe)) {
    throw new ErroFiscal(
      "EF_RESPOSTA_AUTORIZACAO_INVALIDA",
      "A autorizacao retornou um documento incompleto ou em formato inesperado.",
      503
    );
  }
  return {
    modelo: MODELO_NFCE,
    xmlHash: hash(resposta.xml),
    xmlBytes: Buffer.byteLength(resposta.xml, "utf8"),
    danfeHash: hash(resposta.danfe),
    danfeBytes: Buffer.byteLength(resposta.danfe, "base64"),
    documentosPresentes: true,
  };
}

// A consulta do XML pela referencia propria e a unica forma documentada de
// recuperar uma autorizacao cuja resposta se perdeu. Ausencia de XML nao prova
// que a nota nao existe; quem chama mantem o estado inconclusivo.
function construirComandoConsultaXml(operacao) {
  if (!operacao || operacao.cnpjEmitente !== CNPJ_EMITENTE ||
      !/^FDAPP_[a-f0-9]{32}$/.test(operacao.referenciaExterna || "")) {
    throw new ErroFiscal("OPERACAO_FISCAL_INVALIDA", "A operacao fiscal nao possui referencia valida para consulta.", 422);
  }
  return {
    metodo: "GET",
    caminho: `${CAMINHO_VENDAS}/${encodeURIComponent(operacao.referenciaExterna)}/xml?cadastro_nacional=${CNPJ_EMITENTE}`,
  };
}

// O ambiente da EF e trocado no painel do provedor, para o CNPJ inteiro, e a
// URL e a mesma nos dois ambientes. Por isso o XML devolvido e a unica prova
// de que a nota saiu no ambiente esperado (tpAmb 1 = producao, 2 = homologacao).
const TP_AMB = { producao: "1", homologacao: "2" };

function ambienteDoXml(xml) {
  const valores = [...String(xml || "").matchAll(/<tpAmb>\s*([^<\s]*)\s*<\/tpAmb>/g)].map((m) => m[1]);
  if (!valores.length || valores.some((v) => v !== valores[0])) return null;
  return Object.keys(TP_AMB).find((ambiente) => TP_AMB[ambiente] === valores[0]) || null;
}

module.exports = {
  CAMINHO_VENDAS,
  MODELO_NFCE,
  TP_AMB,
  ambienteDoXml,
  construirComandoConsultaXml,
  moeda,
  construirComandoPreVenda,
  interpretarRespostaPreVenda,
  construirComandoAutorizacao,
  interpretarRespostaAutorizacao,
};
