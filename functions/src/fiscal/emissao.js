// ============================================================================
// EMISSÃO FISCAL — máquina de estados, reivindicação e reconciliação
//
// Coordena pré-venda, autorização e consulta com um provedor injetado. Este
// módulo ainda NÃO está ligado ao endpoint ativo: as ações de emissão seguem
// bloqueadas em servico.js até a homologação com a EF ser validada.
//
// Regras que não podem ser relaxadas:
// - A intenção é persistida antes de cada chamada externa; a chamada ocorre
//   fora da transação.
// - Timeout, queda ou resposta ilegível na autorização viram "inconclusiva".
//   Nunca se autoriza de novo às cegas: só a consulta pela referência resolve.
// - Reenviar a pré-venda com o mesmo codigo_parceiro apenas a atualiza
//   (contrato público da EF), então essa etapa pode ser repetida.
// - O ambiente é trocado no painel da EF, por CNPJ, com a mesma URL. O tpAmb
//   do XML é a prova do ambiente; divergência trava todas as emissões.
// ============================================================================

const crypto = require("node:crypto");
const { CNPJ_EMITENTE, ErroFiscal, hash } = require("./modelo");
const contrato = require("./contratoEficiencia");
const { operacaoPublica } = require("./operacoes");

const ESTADOS = Object.freeze({
  PREPARADA: "preparada",
  PRE_VENDA_SOLICITADA: "pre_venda_solicitada",
  PRE_VENDA_CRIADA: "pre_venda_criada",
  AUTORIZACAO_SOLICITADA: "autorizacao_solicitada",
  AUTORIZADA: "autorizada",
  REJEITADA: "rejeitada",
  INCONCLUSIVA: "inconclusiva",
  AMBIENTE_DIVERGENTE: "ambiente_divergente",
});

// Rejeitada e ambiente divergente são finais nesta versão: exigem conferência
// humana. Uma nova tentativa depois de rejeição ainda precisa de desenho próprio.
const TRANSICOES = Object.freeze({
  preparada: ["pre_venda_solicitada"],
  pre_venda_solicitada: ["pre_venda_criada", "rejeitada", "inconclusiva"],
  pre_venda_criada: ["autorizacao_solicitada"],
  autorizacao_solicitada: ["autorizada", "rejeitada", "inconclusiva", "ambiente_divergente"],
  inconclusiva: ["pre_venda_solicitada", "pre_venda_criada", "autorizada", "inconclusiva", "ambiente_divergente"],
  autorizada: [],
  rejeitada: [],
  ambiente_divergente: [],
});

const EM_ANDAMENTO = new Set([ESTADOS.PRE_VENDA_SOLICITADA, ESTADOS.AUTORIZACAO_SOLICITADA]);
const AMBIENTE_LIBERADO = "homologacao";
const CONSULTA_INICIAL_MS = 30 * 1000;
const CONSULTA_MAXIMA_MS = 30 * 60 * 1000;

// Erro que um cliente do provedor lança. Somente tipo "rejeicao" significa uma
// recusa explícita da EF; qualquer outro tipo deixa o resultado desconhecido.
class ErroProvedorFiscal extends Error {
  constructor(tipo, motivo = "") {
    super(`provedor_fiscal_${tipo}`);
    this.tipo = tipo;
    this.motivo = String(motivo || "").slice(0, 300);
  }
}

function podeTransicionar(operacao, para) {
  if (!(TRANSICOES[operacao.estado] || []).includes(para)) return false;
  if (operacao.estado !== ESTADOS.INCONCLUSIVA) return true;
  // Pré-venda inconclusiva pode ser reenviada (ou receber a resposta atrasada).
  // Autorização inconclusiva só sai do lugar por consulta, nunca por reenvio.
  const daPreVenda = para === ESTADOS.PRE_VENDA_SOLICITADA || para === ESTADOS.PRE_VENDA_CRIADA;
  return operacao.etapa === "pre_venda" ? daPreVenda : !daPreVenda;
}

function exigirAmbienteLiberado(ambiente) {
  if (ambiente === "producao") {
    throw new ErroFiscal("AMBIENTE_FISCAL_NAO_LIBERADO", "A emissão está limitada ao ambiente de homologação.", 423);
  }
  if (ambiente !== AMBIENTE_LIBERADO) {
    throw new ErroFiscal("AMBIENTE_FISCAL_INVALIDO", "O ambiente fiscal configurado no servidor é inválido.", 500);
  }
  return ambiente;
}

