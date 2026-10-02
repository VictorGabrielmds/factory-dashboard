// ============================================================================
// OPERAÇÕES FISCAIS DURÁVEIS — preparação sem efeito externo
//
// Este módulo cria a identidade única e o snapshot imutável de uma futura
// emissão. Ele não chama a Eficiência Fiscal e não autoriza documentos.
// ============================================================================

const {
  CNPJ_EMITENTE,
  ErroFiscal,
  hash,
  hashFontePedidoFiscal,
  idValido,
} = require("./modelo");

const VERSAO_OPERACAO_FISCAL = 1;
const AMBIENTE_PREPARADO = "homologacao";
const ESTADO_PREPARADO = "preparada";

function idOperacaoFiscal(pedidoId, ambiente = AMBIENTE_PREPARADO) {
  if (!idValido(pedidoId)) {
    throw new ErroFiscal("PEDIDO_ID_INVALIDO", "Informe um ID de pedido válido.");
  }
  if (ambiente !== AMBIENTE_PREPARADO) {
    throw new ErroFiscal(
      "AMBIENTE_FISCAL_NAO_LIBERADO",
      "A preparação fiscal está limitada ao ambiente de homologação.",
      423
    );
  }
  return `op_${hash([VERSAO_OPERACAO_FISCAL, CNPJ_EMITENTE, ambiente, pedidoId]).slice(0, 48)}`;
}

function iso(valor) {
  return valor?.toDate?.().toISOString() || null;
}

function operacaoPublica(operacao, repetida = false) {
  return {
    id: operacao.id,
    pedidoId: operacao.pedidoId,
    ambiente: operacao.ambiente,
    estado: operacao.estado,
    referenciaExterna: operacao.referenciaExterna,
    fonteHash: operacao.fonteHash,
    envioHabilitado: operacao.envioHabilitado === true,
    bloqueios: Array.isArray(operacao.bloqueios) ? operacao.bloqueios : [],
    criadoEm: iso(operacao.criadoEm),
    atualizadoEm: iso(operacao.atualizadoEm),
    repetida,
  };
}

function validarConferencia(conferencia, pedidoId, fonteHash) {
  if (!conferencia) {
    throw new ErroFiscal(
      "CONFERENCIA_NAO_ENCONTRADA",
      "Confira o pedido antes de preparar a emissão.",
      404
    );
  }
  if (conferencia.estado !== "conferido" || conferencia.emissaoHabilitada !== false ||
      !conferencia.snapshot || conferencia.snapshot.pedidoId !== pedidoId) {
    throw new ErroFiscal(
      "CONFERENCIA_COM_PENDENCIAS",
      "A conferência fiscal possui pendências e não pode ser preparada para emissão.",
      422
    );
  }
  if (typeof fonteHash !== "string" || fonteHash.length !== 64 || conferencia.fonteHash !== fonteHash) {
    throw new ErroFiscal(
      "CONFERENCIA_ALTERADA",
      "A conferência mudou. Atualize a tela antes de continuar.",
      409
    );
  }
  if (conferencia.snapshot.cnpjEmitente !== CNPJ_EMITENTE ||
      !/^FDAPP_[a-f0-9]{32}$/.test(conferencia.snapshot.referenciaExterna || "")) {
    throw new ErroFiscal(
      "CONFERENCIA_INVALIDA",
      "A conferência não possui uma referência fiscal válida.",
      422
    );
  }
}

function validarFontesAtuais({ conferencia, pedido, produtos, vinculos }) {
  if (!pedido || conferencia.pedidoFonteHash !== hashFontePedidoFiscal(conferencia.snapshot.pedidoId, pedido)) {
    throw new ErroFiscal(
      "PEDIDO_ALTERADO_APOS_CONFERENCIA",
      "O pedido mudou depois da conferência. Atualize a conferência antes de continuar.",
      409
    );
  }
  for (const item of conferencia.snapshot.itens || []) {
    const produto = produtos[item.produtoId];
    const vinculo = vinculos[item.produtoId];
    if (!produto || !vinculo || vinculo.revisado !== true ||
        vinculo.revisao !== item.revisaoVinculo ||
        vinculo.codigoProduto !== item.codigoProduto ||
        vinculo.nomeProdutoNaRevisao !== produto.nome) {
      throw new ErroFiscal(
        "VINCULO_ALTERADO_APOS_CONFERENCIA",
        "Um vínculo fiscal mudou depois da conferência. Confira novamente o pedido.",
        409
      );
    }
  }
}

