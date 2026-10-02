const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseValor,
  paraCentavos,
  eventoEhRelevante,
  eventoEhEstorno,
  statusDoEvento,
  eventoParaStatusConsultado,
  selecionarCobrancasExatas,
  selecionarCandidatoInstaSeguro,
  calcularJanelaInstaSeguraMinutos,
  validarPagamentoRecebido,
  atualizacaoOperacionalAoConfirmarPix,
  pedidoVisivelNoPainel,
} = require("../src/services/pixConfiavel");

const pedidoBase = {
  order_id: "pedido_123",
  origem: "app",
  forma_pagamento: ["17"],
  valor_venda: 150.25,
  pix_pagamento_id: "pay_abc",
};

const pagamentoBase = {
  id: "pay_abc",
  billingType: "PIX",
  status: "RECEIVED",
  value: 150.25,
  externalReference: "pedido_123",
};

test("normaliza valores brasileiros em centavos sem tolerância silenciosa", () => {
  assert.equal(parseValor("1.234,56"), 1234.56);
  assert.equal(parseValor("150,25"), 150.25);
  assert.equal(paraCentavos("150,25"), 15025);
  assert.equal(paraCentavos(0.1 + 0.2), 30);
});

test("aprova apenas o vínculo direto completo", () => {
  const resultado = validarPagamentoRecebido({
    pagamento: pagamentoBase,
    pedido: pedidoBase,
    orderId: "pedido_123",
    paymentId: "pay_abc",
  });
  assert.equal(resultado.ok, true);
  assert.deepEqual(resultado.erros, []);
});

test("PIX próprio confirmado sai atomicamente do estado invisível", () => {
  const pedidoAguardando = { origem: "app", status: 1 };
  const atualizacao = atualizacaoOperacionalAoConfirmarPix(pedidoAguardando);
  const confirmado = { ...pedidoAguardando, ...atualizacao, pix_confirmado: true };

  assert.deepEqual(atualizacao, { status: 2, status_interno: "aceito" });
  assert.equal(pedidoVisivelNoPainel(confirmado), true);
});

test("confirmação financeira não aceita automaticamente pedido legado", () => {
  assert.deepEqual(
    atualizacaoOperacionalAoConfirmarPix({ origem: "instadelivery", status: 1 }),
    {}
  );
  assert.equal(pedidoVisivelNoPainel({ status: 1 }), true);
  assert.equal(pedidoVisivelNoPainel({ status: 4 }), false);
});

test("rejeita paymentId diferente do salvo no pedido", () => {
  const resultado = validarPagamentoRecebido({
    pagamento: { ...pagamentoBase, id: "pay_outro" },
    pedido: pedidoBase,
    orderId: "pedido_123",
    paymentId: "pay_outro",
  });
  assert.equal(resultado.ok, false);
  assert.ok(resultado.erros.includes("payment_id_nao_confere_com_pedido"));
  assert.ok(resultado.erros.includes("pedido_vinculado_a_outro_pagamento"));
});

test("rejeita externalReference de outro pedido", () => {
  const resultado = validarPagamentoRecebido({
    pagamento: { ...pagamentoBase, externalReference: "pedido_999" },
    pedido: pedidoBase,
    orderId: "pedido_123",
    paymentId: "pay_abc",
  });
  assert.equal(resultado.ok, false);
  assert.ok(resultado.erros.includes("external_reference_divergente"));
});

test("rejeita diferença de um centavo", () => {
  const resultado = validarPagamentoRecebido({
    pagamento: { ...pagamentoBase, value: 150.24 },
    pedido: pedidoBase,
    orderId: "pedido_123",
    paymentId: "pay_abc",
  });
  assert.equal(resultado.ok, false);
  assert.ok(resultado.erros.includes("valor_divergente"));
});

test("rejeita cobrança que não seja PIX", () => {
  const resultado = validarPagamentoRecebido({
    pagamento: { ...pagamentoBase, billingType: "CREDIT_CARD" },
    pedido: pedidoBase,
    orderId: "pedido_123",
    paymentId: "pay_abc",
  });
  assert.equal(resultado.ok, false);
  assert.ok(resultado.erros.includes("billing_type_nao_pix"));
});

