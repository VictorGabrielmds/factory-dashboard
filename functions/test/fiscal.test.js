const test = require("node:test");
const assert = require("node:assert/strict");
const { centavos, conferirPedido, normalizarVinculo, ErroFiscal } = require("../src/fiscal/modelo");
const { criarConsultaEficiencia } = require("../src/fiscal/eficiencia");
const { exigirEquipeFiscal, autorizarAcaoFiscal } = require("../src/fiscal/autenticacao");
const { criarServicoFiscal } = require("../src/fiscal/servico");
const { idOperacaoFiscal } = require("../src/fiscal/operacoes");
const {
  moeda,
  construirComandoPreVenda,
  interpretarRespostaPreVenda,
  construirComandoAutorizacao,
  interpretarRespostaAutorizacao,
} = require("../src/fiscal/contratoEficiencia");

const instante = ms => ({ toMillis: () => ms, toDate: () => new Date(ms) });
const revisadoEm = instante(Date.UTC(2026, 8, 3, 12));
const produto = { nome: "Coxinha", categoria: "Salgados", disponivel: true, preco: 900 };
const vinculo = { codigoProduto: "1", nomeEf: "COXINHA FRANGO", revisado: true,
  revisadoPor: "operador", revisadoEm, nomeProdutoNaRevisao: "Coxinha", revisao: "v1" };
const pedido = { origem: "app", clienteUid: "cliente", order_id: "app123", status: 2,
  nome_destinatario: "Cliente de teste", tipo_entrega: "delivery", data_venda: "2026-09-03 09:00:00",
  produto_id_item: ["coxinha"], descricao_item: ["Coxinha"], quantidade_item: [10], valor_total_item: [8.5],
  valor_itens: 8.5, valor_desconto: 0.5, valor_taxa: 2, valor_taxa_cartao: 0, valor_venda: 10,
  forma_pagamento: ["17"], pix_confirmado: true, pix_status: "RECEIVED", pix_pagamento_id: "pay_teste" };
const conferir = (mudancas = {}, produtos = { coxinha: produto }, vinculos = { coxinha: vinculo }) =>
  conferirPedido("app123", { ...pedido, ...mudancas }, produtos, vinculos);
const tem = (resultado, codigo) => resultado.pendencias.some(p => p.codigo === codigo);

