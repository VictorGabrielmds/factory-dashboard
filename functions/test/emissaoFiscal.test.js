const test = require("node:test");
const assert = require("node:assert/strict");
const { conferirPedido } = require("../src/fiscal/modelo");
const { idOperacaoFiscal } = require("../src/fiscal/operacoes");
const { ambienteDoXml } = require("../src/fiscal/contratoEficiencia");
const {
  ESTADOS,
  ErroProvedorFiscal,
  ambienteFiscalConfigurado,
  criarEmissorFiscal,
  podeTransicionar,
  proximoIntervaloConsulta,
} = require("../src/fiscal/emissao");

// Todos os cenários usam uma EF simulada em memória. Nenhum teste faz rede.

const instante = ms => ({ toMillis: () => ms, toDate: () => new Date(ms) });
const usuario = { uid: "operador" };
const pedido = { origem: "app", clienteUid: "cliente", order_id: "app123", status: 2,
  nome_destinatario: "Cliente de teste", tipo_entrega: "retirada", data_venda: "2026-09-03 09:00:00",
  produto_id_item: ["coxinha"], descricao_item: ["Coxinha"], quantidade_item: [10], valor_total_item: [8.5],
  valor_itens: 8.5, valor_desconto: 0, valor_taxa: 0, valor_taxa_cartao: 0, valor_venda: 8.5,
  forma_pagamento: ["17"], pix_confirmado: true, pix_status: "RECEIVED", pix_pagamento_id: "pay_teste" };
const vinculo = { codigoProduto: "1", nomeEf: "COXINHA FRANGO", revisado: true, revisadoPor: "operador",
  revisadoEm: instante(0), nomeProdutoNaRevisao: "Coxinha", revisao: "v1" };

function operacaoPreparada(pedidoId = "app123", mudancas = {}) {
  const { snapshot } = conferirPedido(pedidoId, { ...pedido, order_id: pedidoId },
    { coxinha: { nome: "Coxinha", categoria: "Salgados", disponivel: true, preco: 900 } }, { coxinha: vinculo });
  const id = idOperacaoFiscal(pedidoId, "homologacao");
  return { id, versao: 1, tipo: "emissao", pedidoId, cnpjEmitente: "11560207000137", ambiente: "homologacao",
    estado: "preparada", referenciaExterna: snapshot.referenciaExterna, snapshot, envioHabilitado: false,
    bloqueios: [], provedor: { nome: "eficiencia_fiscal", codigoEf: null, documento: null }, ...mudancas };
}

// Double de Firestore com controle otimista: se um documento lido mudou antes
// do commit, a transação é repetida, como no Firestore real.
function bancoMemoria(inicial = {}) {
  const documentos = new Map(Object.entries(inicial));
  const versoes = new Map();
  const snapshot = caminho => ({ id: caminho.split("/").at(-1), exists: documentos.has(caminho),
    data: () => documentos.get(caminho) });
  const doc = caminho => ({ path: caminho, get: async () => snapshot(caminho), collection: nome => colecao(`${caminho}/${nome}`) });
  const colecao = caminho => ({ doc: id => doc(`${caminho}/${id}`) });
  async function runTransaction(callback) {
    for (let tentativa = 0; tentativa < 5; tentativa++) {
      const lidas = new Map();
      const escritas = [];
      const ler = async ref => {
        assert.equal(escritas.length, 0, "transaction read after write");
        lidas.set(ref.path, versoes.get(ref.path) || 0);
        await new Promise(setImmediate);
        return snapshot(ref.path);
      };
      const resultado = await callback({ get: ler,
        set: (ref, dados) => escritas.push([ref.path, dados]),
        create: (ref, dados) => { assert.ok(!documentos.has(ref.path), `duplicate create ${ref.path}`); escritas.push([ref.path, dados]); } });
      if ([...lidas].some(([caminho, versao]) => (versoes.get(caminho) || 0) !== versao)) continue;
      for (const [caminho, dados] of escritas) {
        documentos.set(caminho, dados);
        versoes.set(caminho, (versoes.get(caminho) || 0) + 1);
      }
      return resultado;
    }
    throw new Error("transaction contention");
  }
  return { documentos, collection: colecao, runTransaction };
}

const xmlAutorizado = (tpAmb = "2") =>
  `<nfeProc versao="4.00"><NFe><infNFe><ide><tpAmb>${tpAmb}</tpAmb></ide></infNFe></NFe>` +
  `<protNFe><infProt><tpAmb>${tpAmb}</tpAmb></infProt></protNFe></nfeProc>`;
const danfe = Buffer.from("PDF sintetico de teste").toString("base64");