test("rejeita cobrança PIX que ainda não esteja RECEIVED", () => {
  for (const status of ["PENDING", "OVERDUE", "CONFIRMED", "REFUND_REQUESTED"]) {
    const resultado = validarPagamentoRecebido({
      pagamento: { ...pagamentoBase, status },
      pedido: pedidoBase,
      orderId: "pedido_123",
      paymentId: "pay_abc",
    });
    assert.equal(resultado.ok, false, status);
    assert.ok(resultado.erros.includes("status_nao_recebido"), status);
  }
});

test("confirmação manual legada pode dispensar referência, mas não os fatos financeiros", () => {
  const pedidoLegado = {
    order_id: "legado_1",
    forma_pagamento: ["PIX"],
    valor_venda: "89,90",
  };
  const pagamentoLegado = {
    id: "pay_legado",
    billingType: "PIX",
    status: "RECEIVED",
    value: 89.9,
    externalReference: "ORDER_PIX",
  };

  const valido = validarPagamentoRecebido({
    pagamento: pagamentoLegado,
    pedido: pedidoLegado,
    orderId: "legado_1",
    paymentId: "pay_legado",
    exigirIdSalvo: false,
    exigirReferencia: false,
  });
  assert.equal(valido.ok, true);

  const valorErrado = validarPagamentoRecebido({
    pagamento: { ...pagamentoLegado, value: 89.89 },
    pedido: pedidoLegado,
    orderId: "legado_1",
    paymentId: "pay_legado",
    exigirIdSalvo: false,
    exigirReferencia: false,
  });
  assert.equal(valorErrado.ok, false);
  assert.ok(valorErrado.erros.includes("valor_divergente"));
});

test("classifica somente eventos financeiros relevantes e seus estornos", () => {
  assert.equal(eventoEhRelevante("PAYMENT_RECEIVED"), true);
  assert.equal(eventoEhRelevante("PAYMENT_CREATED"), false);
  assert.equal(eventoEhEstorno("PAYMENT_REFUNDED"), true);
  assert.equal(eventoEhEstorno("PAYMENT_RECEIVED"), false);
  assert.equal(statusDoEvento("PAYMENT_PARTIALLY_REFUNDED"), "PARTIALLY_REFUNDED");
  assert.equal(eventoParaStatusConsultado("REFUNDED"), "PAYMENT_REFUNDED");
  assert.equal(eventoParaStatusConsultado("PENDING"), null);
});

test("recupera somente a cobrança exata após resposta inconclusiva de criação", () => {
  const cobrancas = [
    {
      id: "pay_certa",
      customer: "cus_1",
      billingType: "PIX",
      externalReference: "pedido_1",
      value: 72.5,
      status: "PENDING",
    },
    {
      id: "pay_valor_errado",
      customer: "cus_1",
      billingType: "PIX",
      externalReference: "pedido_1",
      value: 72.49,
      status: "PENDING",
    },
    {
      id: "pay_cliente_errado",
      customer: "cus_2",
      billingType: "PIX",
      externalReference: "pedido_1",
      value: 72.5,
      status: "PENDING",
    },
    {
      id: "pay_estornada",
      customer: "cus_1",
      billingType: "PIX",
      externalReference: "pedido_1",
      value: 72.5,
      status: "REFUNDED",
    },
  ];

  const exatas = selecionarCobrancasExatas(cobrancas, {
    customerId: "cus_1",
    valor: 72.5,
    orderId: "pedido_1",
  });
  assert.deepEqual(exatas.map((item) => item.id), ["pay_certa"]);
});

test("seleciona o unico pedido InstaDelivery com sinais fortes para ORDER_PIX", () => {
  const candidato = {
    order_id: "144047857",
    origem: 1,
    status: 2,
    forma_pagamento: ["PIX"],
    valor_venda: "175,00",
    nome_destinatario: "  João   D'Ávila Neto ",
    data_venda: "2026-07-27 08:10:00",
  };

  const selecionado = selecionarCandidatoInstaSeguro({
    pagamento: { externalReference: "ORDER_PIX", value: 175 },
    pagador: { nome: "JOAO D AVILA NETO" },
    candidatos: [candidato],
    eventoRecebidoEm: "2026-07-27T11:29:00.000Z",
    janelaMinutos: 20,
  });

  assert.equal(selecionado, candidato);
});