test("centavos exatos: aceita centavos e resíduos de ponto flutuante", () => {
  for (const [valor, esperado] of [["53.50", 5350], ["53,50", 5350], [0.1 + 0.2, 30], [0, 0], [1e6, 1e8]]) {
    assert.equal(centavos(valor), esperado);
  }
});
test("centavos: rejeita valores parciais, negativos, subcentavos e tipos inválidos", () => {
  for (const valor of ["", " 10", "10abc", "1.000,00", "NaN", "1e2", 1.001, -1, NaN, Infinity, null, false, {}, 1000001]) {
    assert.equal(centavos(valor), null, String(valor));
  }
});
test("conferência válida nunca habilita emissão e não usa preço atual nem CPF do pagador", () => {
  const resultado = conferir({ pix_pagador_cpf: "NAO_COPIAR", telefone_destinatario: "NAO_COPIAR" });
  assert.equal(resultado.estado, "conferido");
  assert.equal(resultado.emissaoHabilitada, false);
  assert.equal(resultado.snapshot.itens[0].totalCentavos, 850);
  assert.equal(resultado.snapshot.resumo.totalCentavos, 1000);
  assert.match(resultado.snapshot.referenciaExterna, /^FDAPP_[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(resultado).includes("NAO_COPIAR"));
});
test("InstaDelivery, despesas de motoboy e pedidos sem dono ficam fora do fluxo", () => {
  for (const mudancas of [{ origem: 1 }, { origem: "instadelivery" }, { avulso: true }, { clienteUid: "" }]) {
    assert.throws(() => conferir(mudancas), { codigo: "ORIGEM_NAO_ELEGIVEL" });
  }
});
test("ID inválido e pedido ausente são rejeitados antes da conferência", () => {
  assert.throws(() => conferirPedido("../outro", pedido), { codigo: "PEDIDO_ID_INVALIDO" });
  assert.throws(() => conferirPedido("app123", null), { codigo: "PEDIDO_NAO_ENCONTRADO" });
});
for (const [nome, alteracao, codigo] of [
  ["ID divergente", { order_id: "outro" }, "ID_DIVERGENTE"],
  ["cancelado", { status: 4 }, "PEDIDO_CANCELADO"],
  ["cancelado internamente", { status_interno: "cancelado" }, "PEDIDO_CANCELADO"],
  ["status desconhecido", { status: 999 }, "STATUS_DESCONHECIDO"],
  ["sem nome", { nome_destinatario: " " }, "CLIENTE_SEM_NOME"],
  ["entrega desconhecida", { tipo_entrega: "mesa" }, "ENTREGA_NAO_DEFINIDA"],
  ["arrays diferentes", { quantidade_item: [] }, "ITENS_INCONSISTENTES"],
  ["quantidade zero", { quantidade_item: [0] }, "QUANTIDADE_INVALIDA"],
  ["quantidade fracionada", { quantidade_item: [0.5] }, "QUANTIDADE_INVALIDA"],
  ["item gratuito", { valor_total_item: [0] }, "VALOR_ITEM_INVALIDO"],
  ["subtotal diferente", { valor_itens: 9 }, "SUBTOTAL_DIVERGENTE"],
  ["total diferente", { valor_venda: 9 }, "TOTAL_DIVERGENTE"],
  ["desconto excessivo", { valor_desconto: 99 }, "DESCONTO_INVALIDO"],
  ["total inválido", { valor_venda: "9oops" }, "VALORES_INVALIDOS"],
  ["mais de um pagamento", { forma_pagamento: ["17", "01"] }, "PAGAMENTO_NAO_SUPORTADO"],
  ["forma externa", { forma_pagamento: ["43"] }, "PAGAMENTO_NAO_SUPORTADO"],
  ["aceito sem PIX", { pix_confirmado: false }, "PIX_NAO_CONFIRMADO"],
  ["PIX sem identificação", { pix_pagamento_id: null }, "PIX_NAO_CONFIRMADO"],
  ["PIX com status pendente", { pix_status: "PENDING" }, "PIX_NAO_CONFIRMADO"],
  ["PIX estornado", { pix_estornado: true }, "PAGAMENTO_ESTORNADO"],
  ["PIX estorno parcial", { pix_estorno_parcial: true }, "PAGAMENTO_ESTORNADO"],
  ["PIX em estorno", { pix_status: "REFUND_REQUESTED" }, "PAGAMENTO_ESTORNADO"],
  ["dinheiro aceito", { forma_pagamento: ["01"] }, "PAGAMENTO_CONFERENCIA_MANUAL"],
  ["cartão aceito", { forma_pagamento: ["03"] }, "PAGAMENTO_CONFERENCIA_MANUAL"],
]) {
  test(`conferência aponta ${nome}`, () => {
    const resultado = conferir(alteracao);
    assert.ok(tem(resultado, codigo));
    assert.equal(resultado.estado, "pendencias");
    assert.equal(resultado.emissaoHabilitada, false);
  });
}
test("vínculo ausente, não revisado e produto renomeado impedem conferência limpa", () => {
  assert.ok(tem(conferir({}, {}, {}), "PRODUTO_AUSENTE"));
  assert.ok(tem(conferir({}, { coxinha: produto }, {}), "VINCULO_AUSENTE"));
  for (const alteracao of [{ revisado: false }, { revisadoPor: null }, { revisadoEm: null }, { nomeProdutoNaRevisao: "outro" }]) {
    assert.ok(tem(conferir({}, { coxinha: produto }, { coxinha: { ...vinculo, ...alteracao } }), "VINCULO_NAO_REVISADO"));
  }
});
test("serviços são sinalizados e não podem ser mapeados como mercadorias", () => {
  assert.ok(tem(conferir({}, { coxinha: { ...produto, itemSistema: true } }), "SERVICO_NAO_SUPORTADO"));
  assert.throws(() => normalizarVinculo(vinculo, { itemSistema: true }), { codigo: "PRODUTO_NAO_ELEGIVEL" });
});
test("vínculo exige código interno, nome e marcação explícita", () => {
  for (const codigoProduto of ["0", "01", "abc", "-1", "1/2", "1234567890123456"]) {
    assert.throws(() => normalizarVinculo({ ...vinculo, codigoProduto }, produto), { codigo: "CODIGO_EF_INVALIDO" });
  }
  assert.throws(() => normalizarVinculo({ ...vinculo, nomeEf: "" }, produto), { codigo: "NOME_EF_INVALIDO" });
  assert.throws(() => normalizarVinculo({ ...vinculo, revisado: "true" }, produto), { codigo: "REVISAO_INVALIDA" });
  assert.equal(normalizarVinculo({ ...vinculo, codigoProduto: " 12 " }, produto).codigoProduto, "12");
});
test("referência externa é estável; revisão muda somente com dados relevantes", () => {
  const primeiro = conferir();
  assert.equal(conferir({ metadadoIrrelevante: true }).fonteHash, primeiro.fonteHash);
  assert.notEqual(conferir({ valor_venda: 11 }).fonteHash, primeiro.fonteHash);
  assert.equal(conferir({ valor_venda: 11 }).snapshot.referenciaExterna, primeiro.snapshot.referenciaExterna);
});
test("agendamento gera orientação sem antecipar emissão", () => {
  const resultado = conferir({ agendamento: "Dia 05/09 - 14:00", tipo_entrega: "retirada" });
  assert.equal(resultado.snapshot.endereco, null);
  assert.ok(resultado.avisos.some(a => a.includes("não antecipa")));
  assert.equal(resultado.emissaoHabilitada, false);
});

function operacaoFiscalSimples(mudancasSnapshot = {}) {
  const conferencia = conferir({
    tipo_entrega: "retirada",
    valor_desconto: 0,
    valor_taxa: 0,
    valor_itens: 8.5,
    valor_venda: 8.5,
  });
  return {
    estado: "preparada",
    ambiente: "homologacao",
    cnpjEmitente: "11560207000137",
    referenciaExterna: conferencia.snapshot.referenciaExterna,
    snapshot: { ...conferencia.snapshot, ...mudancasSnapshot },
  };
}

test("contrato de pre-venda usa valores exatos, codigo interno e nenhum cadastro fiscal inventado", () => {
  const operacao = operacaoFiscalSimples();
  const comando = construirComandoPreVenda(operacao);
  assert.equal(comando.metodo, "POST");
  assert.equal(comando.caminho, "/api/vendas/v1/venda");
  assert.deepEqual(comando.corpo.codigo_produto, ["1"]);
  assert.deepEqual(comando.corpo.quantidade_item, ["10"]);
  assert.deepEqual(comando.corpo.valor_unitario_item, ["0.85"]);
  assert.deepEqual(comando.corpo.valor_total, ["8.50"]);
  assert.equal(comando.corpo.valor_venda, "8.50");
  assert.deepEqual(comando.corpo.forma_pagamento, ["17"]);
  assert.equal("codigo_item" in comando.corpo, false);
  assert.equal("ncm_item" in comando.corpo, false);
  assert.equal("ean_item" in comando.corpo, false);
  assert.equal(JSON.stringify(comando).includes("NAO_COPIAR"), false);
});

test("contrato fiscal nunca arredonda centavos nem decide sozinho o tratamento de taxas", () => {
  assert.equal(moeda(0), "0.00");
  assert.equal(moeda(5350), "53.50");
  assert.throws(() => moeda(1.5), { codigo: "VALOR_FISCAL_INVALIDO" });
  const comTaxa = operacaoFiscalSimples();
  comTaxa.snapshot.resumo = { ...comTaxa.snapshot.resumo, entregaCentavos: 100, totalCentavos: 950 };
  assert.throws(() => construirComandoPreVenda(comTaxa), { codigo: "POLITICA_TAXAS_NAO_CONFIRMADA" });
  const indivisivel = operacaoFiscalSimples();
  indivisivel.snapshot.itens = [{ ...indivisivel.snapshot.itens[0], quantidade: 3, totalCentavos: 850 }];
  assert.throws(() => construirComandoPreVenda(indivisivel), { codigo: "VALOR_UNITARIO_NAO_CONFIRMADO" });
});

test("contrato de pre-venda recusa operacao, data ou PIX nao confirmados", () => {
  assert.throws(() => construirComandoPreVenda(null), { codigo: "OPERACAO_FISCAL_INVALIDA" });
  assert.throws(() => construirComandoPreVenda(operacaoFiscalSimples({ criadoEm: "03/09/2026" })), { codigo: "DATA_VENDA_INVALIDA" });
  assert.throws(() => construirComandoPreVenda(operacaoFiscalSimples({ pagamento: "pix_pendente" })), { codigo: "PAGAMENTO_FISCAL_NAO_CONFIRMADO" });
});

test("resposta da pre-venda precisa identificar exatamente CNPJ e referencia", () => {
  const operacao = operacaoFiscalSimples();
  const resposta = interpretarRespostaPreVenda({
    cadastro_nacional: "11.560.207/0001-37",
    codigo_parceiro: operacao.referenciaExterna,
    codigo_ef: 990000003,
    descricao: "conteudo livre nao persistido",
  }, operacao);
  assert.equal(resposta.codigoEf, "990000003");
  assert.equal(resposta.respostaHash.length, 64);
  assert.equal(JSON.stringify(resposta).includes("conteudo livre"), false);
  assert.throws(() => interpretarRespostaPreVenda({
    cadastro_nacional: "00000000000000", codigo_parceiro: operacao.referenciaExterna, codigo_ef: 1,
  }, operacao), { codigo: "EF_RESPOSTA_PRE_VENDA_INVALIDA" });
  assert.throws(() => interpretarRespostaPreVenda({
    cadastro_nacional: "11560207000137", codigo_parceiro: "OUTRA", codigo_ef: 1,
  }, operacao), { codigo: "EF_RESPOSTA_PRE_VENDA_INVALIDA" });
});

test("autorizacao so e montada depois de persistir a pre-venda exata", () => {
  const operacao = operacaoFiscalSimples();
  assert.throws(() => construirComandoAutorizacao(operacao), { codigo: "PRE_VENDA_NAO_CONFIRMADA" });
  operacao.estado = "pre_venda_criada";
  operacao.provedor = { codigoEf: "990000003" };
  assert.deepEqual(construirComandoAutorizacao(operacao), {
    metodo: "POST",
    caminho: `/api/vendas/v1/venda/${operacao.referenciaExterna}/autorizar`,
    corpo: { cadastro_nacional: "11560207000137" },
  });
});

test("resposta de autorizacao e validada sem devolver XML ou DANFE aos logs", () => {
  const xml = "<nfeProc versao=\"4.00\"><NFe /></nfeProc>";
  const danfe = Buffer.from("PDF sintetico de teste").toString("base64");
  const resultado = interpretarRespostaAutorizacao({ modelo: "65", xml, danfe });
  assert.equal(resultado.documentosPresentes, true);
  assert.equal(resultado.xmlHash.length, 64);
  assert.equal(resultado.danfeHash.length, 64);
  assert.equal(JSON.stringify(resultado).includes("nfeProc"), false);
  assert.throws(() => interpretarRespostaAutorizacao({ modelo: "65", xml: "incompleto", danfe }), {
    codigo: "EF_RESPOSTA_AUTORIZACAO_INVALIDA",
  });
});

const tokenTeste = "somente_fixture_sem_credencial_real";
test("conexão usa apenas GET, host e CNPJ fixos, sem redirecionamento nem dados privados no retorno", async () => {
  let chamadas = 0;
  const consultar = criarConsultaEficiencia({ token: tokenTeste, fetchImpl: async (url, opcoes) => {
    chamadas++;
    assert.equal(url, "https://api.eficiencia.app/api/vendas/v1/venda/contingencia/listar?cadastro_nacional=11560207000137&origem=api");
    assert.equal(opcoes.method, "GET"); assert.equal(opcoes.redirect, "error");
    assert.equal(opcoes.headers.Authorization, `Bearer ${tokenTeste}`);
    return Response.json({ contingencias: [{ cpf: "NAO_RETORNAR", chave: "NAO_RETORNAR" }] });
  }});
  const resultado = await consultar();
  assert.equal(chamadas, 1); assert.equal(resultado.estado, "ok");
  assert.ok(!JSON.stringify(resultado).includes("NAO_RETORNAR"));
});
for (const status of [400, 401, 403, 500, 503]) {
  test(`API HTTP ${status}: erro seguro e nenhuma repetição automática`, async () => {
    let chamadas = 0;
    const consultar = criarConsultaEficiencia({ token: tokenTeste, fetchImpl: async () => {
      chamadas++; return new Response(`SEGREDO ${tokenTeste}`, { status });
    }});
    await assert.rejects(consultar, erro => erro instanceof ErroFiscal && !erro.message.includes(tokenTeste));
    assert.equal(chamadas, 1);
  });
}
test("falha de rede não expõe requisição ou token e não é repetida", async () => {
  let chamadas = 0;
  await assert.rejects(criarConsultaEficiencia({ token: tokenTeste, fetchImpl: async () => {
    chamadas++; throw new Error(tokenTeste);
  }}), { codigo: "EF_SEM_RESPOSTA" });
  assert.equal(chamadas, 1);
});
test("contrato inválido e resposta acima do limite são rejeitados", async () => {
  for (const body of ["<html>erro</html>", JSON.stringify({ vendas: [] }), " ".repeat(1024 * 1024 + 1)]) {
    await assert.rejects(criarConsultaEficiencia({ token: tokenTeste, fetchImpl: async () => new Response(body) }), { codigo: "EF_RESPOSTA_INVALIDA" });
  }
});
test("token inválido nunca sai pela rede", async () => {
  let chamadas = 0;
  await assert.rejects(criarConsultaEficiencia({ token: "invalido\n", fetchImpl: async () => { chamadas++; } }), { codigo: "TOKEN_FISCAL_INVALIDO" });
  assert.equal(chamadas, 0);
});

// Small in-memory Firestore double for service contracts; not an emulator and
// not used by the app. Rejects reads after writes and duplicate create().
function bancoMemoria(inicial = {}) {
  const documentos = new Map(Object.entries(inicial));
  const snapshot = caminho => ({ id: caminho.split("/").at(-1), exists: documentos.has(caminho), data: () => documentos.get(caminho) });
  const doc = caminho => ({ path: caminho, get: async () => snapshot(caminho),
    set: async dados => documentos.set(caminho, dados), collection: nome => colecao(`${caminho}/${nome}`) });
  const colecao = caminho => {
    let limite = Infinity, ordem;
    const ref = { doc: id => doc(`${caminho}/${id}`), limit: n => { limite = n; return ref; },
      orderBy: (campo, direcao) => { ordem = [campo, direcao]; return ref; }, get: async () => {
        let docs = [...documentos.keys()].filter(k => k.startsWith(`${caminho}/`) && k.split("/").length === caminho.split("/").length + 1).map(snapshot);
        if (ordem) docs.sort((a, b) => ((a.data()[ordem[0]]?.toMillis() || 0) - (b.data()[ordem[0]]?.toMillis() || 0)) * (ordem[1] === "desc" ? -1 : 1));
        docs = docs.slice(0, limite); return { docs, size: docs.length };
      }};
    return ref;
  };
  return { documentos, collection: colecao, runTransaction: async callback => {
    const escritas = [];
    const ler = async ref => { assert.equal(escritas.length, 0, "transaction read after write"); return snapshot(ref.path); };
    const resultado = await callback({ get: ler, getAll: (...refs) => Promise.all(refs.map(ler)),
      set: (ref, dados) => escritas.push([ref.path, dados]),
      create: (ref, dados) => { assert.ok(!documentos.has(ref.path), "duplicate create"); escritas.push([ref.path, dados]); } });
    for (const [caminho, dados] of escritas) documentos.set(caminho, dados);
    return resultado;
  }};
}
const usuario = { uid: "operador" };
function contexto(inicial = {}) {
  let agora = revisadoEm.toMillis();
  const db = bancoMemoria({ "produtos/coxinha": produto, "pedidos/app123": pedido, "fiscal_produtos/coxinha": vinculo, ...inicial });
  const Timestamp = { now: () => instante(agora), fromMillis: instante };
  return { db, Timestamp, avancar: ms => { agora += ms; } };
}
test("somente sessão de staff ativa; chave pública não substitui autenticação", async () => {
  const db = bancoMemoria({ "staff/operador": { ativo: true } });
  let chamadas = 0;
  const auth = { verifyIdToken: async (token, revogado) => {
    chamadas++; assert.equal(token, "sessao"); assert.equal(revogado, true); return usuario;
  }};
  await assert.rejects(() => exigirEquipeFiscal({ headers: { "x-api-key": "painel" } }, { auth, db }), { status: 401 });
  assert.equal(chamadas, 0);
  const operador = await exigirEquipeFiscal({ headers: { authorization: "Bearer sessao" } }, { auth, db });
  assert.equal(operador.uid, usuario.uid);
  assert.deepEqual(operador.papeis, ["operador_legado"]);
  assert.deepEqual(autorizarAcaoFiscal(operador, "conferirPedido"), {
    autorizada: true,
    modo: "permitida",
    capacidade: "fiscal.preparar",
    permitidaPorPerfil: true,
  });
  assert.throws(() => autorizarAcaoFiscal(operador, "emitir"), {
    codigo: "ACESSO_FISCAL_NEGADO",
    status: 403,
  });
  db.documentos.set("staff/operador", { ativo: false });
  await assert.rejects(() => exigirEquipeFiscal({ headers: { authorization: "Bearer sessao" } }, { auth, db }), { status: 403 });
  db.documentos.delete("staff/operador");
  await assert.rejects(() => exigirEquipeFiscal({ headers: { authorization: "Bearer sessao" } }, { auth, db }), { status: 403 });
  await assert.rejects(() => exigirEquipeFiscal({ headers: { authorization: "Bearer sessao" } }, {
    db, auth: { verifyIdToken: async () => { throw new Error("revoked"); } },
  }), { codigo: "SESSAO_INVALIDA" });
});
test("emissão e cancelamento exigem capacidade fiscal explícita", async () => {
  const db = bancoMemoria({
    "staff/fiscal": { ativo: true, papel: "fiscal", permissoesEstritas: true },
    "staff/atendimento": { ativo: true, papel: "atendimento", permissoesEstritas: true },
  });
  const auth = { verifyIdToken: async token => ({ uid: token }) };
  const fiscal = await exigirEquipeFiscal(
    { headers: { authorization: "Bearer fiscal" } },
    { auth, db }
  );
  const atendimento = await exigirEquipeFiscal(
    { headers: { authorization: "Bearer atendimento" } },
    { auth, db }
  );
  assert.equal(autorizarAcaoFiscal(fiscal, "emitir").capacidade, "fiscal.emitir");
  assert.equal(autorizarAcaoFiscal(fiscal, "cancelar").capacidade, "fiscal.cancelar");
  assert.throws(() => autorizarAcaoFiscal(atendimento, "emitir"), { status: 403 });
  assert.throws(() => autorizarAcaoFiscal(atendimento, "cancelar"), { status: 403 });
  assert.throws(() => autorizarAcaoFiscal(fiscal, "acao_inexistente"), { codigo: "ACAO_INVALIDA" });
});
test("conferir duas vezes conserva uma revisão e nunca altera pedido", async () => {
  const ctx = contexto(); const servico = criarServicoFiscal(ctx);
  const primeiro = await servico("conferirPedido", { pedidoId: "app123" }, usuario);
  ctx.avancar(1000);
  const segundo = await servico("conferirPedido", { pedidoId: "app123" }, usuario);
  assert.equal(primeiro.mesmaRevisao, false); assert.equal(segundo.mesmaRevisao, true);
  assert.equal(primeiro.conferencia.criadoEm, segundo.conferencia.criadoEm);
  assert.notEqual(primeiro.conferencia.atualizadoEm, segundo.conferencia.atualizadoEm);
  assert.equal([...ctx.db.documentos.keys()].filter(k => k.includes("/revisoes/")).length, 1);
  assert.deepEqual(ctx.db.documentos.get("pedidos/app123"), pedido);
  ctx.db.documentos.set("pedidos/app123", { ...pedido, valor_venda: 99 });
  const terceiro = await servico("conferirPedido", { pedidoId: "app123" }, usuario);
  assert.equal(terceiro.mesmaRevisao, false);
  assert.equal([...ctx.db.documentos.keys()].filter(k => k.includes("/revisoes/")).length, 2);
  assert.equal(terceiro.conferencia.estado, "pendencias");
});
test("salvar vínculo detecta edição concorrente e mantém revisão auditável", async () => {
  const ctx = contexto(); const servico = criarServicoFiscal(ctx);
  const dados = { produtoId: "coxinha", ...vinculo, versaoEsperada: "errada" };
  await assert.rejects(() => servico("salvarVinculo", dados, usuario), { codigo: "VINCULO_ALTERADO" });
  const salvo = await servico("salvarVinculo", { ...dados, versaoEsperada: "v1" }, usuario);
  assert.equal(salvo.vinculo.revisado, true);
  assert.ok(ctx.db.documentos.has(`fiscal_produtos/coxinha/revisoes/${salvo.vinculo.revisao}`));
  await assert.rejects(() => servico("salvarVinculo", { ...dados, versaoEsperada: "v1" }, usuario), { status: 409 });
});
test("preparação fiscal cria uma operação única, imutável e sem envio externo", async () => {
  const ctx = contexto();
  const servico = criarServicoFiscal(ctx);
  const conferencia = await servico("conferirPedido", { pedidoId: "app123" }, usuario);
  const dados = {
    pedidoId: "app123",
    fonteHash: conferencia.conferencia.fonteHash,
    ambiente: "homologacao",
    autorizacao: { capacidade: "fiscal.preparar", modo: "permitida" },
  };
  const primeira = await servico("prepararOperacao", dados, usuario);
  const repetida = await servico("prepararOperacao", dados, usuario);
  const operacaoId = idOperacaoFiscal("app123", "homologacao");

  assert.equal(primeira.operacao.id, operacaoId);
  assert.equal(primeira.operacao.estado, "preparada");
  assert.equal(primeira.operacao.envioHabilitado, false);
  assert.equal(primeira.operacao.repetida, false);
  assert.equal(repetida.operacao.id, operacaoId);
  assert.equal(repetida.operacao.repetida, true);
  assert.deepEqual(primeira.operacao.bloqueios, [
    "CONTRATO_EF_NAO_CONFIRMADO",
    "HOMOLOGACAO_EF_NAO_VALIDADA",
    "RECUPERACAO_DE_RESPOSTA_NAO_VALIDADA",
  ]);
  assert.equal(
    [...ctx.db.documentos.keys()].filter(caminho => caminho.startsWith(`fiscal_operacoes/${operacaoId}/eventos/`)).length,
    1
  );
  const registro = ctx.db.documentos.get(`fiscal_operacoes/${operacaoId}`);
  assert.equal(registro.snapshotHash.length, 64);
  assert.equal(registro.snapshot.referenciaExterna, conferencia.conferencia.snapshot.referenciaExterna);
  assert.equal(registro.provedor.codigoEf, null);
});
test("preparação recusa pedido ou vínculo alterado depois da conferência", async () => {
  {
    const ctx = contexto(); const servico = criarServicoFiscal(ctx);
    const conferencia = await servico("conferirPedido", { pedidoId: "app123" }, usuario);
    ctx.db.documentos.set("pedidos/app123", { ...pedido, valor_venda: 11 });
    await assert.rejects(() => servico("prepararOperacao", {
      pedidoId: "app123", fonteHash: conferencia.conferencia.fonteHash, ambiente: "homologacao",
    }, usuario), { codigo: "PEDIDO_ALTERADO_APOS_CONFERENCIA", status: 409 });
  }
  {
    const ctx = contexto(); const servico = criarServicoFiscal(ctx);
    const conferencia = await servico("conferirPedido", { pedidoId: "app123" }, usuario);
    ctx.db.documentos.set("fiscal_produtos/coxinha", { ...vinculo, revisao: "v2" });
    await assert.rejects(() => servico("prepararOperacao", {
      pedidoId: "app123", fonteHash: conferencia.conferencia.fonteHash, ambiente: "homologacao",
    }, usuario), { codigo: "VINCULO_ALTERADO_APOS_CONFERENCIA", status: 409 });
  }
});
test("preparação recusa revisão antiga e ambiente de produção", async () => {
  const ctx = contexto(); const servico = criarServicoFiscal(ctx);
  const conferencia = await servico("conferirPedido", { pedidoId: "app123" }, usuario);
  await assert.rejects(() => servico("prepararOperacao", {
    pedidoId: "app123", fonteHash: "0".repeat(64), ambiente: "homologacao",
  }, usuario), { codigo: "CONFERENCIA_ALTERADA" });
  await assert.rejects(() => servico("prepararOperacao", {
    pedidoId: "app123", fonteHash: conferencia.conferencia.fonteHash, ambiente: "producao",
  }, usuario), { codigo: "AMBIENTE_FISCAL_NAO_LIBERADO", status: 423 });
  assert.equal([...ctx.db.documentos.keys()].some(caminho => caminho.startsWith("fiscal_operacoes/")), false);
});
test("resumo e histórico não retornam credenciais nem fazem consulta externa", async () => {
  const ctx = contexto(); const servico = criarServicoFiscal({ ...ctx, testarConexao: () => { throw new Error("não deve chamar"); } });
  await servico("conferirPedido", { pedidoId: "app123" }, usuario);
  const resumo = await servico("resumo", {}, usuario);
  assert.equal(resumo.emissaoHabilitada, false); assert.equal(resumo.conferencias.length, 1);
  assert.equal(resumo.produtos[0].nome, "Coxinha");
  const historico = await servico("consultarConferencia", { pedidoId: "app123" }, usuario);
  assert.equal(historico.conferencia.snapshot.pedidoId, "app123");
});
test("todas as ações de emissão são bloqueadas no servidor", async () => {
  const ctx = contexto(); const servico = criarServicoFiscal(ctx);
  for (const acao of ["emitir", "autorizar", "cancelar", "retransmitir"]) {
    await assert.rejects(() => servico(acao, { emissaoHabilitada: true }, usuario), { codigo: "EMISSAO_BLOQUEADA", status: 423 });
  }
  await assert.rejects(() => servico("inventada", {}, usuario), { codigo: "ACAO_INVALIDA" });
  assert.equal(ctx.db.documentos.size, 3);
});
test("teste de conexão é compartilhado por 30 segundos e sanitiza falhas inesperadas", async () => {
  const ctx = contexto(); let chamadas = 0;
  const servico = criarServicoFiscal({ ...ctx, testarConexao: async () => { chamadas++; throw new Error(tokenTeste); } });
  const a = await servico("testarConexao", {}, usuario);
  const b = await servico("testarConexao", {}, usuario);
  assert.equal(chamadas, 1); assert.deepEqual(a, b);
  assert.equal(a.conexao.estado, "falha"); assert.ok(!JSON.stringify(a).includes(tokenTeste));
  ctx.avancar(30001); await servico("testarConexao", {}, usuario); assert.equal(chamadas, 2);
});
test("teste antigo lento não sobrescreve resultado de um teste mais novo", async () => {
  const ctx = contexto(); let liberar;
  let avisarInicio;
  const iniciou = new Promise(resolve => { avisarInicio = resolve; });
  const servico = criarServicoFiscal({ ...ctx, testarConexao: () => { avisarInicio(); return new Promise(resolve => { liberar = resolve; }); } });
  const pendente = servico("testarConexao", {}, usuario);
  await iniciou;
  const novo = { estado: "ok", mensagem: "Resultado mais novo", verificadoEm: instante(999999999), proximaTentativaEm: instante(999999999) };
  ctx.db.documentos.set("fiscal_sistema/conexao", novo);
  liberar({ estado: "falha", mensagem: "Antigo" });
  const resposta = await pendente;
  assert.equal(resposta.conexao.mensagem, "Resultado mais novo");
  assert.equal(ctx.db.documentos.get("fiscal_sistema/conexao").mensagem, "Resultado mais novo");
});