async function prepararOperacaoFiscal({
  db,
  Timestamp,
  pedidoId,
  fonteHash,
  ambiente = AMBIENTE_PREPARADO,
  usuario,
  autorizacao = null,
}) {
  const operacaoId = idOperacaoFiscal(pedidoId, ambiente);
  const conferenciaRef = db.collection("fiscal_conferencias").doc(pedidoId);
  const pedidoRef = db.collection("pedidos").doc(pedidoId);
  const operacaoRef = db.collection("fiscal_operacoes").doc(operacaoId);

  return db.runTransaction(async (tx) => {
    const [conferenciaSnap, pedidoSnap, operacaoSnap] = await Promise.all([
      tx.get(conferenciaRef),
      tx.get(pedidoRef),
      tx.get(operacaoRef),
    ]);
    const conferencia = conferenciaSnap.data();
    validarConferencia(conferencia, pedidoId, fonteHash);

    const itens = Array.isArray(conferencia.snapshot.itens) ? conferencia.snapshot.itens : [];
    const produtoRefs = itens.map((item) => db.collection("produtos").doc(item.produtoId));
    const vinculoRefs = itens.map((item) => db.collection("fiscal_produtos").doc(item.produtoId));
    const [produtoSnaps, vinculoSnaps] = await Promise.all([
      produtoRefs.length ? tx.getAll(...produtoRefs) : [],
      vinculoRefs.length ? tx.getAll(...vinculoRefs) : [],
    ]);
    const produtos = Object.fromEntries(produtoSnaps.map((doc) => [doc.id, doc.data()]));
    const vinculos = Object.fromEntries(vinculoSnaps.map((doc) => [doc.id, doc.data()]));
    validarFontesAtuais({ conferencia, pedido: pedidoSnap.data(), produtos, vinculos });

    if (operacaoSnap.exists) {
      const existente = operacaoSnap.data();
      const igual = existente.pedidoId === pedidoId && existente.ambiente === ambiente &&
        existente.fonteHash === fonteHash &&
        existente.referenciaExterna === conferencia.snapshot.referenciaExterna;
      if (!igual) {
        throw new ErroFiscal(
          "OPERACAO_FISCAL_JA_EXISTE",
          "Já existe uma operação fiscal deste pedido com outra revisão.",
          409
        );
      }
      return { operacao: operacaoPublica(existente, true) };
    }

    const agora = Timestamp.now();
    const operacao = {
      id: operacaoId,
      versao: VERSAO_OPERACAO_FISCAL,
      tipo: "emissao",
      pedidoId,
      cnpjEmitente: CNPJ_EMITENTE,
      ambiente,
      estado: ESTADO_PREPARADO,
      referenciaExterna: conferencia.snapshot.referenciaExterna,
      fonteHash,
      pedidoFonteHash: conferencia.pedidoFonteHash,
      snapshotHash: hash(conferencia.snapshot),
      snapshot: conferencia.snapshot,
      envioHabilitado: false,
      bloqueios: [
        "CONTRATO_EF_NAO_CONFIRMADO",
        "HOMOLOGACAO_EF_NAO_VALIDADA",
        "RECUPERACAO_DE_RESPOSTA_NAO_VALIDADA",
      ],
      provedor: { nome: "eficiencia_fiscal", codigoEf: null, documento: null },
      criadoEm: agora,
      atualizadoEm: agora,
      criadoPor: usuario.uid,
    };
    const eventoRef = operacaoRef.collection("eventos").doc(`preparada_${fonteHash}`);
    tx.create(operacaoRef, operacao);
    tx.create(eventoRef, {
      tipo: "operacao_preparada",
      estado: ESTADO_PREPARADO,
      fonteHash,
      criadoEm: agora,
      criadoPor: usuario.uid,
      autorizacao,
    });
    return { operacao: operacaoPublica(operacao, false) };
  });
}

module.exports = {
  AMBIENTE_PREPARADO,
  ESTADO_PREPARADO,
  VERSAO_OPERACAO_FISCAL,
  idOperacaoFiscal,
  operacaoPublica,
  prepararOperacaoFiscal,
  validarConferencia,
  validarFontesAtuais,
};