function ambienteFiscalConfigurado(env = process.env) {
  return exigirAmbienteLiberado(String(env.FISCAL_AMBIENTE || AMBIENTE_LIBERADO).trim());
}

function proximoIntervaloConsulta(consultas) {
  return Math.min(CONSULTA_INICIAL_MS * 2 ** Math.max(0, consultas - 1), CONSULTA_MAXIMA_MS);
}

function documentoDoXml(xml) {
  if (typeof xml !== "string" || xml.length < 20 || xml.length > 5 * 1024 * 1024 || !/<nfeProc(?:\s|>)/.test(xml)) {
    throw new ErroProvedorFiscal("resposta_invalida");
  }
  return { xmlHash: hash(xml), xmlBytes: Buffer.byteLength(xml, "utf8") };
}

function operacaoEmissaoPublica(operacao) {
  return {
    ...operacaoPublica(operacao),
    etapa: operacao.etapa || null,
    motivo: operacao.motivo || null,
    documento: operacao.provedor?.documento || null,
    consultas: operacao.consultas || 0,
  };
}

function criarEmissorFiscal({
  db,
  Timestamp,
  provedor,
  ambiente = AMBIENTE_LIBERADO,
  prazoExecucaoMs = 2 * 60 * 1000,
  gerarId = () => crypto.randomUUID(),
}) {
  exigirAmbienteLiberado(ambiente);
  const travaRef = db.collection("fiscal_sistema").doc("emissao");
  const operacaoRef = (id) => db.collection("fiscal_operacoes").doc(id);

  function validarOperacao(operacao) {
    if (!operacao) throw new ErroFiscal("OPERACAO_FISCAL_NAO_ENCONTRADA", "Prepare a operação antes de emitir.", 404);
    if (operacao.cnpjEmitente !== CNPJ_EMITENTE || operacao.ambiente !== ambiente) {
      throw new ErroFiscal("AMBIENTE_FISCAL_DIVERGENTE", "A operação não pertence ao ambiente fiscal configurado.", 409);
    }
  }

  function registrar(tx, ref, anterior, mudancas, usuario, agora) {
    const sequencia = (anterior.sequencia || 0) + 1;
    const proxima = { ...anterior, ...mudancas, sequencia, atualizadoEm: agora };
    tx.set(ref, proxima);
    tx.create(ref.collection("eventos").doc(`t${String(sequencia).padStart(4, "0")}_${proxima.estado}`), {
      tipo: "transicao",
      de: anterior.estado,
      para: proxima.estado,
      etapa: proxima.etapa || null,
      execucaoId: proxima.execucao?.id || null,
      criadoEm: agora,
      criadoPor: usuario.uid,
    });
    return proxima;
  }

  // Grava a intenção e o identificador desta execução antes da chamada externa.
  // Uma execução que expirou sem concluir pode ter enviado a requisição, então
  // vira inconclusiva em vez de ser repetida.
  async function reivindicar(operacaoId, usuario, para, construirComando) {
    const ref = operacaoRef(operacaoId);
    return db.runTransaction(async (tx) => {
      const [snap, travaSnap] = await Promise.all([tx.get(ref), tx.get(travaRef)]);
      const operacao = snap.data();
      validarOperacao(operacao);
      if (travaSnap.data()?.bloqueada === true) {
        throw new ErroFiscal("EMISSAO_TRAVADA", "A emissão está travada até a conferência do ambiente fiscal.", 423);
      }
      const agora = Timestamp.now();
      if (EM_ANDAMENTO.has(operacao.estado)) {
        if (operacao.execucao?.expiraEm?.toMillis() > agora.toMillis()) {
          throw new ErroFiscal("EMISSAO_EM_ANDAMENTO", "Esta emissão já está em andamento.", 409);
        }
        const etapa = operacao.estado === ESTADOS.PRE_VENDA_SOLICITADA ? "pre_venda" : "autorizacao";
        const proxima = registrar(tx, ref, operacao, { estado: ESTADOS.INCONCLUSIVA, etapa,
          motivo: "EXECUCAO_EXPIRADA", proximaConsultaEm: agora }, usuario, agora);
        return { operacao: proxima, comando: null };
      }
      if (!podeTransicionar(operacao, para)) {
        throw new ErroFiscal("TRANSICAO_FISCAL_INVALIDA", "A operação fiscal não está no estado esperado.", 409);
      }
      const comando = construirComando(operacao);
      const execucao = { id: gerarId(), expiraEm: Timestamp.fromMillis(agora.toMillis() + prazoExecucaoMs) };
      const proxima = registrar(tx, ref, operacao, { estado: para, execucao, motivo: null }, usuario, agora);
      return { operacao: proxima, comando };
    });
  }

  // Aplica o resultado somente se esta execução ainda é a dona da operação.
  async function concluir(operacaoId, execucaoId, usuario, decidir) {
    const ref = operacaoRef(operacaoId);
    return db.runTransaction(async (tx) => {
      const operacao = (await tx.get(ref)).data();
      if (!operacao || operacao.execucao?.id !== execucaoId) {
        throw new ErroFiscal("EXECUCAO_FISCAL_SUBSTITUIDA", "Outra execução assumiu esta operação fiscal.", 409);
      }
      const agora = Timestamp.now();
      const mudancas = decidir(operacao, agora);
      if (!podeTransicionar(operacao, mudancas.estado)) {
        throw new ErroFiscal("TRANSICAO_FISCAL_INVALIDA", "A operação fiscal mudou durante a execução.", 409);
      }
      if (mudancas.estado === ESTADOS.AMBIENTE_DIVERGENTE) travar(tx, operacaoId, agora, usuario);
      return registrar(tx, ref, operacao, { ...mudancas, execucao: { ...operacao.execucao, expiraEm: agora } },
        usuario, agora);
    });
  }

  function travar(tx, operacaoId, agora, usuario) {
    tx.set(travaRef, { bloqueada: true, motivo: "AMBIENTE_DIVERGENTE", operacaoId, criadoEm: agora, criadoPor: usuario.uid });
  }

  function resultadoAutorizacao(xml, documento, agora) {
    const recebido = contrato.ambienteDoXml(xml);
    if (recebido !== ambiente) {
      return { estado: ESTADOS.AMBIENTE_DIVERGENTE, etapa: "autorizacao",
        motivo: recebido ? `TP_AMB_${contrato.TP_AMB[recebido]}` : "TP_AMB_AUSENTE",
        provedorDocumento: documento };
    }
    return { estado: ESTADOS.AUTORIZADA, etapa: null, motivo: null, provedorDocumento: { ...documento, autorizadaEm: agora } };
  }

  function comDocumento(operacao, mudancas) {
    const { provedorDocumento, ...resto } = mudancas;
    if (!provedorDocumento) return resto;
    return { ...resto, provedor: { ...operacao.provedor, documento: provedorDocumento } };
  }

  function falha(erro, etapa, agora) {
    if (erro instanceof ErroProvedorFiscal && erro.tipo === "rejeicao") {
      return { estado: ESTADOS.REJEITADA, etapa, motivo: erro.motivo || "REJEITADA_PELA_EF" };
    }
    return { estado: ESTADOS.INCONCLUSIVA, etapa, motivo: "RESULTADO_DESCONHECIDO", consultas: 0,
      proximaConsultaEm: Timestamp.fromMillis(agora.toMillis() + CONSULTA_INICIAL_MS) };
  }

  async function etapaPreVenda(operacaoId, usuario) {
    const { operacao, comando } = await reivindicar(operacaoId, usuario, ESTADOS.PRE_VENDA_SOLICITADA,
      // O contrato só monta a pré-venda a partir do snapshot preparado; uma
      // pré-venda inconclusiva é reenviada com o mesmo snapshot e referência.
      (atual) => contrato.construirComandoPreVenda({ ...atual, estado: ESTADOS.PREPARADA }));
    if (!comando) return operacao;
    let resultado;
    try {
      resultado = { dados: contrato.interpretarRespostaPreVenda(await provedor.criarPreVenda(comando), operacao) };
    } catch (erro) {
      resultado = { erro };
    }
    return concluir(operacaoId, operacao.execucao.id, usuario, (atual, agora) => resultado.dados
      ? { estado: ESTADOS.PRE_VENDA_CRIADA, etapa: null, motivo: null,
        provedor: { ...atual.provedor, codigoEf: resultado.dados.codigoEf, preVendaHash: resultado.dados.respostaHash } }
      : falha(resultado.erro, "pre_venda", agora));
  }

  async function etapaAutorizacao(operacaoId, usuario) {
    const { operacao, comando } = await reivindicar(operacaoId, usuario, ESTADOS.AUTORIZACAO_SOLICITADA,
      contrato.construirComandoAutorizacao);
    if (!comando) return operacao;
    let resultado;
    try {
      const resposta = await provedor.autorizar(comando);
      resultado = { documento: contrato.interpretarRespostaAutorizacao(resposta), xml: resposta.xml };
    } catch (erro) {
      resultado = { erro };
    }
    return concluir(operacaoId, operacao.execucao.id, usuario, (atual, agora) => resultado.documento
      ? comDocumento(atual, resultadoAutorizacao(resultado.xml, resultado.documento, agora))
      : falha(resultado.erro, "autorizacao", agora));
  }

  async function emitir(operacaoId, usuario) {
    let operacao = (await operacaoRef(operacaoId).get()).data();
    validarOperacao(operacao);
    if (operacao.estado === ESTADOS.PREPARADA ||
        (operacao.estado === ESTADOS.INCONCLUSIVA && operacao.etapa === "pre_venda")) {
      operacao = await etapaPreVenda(operacaoId, usuario);
    }
    if (operacao.estado === ESTADOS.PRE_VENDA_CRIADA) {
      operacao = await etapaAutorizacao(operacaoId, usuario);
    } else if (EM_ANDAMENTO.has(operacao.estado)) {
      operacao = (await reivindicar(operacaoId, usuario, null, () => null)).operacao;
    }
    return { operacao: operacaoEmissaoPublica(operacao) };
  }

  // Consulta o XML pela referência própria. Encontrar o XML resolve; não
  // encontrar mantém a pendência, porque ausência não prova inexistência.
  async function reconciliar(operacaoId, usuario) {
    const ref = operacaoRef(operacaoId);
    const operacao = (await ref.get()).data();
    validarOperacao(operacao);
    if (operacao.estado !== ESTADOS.INCONCLUSIVA || operacao.etapa !== "autorizacao") {
      throw new ErroFiscal("RECONCILIACAO_NAO_APLICAVEL", "Esta operação não tem autorização pendente de consulta.", 409);
    }
    if (operacao.proximaConsultaEm?.toMillis() > Timestamp.now().toMillis()) {
      throw new ErroFiscal("CONSULTA_FISCAL_ANTECIPADA", "Aguarde o próximo horário de consulta desta operação.", 429);
    }
    let resultado;
    try {
      const resposta = await provedor.consultarXml(contrato.construirComandoConsultaXml(operacao));
      resultado = { documento: { ...documentoDoXml(resposta?.xml), recuperadoPorConsulta: true }, xml: resposta.xml };
    } catch (erro) {
      resultado = { erro };
    }
    const proxima = await db.runTransaction(async (tx) => {
      const atual = (await tx.get(ref)).data();
      if (!atual || atual.estado !== ESTADOS.INCONCLUSIVA || atual.etapa !== "autorizacao" ||
          atual.sequencia !== operacao.sequencia) {
        throw new ErroFiscal("OPERACAO_FISCAL_ALTERADA", "A operação mudou durante a consulta.", 409);
      }
      const agora = Timestamp.now();
      if (resultado.documento) {
        const mudancas = comDocumento(atual, resultadoAutorizacao(resultado.xml, resultado.documento, agora));
        if (mudancas.estado === ESTADOS.AMBIENTE_DIVERGENTE) travar(tx, operacaoId, agora, usuario);
        return registrar(tx, ref, atual, mudancas, usuario, agora);
      }
      const consultas = (atual.consultas || 0) + 1;
      return registrar(tx, ref, atual, {
        estado: ESTADOS.INCONCLUSIVA,
        motivo: resultado.erro instanceof ErroProvedorFiscal && resultado.erro.tipo === "nao_encontrada"
          ? "DOCUMENTO_NAO_LOCALIZADO" : "CONSULTA_SEM_RESPOSTA",
        consultas,
        proximaConsultaEm: Timestamp.fromMillis(agora.toMillis() + proximoIntervaloConsulta(consultas)),
      }, usuario, agora);
    });
    return { operacao: operacaoEmissaoPublica(proxima) };
  }

  return { emitir, reconciliar };
}

module.exports = {
  ESTADOS,
  TRANSICOES,
  ErroProvedorFiscal,
  ambienteFiscalConfigurado,
  criarEmissorFiscal,
  podeTransicionar,
  proximoIntervaloConsulta,
};
