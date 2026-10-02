const { createHash } = require("node:crypto");

const CNPJ_EMITENTE = "11560207000137";
const VERSAO_CONFERENCIA = 2;
// Deliberately not an env var or a client-editable setting. This release cannot
// create a pre-sale, authorize, cancel or retransmit a fiscal document.
const EMISSAO_HABILITADA = false;
const ETAPAS_PENDENTES = [
  "Revisar os produtos e as figuras tributárias com a contabilidade.",
  "Confirmar com a Eficiência Fiscal o ambiente de testes e as regras de emissão para entrega e retirada.",
  "Validar emissão, consulta de resultado, cancelamento e recuperação de falhas antes de ativar a produção.",
];

class ErroFiscal extends Error {
  constructor(codigo, mensagem, status = 400) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

function idValido(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function centavos(valor) {
  if (typeof valor !== "number" && typeof valor !== "string") return null;
  if (typeof valor === "string" && !/^\d+(?:[.,]\d{1,2})?$/.test(valor)) return null;
  const numero = Number(typeof valor === "string" ? valor.replace(",", ".") : valor);
  const inteiro = Math.round(numero * 100);
  // Permit floating-point residue from the current checkout, never silent
  // rounding of a real fraction of a cent or a parseFloat partial match.
  if (!Number.isFinite(numero) || numero < 0 || inteiro > 100000000 ||
      Math.abs(numero * 100 - inteiro) > 0.000001) return null;
  return inteiro;
}

function hash(valor) {
  return createHash("sha256").update(JSON.stringify(valor)).digest("hex");
}

function hashFontePedidoFiscal(pedidoId, pedido = {}) {
  const campos = [
    "order_id", "status", "status_interno", "origem", "avulso", "clienteUid",
    "nome_destinatario", "tipo_entrega", "data_venda", "agendamento",
    "produto_id_item", "descricao_item", "quantidade_item", "valor_total_item",
    "valor_itens", "valor_desconto", "valor_taxa", "valor_taxa_cartao", "valor_venda",
    "forma_pagamento", "pix_confirmado", "pix_status", "pix_pagamento_id",
    "pix_estornado", "pix_estorno_parcial", "pix_estorno_em_andamento",
    "logradouro_destinatario", "numero_destinatario", "bairro_destinatario",
    "complemento_destinatario", "cep_destinatario",
  ];
  return hash({
    pedidoId,
    campos: Object.fromEntries(campos.map((campo) => [campo, pedido[campo] ?? null])),
  });
}

function normalizarVinculo(dados, produto) {
  if (!produto || produto.itemSistema || produto.tipoSistema || produto.friturasNoLocal) {
    throw new ErroFiscal("PRODUTO_NAO_ELEGIVEL", "Itens de sistema e serviços não entram no vínculo fiscal de mercadorias.", 422);
  }
  const codigoProduto = String(dados.codigoProduto ?? "").trim();
  const nomeEf = String(dados.nomeEf ?? "").trim();
  if (!/^[1-9]\d{0,14}$/.test(codigoProduto)) {
    throw new ErroFiscal("CODIGO_EF_INVALIDO", "Informe o código numérico de um produto que já existe na Eficiência Fiscal.", 422);
  }
  if (!nomeEf || nomeEf.length > 160 || /[\r\n]/.test(nomeEf)) {
    throw new ErroFiscal("NOME_EF_INVALIDO", "Informe o nome do produto no cadastro da Eficiência Fiscal (até 160 caracteres).", 422);
  }
  if (typeof dados.revisado !== "boolean") {
    throw new ErroFiscal("REVISAO_INVALIDA", "Informe se o vínculo já foi conferido.", 422);
  }
  return {
    codigoProduto, nomeEf, revisado: dados.revisado,
    nomeProdutoNaRevisao: String(produto.nome || ""),
    observacao: String(dados.observacao || "").trim().slice(0, 500),
  };
}

function conferirPedido(pedidoId, pedido, produtos = {}, vinculos = {}) {
  if (!idValido(pedidoId)) throw new ErroFiscal("PEDIDO_ID_INVALIDO", "Informe um ID de pedido válido.");
  if (!pedido) throw new ErroFiscal("PEDIDO_NAO_ENCONTRADO", "Pedido não encontrado.", 404);
  if (pedido.origem !== "app" || pedido.avulso === true || !pedido.clienteUid) {
    throw new ErroFiscal("ORIGEM_NAO_ELEGIVEL", "Esta etapa aceita somente pedidos do nosso app cliente. Pedidos externos e despesas de motoboys não serão preparados.", 422);
  }
  const pendencias = [];
  const avisos = ["Esta conferência não é uma nota fiscal e não confirma a tributação ou o momento correto da emissão."];
  const adicionar = (codigo, mensagem, item = null) => pendencias.push({ codigo, mensagem, item });
  if (String(pedido.order_id) !== pedidoId) adicionar("ID_DIVERGENTE", "O ID salvo no pedido não corresponde ao documento consultado.");
  const status = Number(pedido.status);
  if (status === 4 || String(pedido.status_interno || "").toLowerCase().includes("cancel")) {
    adicionar("PEDIDO_CANCELADO", "Pedido cancelado: não pode seguir para emissão.");
  } else if (![1, 2, 3, 5].includes(status)) {
    adicionar("STATUS_DESCONHECIDO", "O status do pedido precisa ser revisado.");
  }
  if (!String(pedido.nome_destinatario || "").trim()) adicionar("CLIENTE_SEM_NOME", "O pedido não possui nome do cliente.");
  if (!["delivery", "retirada"].includes(pedido.tipo_entrega)) adicionar("ENTREGA_NAO_DEFINIDA", "Confirme se o pedido é delivery ou retirada.");

  const ids = Array.isArray(pedido.produto_id_item) ? pedido.produto_id_item : [];
  const descricoes = Array.isArray(pedido.descricao_item) ? pedido.descricao_item : [];
  const quantidades = Array.isArray(pedido.quantidade_item) ? pedido.quantidade_item : [];
  const totais = Array.isArray(pedido.valor_total_item) ? pedido.valor_total_item : [];
  if (!ids.length || ids.length > 200 || ids.length !== descricoes.length ||
      ids.length !== quantidades.length || ids.length !== totais.length) {
    adicionar("ITENS_INCONSISTENTES", "As listas de produtos, quantidades e valores não correspondem entre si.");
  }
  const itens = ids.slice(0, 200).map((id, indice) => {
    const produtoId = idValido(id) ? id : null;
    const produto = produtoId ? produtos[produtoId] : null;
    const vinculo = produtoId ? vinculos[produtoId] : null;
    const quantidade = quantidades[indice];
    const totalCentavos = centavos(totais[indice]);
    const descricao = String(descricoes[indice] || "").slice(0, 160);
    if (!produto || !produtoId) adicionar("PRODUTO_AUSENTE", "Produto não encontrado no cardápio. O vínculo precisa ser recuperado.", indice);
    if (!descricao) adicionar("DESCRICAO_AUSENTE", "Item sem descrição.", indice);
    if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > 10000) adicionar("QUANTIDADE_INVALIDA", "Quantidade inválida.", indice);
    if (totalCentavos === null || totalCentavos === 0) adicionar("VALOR_ITEM_INVALIDO", "O valor do item deve ser positivo e expresso em centavos.", indice);
    if (produto?.itemSistema || produto?.tipoSistema || produto?.friturasNoLocal) {
      adicionar("SERVICO_NAO_SUPORTADO", "Item de serviço/sistema precisa de tratamento fiscal próprio.", indice);
    }
    const codigoProduto = String(vinculo?.codigoProduto || "");
    if (!/^[1-9]\d{0,14}$/.test(codigoProduto)) {
      adicionar("VINCULO_AUSENTE", "Vincule este item a um produto existente na Eficiência Fiscal.", indice);
    } else if (vinculo.revisado !== true || !vinculo.revisadoPor || !vinculo.revisadoEm ||
        vinculo.nomeProdutoNaRevisao !== produto?.nome) {
      adicionar("VINCULO_NAO_REVISADO", "O vínculo fiscal está pendente de conferência ou o produto foi renomeado.", indice);
    }
    return { produtoId, descricao, quantidade: Number.isInteger(quantidade) ? quantidade : null,
      totalCentavos, codigoProduto: codigoProduto || null, nomeEf: String(vinculo?.nomeEf || ""),
      revisaoVinculo: vinculo?.revisao || null,
      revisadoEm: vinculo?.revisadoEm?.toDate?.().toISOString() || null };
  });

  const resumo = {
    itensCentavos: centavos(pedido.valor_itens),
    descontoCentavos: centavos(pedido.valor_desconto ?? 0),
    entregaCentavos: centavos(pedido.valor_taxa ?? 0),
    taxaCartaoCentavos: centavos(pedido.valor_taxa_cartao ?? 0),
    totalCentavos: centavos(pedido.valor_venda),
  };
  if (Object.values(resumo).some(v => v === null) || resumo.totalCentavos === 0) {
    adicionar("VALORES_INVALIDOS", "Revise os valores do pedido; não foi possível conferir os totais com segurança.");
  } else {
    const somaItens = itens.reduce((soma, item) => soma + (item.totalCentavos ?? 0), 0);
    if (somaItens !== resumo.itensCentavos) adicionar("SUBTOTAL_DIVERGENTE", "A soma dos itens não corresponde ao subtotal salvo.");
    if (resumo.descontoCentavos > resumo.itensCentavos) adicionar("DESCONTO_INVALIDO", "O desconto é maior que o subtotal.");
    if (resumo.itensCentavos - resumo.descontoCentavos + resumo.entregaCentavos + resumo.taxaCartaoCentavos !== resumo.totalCentavos) {
      adicionar("TOTAL_DIVERGENTE", "Itens, desconto e taxas não fecham com o total do pedido.");
    }
  }
  const formas = Array.isArray(pedido.forma_pagamento) ? pedido.forma_pagamento : [pedido.forma_pagamento];
  const formaPagamento = formas.length === 1 ? String(formas[0] || "").padStart(2, "0") : "";
  if (!["01", "03", "04", "17"].includes(formaPagamento)) adicionar("PAGAMENTO_NAO_SUPORTADO", "A forma de pagamento precisa de configuração fiscal específica.");
  const estornado = pedido.pix_estornado === true || pedido.pix_estorno_parcial === true || pedido.pix_estorno_em_andamento === true ||
    /REFUND|ESTORN/.test(String(pedido.pix_status || "").toUpperCase());
  let pagamento = "conferencia_manual";
  if (estornado) {
    pagamento = "estorno";
    adicionar("PAGAMENTO_ESTORNADO", "Há estorno ou devolução em andamento; revise antes de qualquer emissão.");
  } else if (formaPagamento === "17") {
    const confirmado = pedido.pix_confirmado === true && pedido.pix_status === "RECEIVED" &&
      typeof pedido.pix_pagamento_id === "string" && pedido.pix_pagamento_id.startsWith("pay_");
    pagamento = confirmado ? "pix_confirmado_no_pedido" : "pix_pendente";
    if (!confirmado) adicionar("PIX_NAO_CONFIRMADO", "O pedido não possui confirmação completa do PIX. Pedido aceito não significa pagamento recebido.");
    else avisos.push("O PIX está confirmado no registro do pedido. Antes de emitir, será necessário revalidar a situação do pagamento.");
  } else {
    adicionar("PAGAMENTO_CONFERENCIA_MANUAL", "Dinheiro/cartão: o recebimento precisa ser conferido. O status do pedido não comprova pagamento.");
  }
  if (resumo.entregaCentavos > 0 || resumo.taxaCartaoCentavos > 0) avisos.push("O tratamento fiscal das taxas de entrega e cartão precisa ser aprovado pela contabilidade.");
  if (pedido.agendamento) avisos.push("O pedido é agendado. Esta conferência não antecipa a emissão para a data da criação do pedido.");
  avisos.push("Os dados fiscais do destinatário serão definidos no fluxo de emissão; o CPF do pagador PIX não é adotado automaticamente como CPF do cliente.");

  const snapshot = {
    versao: VERSAO_CONFERENCIA, pedidoId, cnpjEmitente: CNPJ_EMITENTE,
    referenciaExterna: `FDAPP_${hash(["entregas-781a8", pedidoId]).slice(0, 32)}`,
    cliente: String(pedido.nome_destinatario || "").slice(0, 160),
    criadoEm: String(pedido.data_venda || ""), agendamento: String(pedido.agendamento || ""),
    tipoEntrega: String(pedido.tipo_entrega || ""), statusPedido: Number.isFinite(status) ? status : null,
    itens, resumo, formaPagamento, pagamento,
    pagamentoId: formaPagamento === "17" ? String(pedido.pix_pagamento_id || "") : null,
    endereco: pedido.tipo_entrega === "delivery" ? {
      logradouro: String(pedido.logradouro_destinatario || ""), numero: String(pedido.numero_destinatario || ""),
      bairro: String(pedido.bairro_destinatario || ""), complemento: String(pedido.complemento_destinatario || ""),
      cep: String(pedido.cep_destinatario || ""),
    } : null,
  };
  const fonteHash = hash({ snapshot, pendencias, avisos });
  const pedidoFonteHash = hashFontePedidoFiscal(pedidoId, pedido);
  return { estado: pendencias.length ? "pendencias" : "conferido", emissaoHabilitada: false,
    fonteHash, pedidoFonteHash, snapshot, pendencias, avisos };
}

module.exports = { CNPJ_EMITENTE, EMISSAO_HABILITADA, ETAPAS_PENDENTES, ErroFiscal,
  idValido, centavos, hash, hashFontePedidoFiscal, normalizarVinculo, conferirPedido };