test("a janela PIX do InstaDelivery acompanha os dias permitidos para agendamento", () => {
  assert.equal(calcularJanelaInstaSeguraMinutos(0), 360);
  assert.equal(calcularJanelaInstaSeguraMinutos(1), 24 * 60);
  assert.equal(calcularJanelaInstaSeguraMinutos(5), 5 * 24 * 60);
  assert.equal(calcularJanelaInstaSeguraMinutos(99), 30 * 24 * 60);
});

test("aceita wrapper de candidato e rotulo textual explicito do InstaDelivery", () => {
  const candidato = {
    id: "144047858",
    pedido: {
      origem: "insta_delivery",
      status: 5,
      valor_venda: 126.45,
      nome_destinatario: "Maria da Silva",
      data_venda: "2026-07-27 05:50:00",
    },
  };

  const selecionado = selecionarCandidatoInstaSeguro({
    pagamento: { externalReference: "ORDER_PIX", value: "126,45" },
    pagador: { nome: "Mária da Silva" },
    candidatos: [candidato],
    eventoRecebidoEm: new Date("2026-07-27T08:56:00.000Z"),
    janelaMinutos: 10,
  });

  assert.equal(selecionado, candidato);
});

test("aceita nome truncado como prefixo somente quando o prefixo e longo", () => {
  const candidato = {
    origem: 1,
    status: 2,
    valor_venda: 175,
    nome_destinatario: "Luana Claudia Magalhães de Almei",
    data_venda: "2026-07-27 05:00:00",
  };

  const selecionado = selecionarCandidatoInstaSeguro({
    pagamento: { externalReference: "ORDER_PIX", value: 175 },
    pagador: { nome: "Luana Claudia Magalhães de Almeida Silva" },
    candidatos: [candidato],
    eventoRecebidoEm: "2026-07-27T11:42:00.000Z",
  });

  assert.equal(selecionado, candidato);
});

test("rejeita compatibilidade por prefixo quando o nome menor e curto", () => {
  const candidato = {
    origem: 1,
    status: 2,
    valor_venda: 175,
    nome_destinatario: "Maria da Silva",
    data_venda: "2026-07-27 08:20:00",
  };

  const selecionado = selecionarCandidatoInstaSeguro({
    pagamento: { externalReference: "ORDER_PIX", value: 175 },
    pagador: { nome: "Maria da Silva Oliveira" },
    candidatos: [candidato],
    eventoRecebidoEm: "2026-07-27T11:29:00.000Z",
  });

  assert.equal(selecionado, null);
});

test("nao seleciona quando mais de um pedido passa por todos os criterios", () => {
  const base = {
    origem: 1,
    status: 2,
    valor_venda: 175,
    nome_destinatario: "João da Silva",
    data_venda: "2026-07-27 08:20:00",
  };

  const selecionado = selecionarCandidatoInstaSeguro({
    pagamento: { externalReference: "ORDER_PIX", value: 175 },
    pagador: { nome: "João da Silva" },
    candidatos: [
      { ...base, order_id: "144047857" },
      { ...base, order_id: "144047858", data_venda: "2026-07-27 08:22:00" },
    ],
    eventoRecebidoEm: "2026-07-27T11:29:00.000Z",
    janelaMinutos: 15,
  });

  assert.equal(selecionado, null);
});

test("exige externalReference exatamente ORDER_PIX", () => {
  const candidato = {
    origem: 1,
    status: 2,
    valor_venda: 175,
    nome_destinatario: "João da Silva",
    data_venda: "2026-07-27 08:20:00",
  };

  for (const externalReference of ["PIX", "order_pix", " ORDER_PIX ", null]) {
    const selecionado = selecionarCandidatoInstaSeguro({
      pagamento: { externalReference, value: 175 },
      pagador: { nome: "João da Silva" },
      candidatos: [candidato],
      eventoRecebidoEm: "2026-07-27T11:29:00.000Z",
      janelaMinutos: 15,
    });
    assert.equal(selecionado, null, String(externalReference));
  }
});