function efSimulada(roteiro = {}) {
  const chamadas = { criarPreVenda: [], autorizar: [], consultarXml: [] };
  const proximo = (nome, padrao) => {
    const fila = roteiro[nome] || [];
    const passo = fila.length ? fila.shift() : padrao;
    return typeof passo === "function" ? passo() : passo;
  };
  const responder = async (nome, comando, padrao) => {
    chamadas[nome].push(structuredClone(comando));
    const resposta = await proximo(nome, padrao);
    if (resposta instanceof Error) throw resposta;
    return resposta;
  };
  return {
    chamadas,
    criarPreVenda: comando => responder("criarPreVenda", comando, {
      cadastro_nacional: "11560207000137", codigo_parceiro: comando.corpo.codigo_parceiro, codigo_ef: 990000003 }),
    autorizar: comando => responder("autorizar", comando, { modelo: "65", xml: xmlAutorizado(), danfe }),
    consultarXml: comando => responder("consultarXml", comando, new ErroProvedorFiscal("nao_encontrada")),
  };
}

function cenario({ roteiro, operacoes = [operacaoPreparada()], extra = {} } = {}) {
  let agora = Date.UTC(2026, 9, 2, 12);
  const inicial = Object.fromEntries(operacoes.map(op => [`fiscal_operacoes/${op.id}`, op]));
  const db = bancoMemoria({ ...inicial, ...extra });
  const Timestamp = { now: () => instante(agora), fromMillis: instante };
  const provedor = efSimulada(roteiro);
  let seq = 0;
  const emissor = criarEmissorFiscal({ db, Timestamp, provedor, gerarId: () => `exec_${++seq}` });
  const operacao = id => db.documentos.get(`fiscal_operacoes/${id || operacoes[0].id}`);
  const eventos = id => [...db.documentos.keys()]
    .filter(k => k.startsWith(`fiscal_operacoes/${id || operacoes[0].id}/eventos/`)).sort()
    .map(k => db.documentos.get(k).para);
  return { db, provedor, emissor, operacao, eventos, id: operacoes[0].id, avancar: ms => { agora += ms; } };
}

test("caminho feliz: pré-venda e autorização em homologação, sem guardar XML ou DANFE", async () => {
  const c = cenario();
  const { operacao } = await c.emissor.emitir(c.id, usuario);
  assert.equal(operacao.estado, ESTADOS.AUTORIZADA);
  assert.equal(operacao.documento.documentosPresentes, true);
  assert.equal(operacao.documento.xmlHash.length, 64);
  assert.equal(c.provedor.chamadas.criarPreVenda.length, 1);
  assert.equal(c.provedor.chamadas.autorizar.length, 1);
  assert.equal(c.provedor.chamadas.autorizar[0].caminho.includes(c.operacao().referenciaExterna), true);
  assert.equal(c.operacao().provedor.codigoEf, "990000003");
  assert.deepEqual(c.eventos(), ["pre_venda_solicitada", "pre_venda_criada", "autorizacao_solicitada", "autorizada"]);
  const salvo = JSON.stringify([...c.db.documentos.values()]);
  assert.equal(salvo.includes("nfeProc"), false);
  assert.equal(salvo.includes(danfe), false);
});

test("clique duplo e dois operadores geram uma única pré-venda e uma única autorização", async () => {
  let liberar;
  const espera = new Promise(resolve => { liberar = resolve; });
  const c = cenario({ roteiro: { autorizar: [async () => { await espera; return { modelo: "65", xml: xmlAutorizado(), danfe }; }] } });
  const primeira = c.emissor.emitir(c.id, usuario);
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(c.emissor.emitir(c.id, { uid: "outro" }), { codigo: "EMISSAO_EM_ANDAMENTO" });
  liberar();
  assert.equal((await primeira).operacao.estado, ESTADOS.AUTORIZADA);
  assert.equal(c.provedor.chamadas.criarPreVenda.length, 1);
  assert.equal(c.provedor.chamadas.autorizar.length, 1);
});

