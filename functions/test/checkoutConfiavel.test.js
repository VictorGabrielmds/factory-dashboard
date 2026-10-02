const test = require("node:test");
const assert = require("node:assert/strict");

const {
  gerarHashCheckout,
  decidirReivindicacao,
  resultadoDoPedidoPersistido,
  montarConclusaoQrPix,
  erroAsaasEhDefinitivo,
} = require("../src/services/checkoutConfiavel");

test("a chave técnica não altera a identidade do mesmo checkout", () => {
  const base = {
    nome: "Maria",
    itens: [{ quantidade: 2, produtoId: "coxinha" }],
    endereco: { numero: "10", bairro: "Centro" },
  };
  assert.equal(
    gerarHashCheckout({ ...base, idempotencyKey: "tentativa_a" }),
    gerarHashCheckout({
      endereco: { bairro: "Centro", numero: "10" },
      itens: [{ produtoId: "coxinha", quantidade: 2 }],
      nome: "Maria",
      idempotencyKey: "tentativa_b",
    })
  );
  assert.notEqual(
    gerarHashCheckout(base),
    gerarHashCheckout({ ...base, itens: [{ quantidade: 3, produtoId: "coxinha" }] })
  );
});

test("uma tentativa concluída sempre devolve o mesmo resultado", () => {
  const resultado = { orderId: "123456789", pix: null };
  assert.deepEqual(
    decidirReivindicacao(
      {
        uid: "cliente_1",
        payloadHash: "hash",
        estado: "concluido",
        resultado,
      },
      { uid: "cliente_1", payloadHash: "hash", agoraMs: 1000 }
    ),
    { acao: "retornar", resultado }
  );
});

test("uma execução ativa não pode ser tomada antes do fim do lease", () => {
  const decisao = decidirReivindicacao(
    {
      uid: "cliente_1",
      payloadHash: "hash",
      estado: "processando",
      leaseAte: { toMillis: () => 5000 },
      pedidoId: "123456789",
    },
    { uid: "cliente_1", payloadHash: "hash", agoraMs: 1000 }
  );
  assert.equal(decisao.acao, "aguardar");
});

test("uma execução abandonada retoma o mesmo pedido, nunca gera outro", () => {
  const decisao = decidirReivindicacao(
    {
      uid: "cliente_1",
      payloadHash: "hash",
      estado: "processando",
      leaseAte: { toMillis: () => 900 },
      pedidoId: "123456789",
    },
    { uid: "cliente_1", payloadHash: "hash", agoraMs: 1000 }
  );
  assert.deepEqual(decisao, { acao: "retomar", pedidoId: "123456789" });
});

test("a mesma chave não pode ser reutilizada por outro cliente ou outro conteúdo", () => {
  const registro = {
    uid: "cliente_1",
    payloadHash: "hash_a",
    estado: "falhou",
    pedidoId: "123456789",
  };
  assert.equal(
    decidirReivindicacao(registro, {
      uid: "cliente_2",
      payloadHash: "hash_a",
      agoraMs: 1000,
    }).acao,
    "recusar_usuario"
  );
  assert.equal(
    decidirReivindicacao(registro, {
      uid: "cliente_1",
      payloadHash: "hash_b",
      agoraMs: 1000,
    }).acao,
    "recusar_conteudo"
  );
});

test("um pedido PIX só é recuperado como concluído quando o QR está durável", () => {
  const incompleto = resultadoDoPedidoPersistido("123456789", {
    status: 2,
    forma_pagamento: ["17"],
    pix_pagamento_id: "pay_1",
  });
  assert.equal(incompleto, null);

  const completo = resultadoDoPedidoPersistido("123456789", {
    status: 2,
    forma_pagamento: ["17"],
    pix_pagamento_id: "pay_1",
    pix_qrcode_base64: "imagem",
    pix_copia_cola: "codigo",
    numero_pedido_cliente: 4,
  });
  assert.deepEqual(completo, {
    orderId: "123456789",
    pix: { qrCodeBase64: "imagem", copiaCola: "codigo" },
    numeroPedidoCliente: 4,
  });
});

test("QR persistido depois do webhook não rebaixa PIX recebido para pendente", () => {
  const conclusao = montarConclusaoQrPix({
    pedido: {
      status: 2,
      pix_pagamento_id: "pay_1",
      pix_confirmado: true,
      pix_status: "RECEIVED",
      pix_auditoria_etapa: 0,
    },
    paymentId: "pay_1",
    qrCode: { qrCodeBase64: "imagem", copiaCola: "codigo" },
  });

  assert.deepEqual(conclusao, {
    atualizacao: {
      status: 2,
      pix_pagamento_id: "pay_1",
      pix_qrcode_base64: "imagem",
      pix_copia_cola: "codigo",
      pix_checkout_pendente: false,
    },
    deveAgendarVerificacaoInicial: false,
  });
});

test("QR mantém pedido em aguardando PIX quando não há fato financeiro", () => {
  const conclusao = montarConclusaoQrPix({
    pedido: { status: 1, pix_status: "QR_PENDING" },
    paymentId: "pay_1",
    qrCode: { qrCodeBase64: "imagem", copiaCola: "codigo" },
  });

  assert.equal(conclusao.atualizacao.status, 1);
  assert.equal(conclusao.atualizacao.pix_confirmado, false);
  assert.equal(conclusao.atualizacao.pix_status, "PENDING");
  assert.equal(conclusao.atualizacao.pix_auditoria_etapa, -1);
  assert.equal(conclusao.deveAgendarVerificacaoInicial, true);
});

test("somente rejeições definitivas do Asaas permitem desfazer sem cobrança conhecida", () => {
  assert.equal(erroAsaasEhDefinitivo({ response: { status: 400 } }), true);
  assert.equal(erroAsaasEhDefinitivo({ response: { status: 422 } }), true);
  assert.equal(erroAsaasEhDefinitivo({ response: { status: 429 } }), false);
  assert.equal(erroAsaasEhDefinitivo({ response: { status: 503 } }), false);
  assert.equal(erroAsaasEhDefinitivo({ resultadoInconclusivo: true }), false);
  assert.equal(erroAsaasEhDefinitivo(new Error("rede caiu")), false);
});

test("QR tardio não promove estorno nem reabre pedido cancelado", () => {
  for (const [status, pix_status] of [[1, "REFUNDED"], [4, "REFUNDED"], [3, "RECEIVED"], [2, "PARTIALLY_REFUNDED"]]) {
    const conclusao = montarConclusaoQrPix({
      pedido: { status, pix_status }, paymentId: "pay_1",
      qrCode: { qrCodeBase64: "imagem", copiaCola: "codigo" },
    });
    assert.equal(conclusao.atualizacao.status, status);
    assert.equal(Object.hasOwn(conclusao.atualizacao, "pix_status"), false);
    assert.equal(Object.hasOwn(conclusao.atualizacao, "pix_confirmado"), false);
    assert.equal(conclusao.deveAgendarVerificacaoInicial, false);
  }
});
