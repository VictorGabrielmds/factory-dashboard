const { CNPJ_EMITENTE, EMISSAO_HABILITADA, ETAPAS_PENDENTES, ErroFiscal,
  idValido, hash, normalizarVinculo, conferirPedido } = require("./modelo");
const { prepararOperacaoFiscal } = require("./operacoes");

const iso = value => value?.toDate?.().toISOString() || null;
function vinculoPublico(dados) {
  if (!dados) return null;
  return { codigoProduto: dados.codigoProduto, nomeEf: dados.nomeEf, revisado: dados.revisado === true,
    nomeProdutoNaRevisao: dados.nomeProdutoNaRevisao, observacao: dados.observacao || "",
    revisao: dados.revisao, revisadoEm: iso(dados.revisadoEm) };
}
function conexaoPublica(dados) {
  return dados ? { estado: dados.estado, mensagem: dados.mensagem, codigo: dados.codigo || null,
    verificadoEm: iso(dados.verificadoEm), proximaTentativaEm: iso(dados.proximaTentativaEm) } : null;
}
function conferenciaPublica(dados) {
  return { ...dados, criadoEm: iso(dados.criadoEm), atualizadoEm: iso(dados.atualizadoEm) };
}

function criarServicoFiscal({ db, Timestamp, testarConexao }) {
  async function resumo() {
    const [produtos, vinculos, conferencias, conexao] = await Promise.all([
      db.collection("produtos").limit(501).get(),
      db.collection("fiscal_produtos").limit(501).get(),
      db.collection("fiscal_conferencias").orderBy("atualizadoEm", "desc").limit(20).get(),
      db.collection("fiscal_sistema").doc("conexao").get(),
    ]);
    const mapa = new Map(vinculos.docs.map(doc => [doc.id, doc.data()]));
    return {
      emissaoHabilitada: EMISSAO_HABILITADA, cnpj: CNPJ_EMITENTE, etapasPendentes: ETAPAS_PENDENTES,
      produtos: produtos.docs.slice(0, 500).map(doc => {
        const dados = doc.data();
        return { id: doc.id, nome: String(dados.nome || "Sem nome"), categoria: String(dados.categoria || ""),
          especial: !!(dados.itemSistema || dados.tipoSistema || dados.friturasNoLocal),
          disponivel: dados.disponivel === true, vinculo: vinculoPublico(mapa.get(doc.id)) };
      }).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
      catalogoLimitado: produtos.size > 500 || vinculos.size > 500,
      conferencias: conferencias.docs.map(doc => {
        const dados = doc.data();
        return { pedidoId: doc.id, cliente: dados.snapshot.cliente, estado: dados.estado,
          pendencias: dados.pendencias.length, atualizadoEm: iso(dados.atualizadoEm) };
      }),
      conexao: conexaoPublica(conexao.data()),
    };
  }

  async function salvarVinculo(dados, usuario) {
    if (!idValido(dados.produtoId)) throw new ErroFiscal("PRODUTO_INVALIDO", "Produto inválido.");
    const ref = db.collection("fiscal_produtos").doc(dados.produtoId);
    return db.runTransaction(async tx => {
      const [produto, anterior] = await Promise.all([
        tx.get(db.collection("produtos").doc(dados.produtoId)), tx.get(ref),
      ]);
      if (!produto.exists) throw new ErroFiscal("PRODUTO_NAO_ENCONTRADO", "Produto não encontrado.", 404);
      const versaoEsperada = dados.versaoEsperada ?? null;
      if ((anterior.data()?.revisao ?? null) !== versaoEsperada) {
        throw new ErroFiscal("VINCULO_ALTERADO", "Este vínculo foi alterado por outra pessoa. Atualize a tela antes de salvar.", 409);
      }
      const normalizado = normalizarVinculo(dados, produto.data());
      const agora = Timestamp.now();
      const revisao = hash([normalizado, usuario.uid, agora.toMillis(), versaoEsperada]);
      const registro = { ...normalizado, revisao, atualizadoEm: agora, atualizadoPor: usuario.uid,
        revisadoEm: normalizado.revisado ? agora : null, revisadoPor: normalizado.revisado ? usuario.uid : null };
      tx.set(ref, registro);
      tx.create(ref.collection("revisoes").doc(revisao), registro);
      return { vinculo: vinculoPublico(registro) };
    });
  }

  async function conferir(dados, usuario) {
    const pedidoId = String(dados.pedidoId || "").trim();
    if (!idValido(pedidoId)) throw new ErroFiscal("PEDIDO_ID_INVALIDO", "Informe um ID de pedido válido.");
    const ref = db.collection("fiscal_conferencias").doc(pedidoId);
    return db.runTransaction(async tx => {
      const pedidoSnap = await tx.get(db.collection("pedidos").doc(pedidoId));
      const pedido = pedidoSnap.data();
      if (!pedido) throw new ErroFiscal("PEDIDO_NAO_ENCONTRADO", "Pedido não encontrado.", 404);
      const ids = [...new Set((Array.isArray(pedido.produto_id_item) ? pedido.produto_id_item : []).slice(0, 200).filter(idValido))];
      const [produtoSnaps, vinculoSnaps, anterior] = await Promise.all([
        ids.length ? tx.getAll(...ids.map(id => db.collection("produtos").doc(id))) : [],
        ids.length ? tx.getAll(...ids.map(id => db.collection("fiscal_produtos").doc(id))) : [],
        tx.get(ref),
      ]);
      const produtos = Object.fromEntries(produtoSnaps.map(doc => [doc.id, doc.data()]));
      const vinculos = Object.fromEntries(vinculoSnaps.map(doc => [doc.id, doc.data()]));
      const conferencia = conferirPedido(pedidoId, pedido, produtos, vinculos);
      const revisaoRef = ref.collection("revisoes").doc(conferencia.fonteHash);
      const revisao = await tx.get(revisaoRef);
      const agora = Timestamp.now();
      const registro = { ...conferencia, criadoEm: anterior.data()?.criadoEm || agora,
        atualizadoEm: agora, conferidoPor: usuario.uid };
      if (!revisao.exists) tx.create(revisaoRef, { ...conferencia, criadoEm: agora, criadoPor: usuario.uid });
      tx.set(ref, registro);
      return { conferencia: conferenciaPublica(registro), mesmaRevisao: revisao.exists };
    });
  }

  async function consultarConferencia(dados) {
    if (!idValido(dados.pedidoId)) throw new ErroFiscal("PEDIDO_ID_INVALIDO", "Informe um ID de pedido válido.");
    const snap = await db.collection("fiscal_conferencias").doc(dados.pedidoId).get();
    if (!snap.exists) throw new ErroFiscal("CONFERENCIA_NAO_ENCONTRADA", "Conferência não encontrada.", 404);
    return { conferencia: conferenciaPublica(snap.data()) };
  }

  async function verificarConexao() {
    const ref = db.collection("fiscal_sistema").doc("conexao");
    const agora = Timestamp.now();
    const reserva = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const atual = snap.data();
      if (atual?.proximaTentativaEm?.toMillis() > agora.toMillis()) return { executar: false, dados: atual };
      const dados = { estado: "testando", mensagem: "Consulta em andamento. Aguarde alguns segundos.",
        verificadoEm: agora, proximaTentativaEm: Timestamp.fromMillis(agora.toMillis() + 30000) };
      tx.set(ref, dados);
      return { executar: true, dados };
    });
    if (!reserva.executar) return { conexao: conexaoPublica(reserva.dados) };
    let resultado;
    try { resultado = await testarConexao(); }
    catch (erro) {
      resultado = { estado: "falha", codigo: erro instanceof ErroFiscal ? erro.codigo : "CONSULTA_INDISPONIVEL",
        mensagem: erro instanceof ErroFiscal ? erro.message : "Não foi possível testar a conexão agora." };
    }
    const final = { ...reserva.dados, ...resultado, verificadoEm: Timestamp.now() };
    // An old, slow request must not replace the result of a newer test.
    return db.runTransaction(async tx => {
      const atual = (await tx.get(ref)).data();
      if (atual?.proximaTentativaEm?.toMillis() !== reserva.dados.proximaTentativaEm.toMillis()) {
        return { conexao: conexaoPublica(atual) };
      }
      tx.set(ref, final);
      return { conexao: conexaoPublica(final) };
    });
  }

  return async function executar(acao, dados, usuario) {
    switch (acao) {
      case "resumo": return resumo();
      case "salvarVinculo": return salvarVinculo(dados, usuario);
      case "conferirPedido": return conferir(dados, usuario);
      case "consultarConferencia": return consultarConferencia(dados);
      case "testarConexao": return verificarConexao();
      case "prepararOperacao": return prepararOperacaoFiscal({
        db,
        Timestamp,
        pedidoId: String(dados.pedidoId || "").trim(),
        fonteHash: dados.fonteHash,
        ambiente: dados.ambiente,
        usuario,
        autorizacao: dados.autorizacao || null,
      });
      case "emitir": case "autorizar": case "cancelar": case "retransmitir":
        throw new ErroFiscal("EMISSAO_BLOQUEADA", "A emissão fiscal ainda não foi liberada. Nenhuma nota foi enviada.", 423);
      default: throw new ErroFiscal("ACAO_INVALIDA", "Ação fiscal inválida.");
    }
  };
}

module.exports = { criarServicoFiscal };