test("rejeita candidatos sem todos os sinais fortes exigidos", () => {
  const base = {
    origem: 1,
    status: 2,
    valor_venda: 175,
    nome_destinatario: "João da Silva",
    data_venda: "2026-07-27 08:20:00",
  };
  const invalidos = [
    { ...base, origem: undefined },
    { ...base, origem: "app" },
    { ...base, status: 4 },
    { ...base, pix_confirmado: true },
    { ...base, pix_pagamento_id: "pay_existente" },
    { ...base, valor_venda: 174.99 },
    { ...base, nome_destinatario: "João da Costa" },
    { ...base, nome_destinatario: "João" },
    { ...base, data_venda: "2026-07-27 08:00:00" },
    { ...base, data_venda: "2026-07-27 08:31:00" },
    { ...base, data_venda: "2026-07-27" },
  ];

  const selecionado = selecionarCandidatoInstaSeguro({
    pagamento: { externalReference: "ORDER_PIX", value: 175 },
    pagador: { nome: "João da Silva" },
    candidatos: invalidos,
    eventoRecebidoEm: "2026-07-27T11:29:00.000Z",
    janelaMinutos: 15,
  });

  assert.equal(selecionado, null);
});

test("aceita somente status ativos do InstaDelivery e rejeita cancelado", () => {
  const base = {
    origem: 1,
    valor_venda: 175,
    nome_destinatario: "João da Silva",
    data_venda: "2026-07-27 08:20:00",
  };
  const entrada = {
    pagamento: { externalReference: "ORDER_PIX", value: 175 },
    pagador: { nome: "João da Silva" },
    eventoRecebidoEm: "2026-07-27T11:29:00.000Z",
    janelaMinutos: 15,
  };

  for (const status of [1, 2, 3, 5]) {
    const candidato = { ...base, status };
    assert.equal(
      selecionarCandidatoInstaSeguro({
        ...entrada,
        candidatos: [candidato],
      }),
      candidato,
      `status ${status}`
    );
  }

  for (const status of [4, undefined]) {
    assert.equal(
      selecionarCandidatoInstaSeguro({
        ...entrada,
        candidatos: [{ ...base, status }],
      }),
      null,
      `status ${String(status)}`
    );
  }
});

test("usa janela padrao de 360 minutos e permite override mais restrito", () => {
  const candidato = {
    origem: 1,
    status: 2,
    valor_venda: 175,
    nome_destinatario: "João da Silva",
    data_venda: "2026-07-27 08:20:00",
  };
  const entrada = {
    pagamento: { externalReference: "ORDER_PIX", value: 175 },
    pagador: { nome: "João da Silva" },
    candidatos: [candidato],
    eventoRecebidoEm: "2026-07-27T11:29:00.000Z",
  };

  assert.equal(selecionarCandidatoInstaSeguro(entrada), candidato);
  assert.equal(
    selecionarCandidatoInstaSeguro({ ...entrada, janelaMinutos: -1 }),
    null
  );
  assert.equal(
    selecionarCandidatoInstaSeguro({ ...entrada, janelaMinutos: 5 }),
    null
  );
});

test("aceita instante do evento como numero ou Firestore Timestamp", () => {
  const candidato = {
    origem: 1,
    status: 2,
    valor_venda: 175,
    nome_destinatario: "João da Silva",
    data_venda: "2026-07-27 08:20:00",
  };
  const eventoEmMs = Date.parse("2026-07-27T11:29:00.000Z");
  const entrada = {
    pagamento: { externalReference: "ORDER_PIX", value: 175 },
    pagador: { nome: "João da Silva" },
    candidatos: [candidato],
    janelaMinutos: 15,
  };

  assert.equal(
    selecionarCandidatoInstaSeguro({
      ...entrada,
      eventoRecebidoEm: eventoEmMs,
    }),
    candidato
  );
  assert.equal(
    selecionarCandidatoInstaSeguro({
      ...entrada,
      eventoRecebidoEm: { toMillis: () => eventoEmMs },
    }),
    candidato
  );
});