test("chamadas simultâneas desde o início não duplicam a operação", async () => {
  const c = cenario();
  const resultados = await Promise.allSettled([c.emissor.emitir(c.id, usuario), c.emissor.emitir(c.id, usuario)]);
  assert.equal(resultados.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(["EMISSAO_EM_ANDAMENTO", "TRANSICAO_FISCAL_INVALIDA"].includes(resultados.find(r => r.status === "rejected").reason.codigo));
  assert.equal(c.provedor.chamadas.criarPreVenda.length, 1);
  assert.equal(c.provedor.chamadas.autorizar.length, 1);
});

test("timeout na autorização fica inconclusivo e nunca autoriza de novo às cegas", async () => {
  const c = cenario({ roteiro: { autorizar: [new ErroProvedorFiscal("timeout")] } });
  const { operacao } = await c.emissor.emitir(c.id, usuario);
  assert.equal(operacao.estado, ESTADOS.INCONCLUSIVA);
  assert.equal(operacao.etapa, "autorizacao");
  const repetida = await c.emissor.emitir(c.id, usuario);
  assert.equal(repetida.operacao.estado, ESTADOS.INCONCLUSIVA);
  assert.equal(c.provedor.chamadas.autorizar.length, 1);
  assert.equal(podeTransicionar(c.operacao(), ESTADOS.AUTORIZACAO_SOLICITADA), false);
  assert.equal(podeTransicionar(c.operacao(), ESTADOS.PRE_VENDA_SOLICITADA), false);
});

test("resposta ilegível da autorização também fica inconclusiva", async () => {
  const c = cenario({ roteiro: { autorizar: [{ modelo: "65", xml: "corrompido", danfe }] } });
  assert.equal((await c.emissor.emitir(c.id, usuario)).operacao.estado, ESTADOS.INCONCLUSIVA);
});

test("reconciliação respeita intervalo, mantém pendência sem XML e recupera a mesma nota", async () => {
  const c = cenario({ roteiro: {
    autorizar: [new ErroProvedorFiscal("timeout")],
    consultarXml: [new ErroProvedorFiscal("nao_encontrada"), { xml: xmlAutorizado() }],
  } });
  await c.emissor.emitir(c.id, usuario);
  await assert.rejects(c.emissor.reconciliar(c.id, usuario), { codigo: "CONSULTA_FISCAL_ANTECIPADA" });
  assert.equal(c.provedor.chamadas.consultarXml.length, 0);

  c.avancar(30 * 1000);
  const ausente = await c.emissor.reconciliar(c.id, usuario);
  assert.equal(ausente.operacao.estado, ESTADOS.INCONCLUSIVA);
  assert.equal(ausente.operacao.motivo, "DOCUMENTO_NAO_LOCALIZADO");
  assert.equal(ausente.operacao.consultas, 1);
  await assert.rejects(c.emissor.reconciliar(c.id, usuario), { codigo: "CONSULTA_FISCAL_ANTECIPADA" });

  c.avancar(proximoIntervaloConsulta(1));
  const recuperada = await c.emissor.reconciliar(c.id, usuario);
  assert.equal(recuperada.operacao.estado, ESTADOS.AUTORIZADA);
  assert.equal(recuperada.operacao.documento.recuperadoPorConsulta, true);
  assert.match(c.provedor.chamadas.consultarXml[0].caminho, /\/FDAPP_[a-f0-9]{32}\/xml\?cadastro_nacional=11560207000137$/);
  assert.equal(c.provedor.chamadas.autorizar.length, 1);
});

test("intervalo de consulta cresce e tem teto", () => {
  assert.equal(proximoIntervaloConsulta(1), 30 * 1000);
  assert.equal(proximoIntervaloConsulta(2), 60 * 1000);
  assert.equal(proximoIntervaloConsulta(20), 30 * 60 * 1000);
});

test("nota em produção trava todas as emissões; tpAmb ausente também", async () => {
  for (const xml of [xmlAutorizado("1"), "<nfeProc versao=\"4.00\"><NFe /></nfeProc>"]) {
    const outra = operacaoPreparada("app456");
    const c = cenario({ roteiro: { autorizar: [{ modelo: "65", xml, danfe }] }, operacoes: [operacaoPreparada(), outra] });
    const { operacao } = await c.emissor.emitir(c.id, usuario);
    assert.equal(operacao.estado, ESTADOS.AMBIENTE_DIVERGENTE);
    assert.match(operacao.motivo, /^TP_AMB_(1|AUSENTE)$/);
    assert.equal(c.db.documentos.get("fiscal_sistema/emissao").bloqueada, true);
    await assert.rejects(c.emissor.emitir(outra.id, usuario), { codigo: "EMISSAO_TRAVADA" });
    assert.equal(c.provedor.chamadas.criarPreVenda.length, 1);
  }
});

test("consulta que encontra nota em produção também trava", async () => {
  const c = cenario({ roteiro: { autorizar: [new ErroProvedorFiscal("timeout")], consultarXml: [{ xml: xmlAutorizado("1") }] } });
  await c.emissor.emitir(c.id, usuario);
  c.avancar(30 * 1000);
  assert.equal((await c.emissor.reconciliar(c.id, usuario)).operacao.estado, ESTADOS.AMBIENTE_DIVERGENTE);
  assert.equal(c.db.documentos.get("fiscal_sistema/emissao").bloqueada, true);
});

test("pré-venda sem resposta pode ser reenviada com a mesma referência", async () => {
  const c = cenario({ roteiro: { criarPreVenda: [new ErroProvedorFiscal("timeout")] } });
  const primeira = await c.emissor.emitir(c.id, usuario);
  assert.equal(primeira.operacao.estado, ESTADOS.INCONCLUSIVA);
  assert.equal(primeira.operacao.etapa, "pre_venda");
  assert.equal(c.provedor.chamadas.autorizar.length, 0);
  const segunda = await c.emissor.emitir(c.id, usuario);
  assert.equal(segunda.operacao.estado, ESTADOS.AUTORIZADA);
  const [a, b] = c.provedor.chamadas.criarPreVenda;
  assert.equal(a.corpo.codigo_parceiro, b.corpo.codigo_parceiro);
  assert.deepEqual(a, b);
});

test("rejeição explícita é final e não reenvia", async () => {
  const c = cenario({ roteiro: { autorizar: [new ErroProvedorFiscal("rejeicao", "Rejeicao 999 sintetica")] } });
  const { operacao } = await c.emissor.emitir(c.id, usuario);
  assert.equal(operacao.estado, ESTADOS.REJEITADA);
  assert.equal(operacao.motivo, "Rejeicao 999 sintetica");
  await c.emissor.emitir(c.id, usuario);
  assert.equal(c.provedor.chamadas.autorizar.length, 1);
  await assert.rejects(c.emissor.reconciliar(c.id, usuario), { codigo: "RECONCILIACAO_NAO_APLICAVEL" });
});

test("execução interrompida depois de pedir autorização vira inconclusiva sem nova chamada", async () => {
  const travada = operacaoPreparada("app123", {
    estado: ESTADOS.AUTORIZACAO_SOLICITADA, sequencia: 3,
    provedor: { nome: "eficiencia_fiscal", codigoEf: "990000003", documento: null },
    execucao: { id: "exec_antiga", expiraEm: instante(Date.UTC(2026, 9, 2, 12) + 60 * 1000) },
  });
  const c = cenario({ operacoes: [travada] });
  await assert.rejects(c.emissor.emitir(c.id, usuario), { codigo: "EMISSAO_EM_ANDAMENTO" });
  c.avancar(61 * 1000);
  const { operacao } = await c.emissor.emitir(c.id, usuario);
  assert.equal(operacao.estado, ESTADOS.INCONCLUSIVA);
  assert.equal(operacao.etapa, "autorizacao");
  assert.equal(operacao.motivo, "EXECUCAO_EXPIRADA");
  assert.equal(c.provedor.chamadas.autorizar.length, 0);
});

test("ambiente configurável só aceita homologação nesta fase", async () => {
  assert.equal(ambienteFiscalConfigurado({}), "homologacao");
  assert.equal(ambienteFiscalConfigurado({ FISCAL_AMBIENTE: " homologacao " }), "homologacao");
  assert.throws(() => ambienteFiscalConfigurado({ FISCAL_AMBIENTE: "producao" }), { codigo: "AMBIENTE_FISCAL_NAO_LIBERADO" });
  assert.throws(() => ambienteFiscalConfigurado({ FISCAL_AMBIENTE: "teste" }), { codigo: "AMBIENTE_FISCAL_INVALIDO" });
  const c = cenario();
  assert.throws(() => criarEmissorFiscal({ db: c.db, Timestamp: {}, provedor: c.provedor, ambiente: "producao" }),
    { codigo: "AMBIENTE_FISCAL_NAO_LIBERADO" });
  const emProducao = cenario({ operacoes: [operacaoPreparada("app123", { ambiente: "producao" })] });
  await assert.rejects(emProducao.emissor.emitir(emProducao.id, usuario), { codigo: "AMBIENTE_FISCAL_DIVERGENTE" });
  assert.equal(emProducao.provedor.chamadas.criarPreVenda.length, 0);
});

test("tpAmb do XML: exige um valor único e conhecido", () => {
  assert.equal(ambienteDoXml(xmlAutorizado("2")), "homologacao");
  assert.equal(ambienteDoXml(xmlAutorizado("1")), "producao");
  assert.equal(ambienteDoXml("<nfeProc><tpAmb>2</tpAmb><tpAmb>1</tpAmb></nfeProc>"), null);
  assert.equal(ambienteDoXml("<nfeProc><tpAmb>3</tpAmb></nfeProc>"), null);
  assert.equal(ambienteDoXml("<nfeProc />"), null);
});

test("operação inexistente é recusada sem chamar a EF", async () => {
  const c = cenario();
  await assert.rejects(c.emissor.emitir("op_inexistente", usuario), { codigo: "OPERACAO_FISCAL_NAO_ENCONTRADA" });
  assert.equal(c.provedor.chamadas.criarPreVenda.length, 0);
});
