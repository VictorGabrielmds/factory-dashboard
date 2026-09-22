// ============================================================================
// OPERAÇÕES TRANSACIONAIS DE PEDIDOS
//
// Mantém a escrita crítica fora do navegador e fora dos callbacks puros. As
// dependências são injetadas para testar a transação no Emulator Suite sem
// tocar no banco de produção.
// ============================================================================

const { decidirCancelamento } = require("./comandosPedidos");
const {
  COLECAO_NOTIFICACOES_PEDIDO,
  ESTADOS_NOTIFICACAO,
  dadosNotificacaoCancelamento,
  idNotificacaoCancelamento,
  visaoNotificacaoPedido,
} = require("./notificacoesPedido");

function operadorParaAuditoria(operador) {
  return {
    uid: operador.uid,
    email: operador.email,
    nome: operador.nome,
    papel: operador.papel,
    papeis: Array.isArray(operador.papeis) ? operador.papeis : [],
  };
}

async function executarCancelamento({
  db,
  FieldValue,
  pedidoId,
  operador,
  decisaoPermissao,
}) {
  const pedidoRef = db.collection("pedidos").doc(pedidoId);
  const auditoriaRef = db.collection("auditorias_operacao").doc();
  const notificacaoId = idNotificacaoCancelamento(pedidoId);
  const notificacaoRef = db.collection(COLECAO_NOTIFICACOES_PEDIDO).doc(notificacaoId);

  return db.runTransaction(async (tx) => {
    // As duas leituras vêm antes de qualquer escrita. Isso permite que a
    // transação seja repetida pelo Firestore sem criar dois avisos caso dois
    // operadores cliquem em "cancelar" quase ao mesmo tempo.
    const [pedidoSnap, notificacaoSnap] = await Promise.all([
      tx.get(pedidoRef),
      tx.get(notificacaoRef),
    ]);
    const decisao = decidirCancelamento(pedidoSnap.exists ? pedidoSnap.data() : null);
    if (!decisao.encontrado || decisao.jaCancelado || !decisao.permitido) return decisao;

    const agora = FieldValue.serverTimestamp();
    const pedido = pedidoSnap.data() || {};
    const notificacaoCriada = !notificacaoSnap.exists;

    tx.update(pedidoRef, {
      status: 4,
      canceladoEm: agora,
      canceladoPor: operadorParaAuditoria(operador),
      notificacao_cancelamento: visaoNotificacaoPedido({
        id: notificacaoId,
        estado: notificacaoCriada
          ? ESTADOS_NOTIFICACAO.PENDENTE
          : (notificacaoSnap.data()?.estado || ESTADOS_NOTIFICACAO.PENDENTE),
      }),
    });
    if (notificacaoCriada) {
      tx.create(notificacaoRef, dadosNotificacaoCancelamento({
        pedidoId,
        pedido,
        origem: "cancelamento_painel",
        agora,
      }));
    }
    tx.set(auditoriaRef, {
      acao: "pedido_cancelado",
      pedidoId,
      operador: operadorParaAuditoria(operador),
      autorizacao: {
        ...decisaoPermissao,
        papeis: Array.isArray(operador.papeis) ? operador.papeis : [],
      },
      estadoAnterior: {
        status: pedido.status ?? null,
        pixConfirmado: decisao.pixConfirmado,
      },
      notificacao: {
        id: notificacaoId,
        criada: notificacaoCriada,
        estado: notificacaoCriada
          ? ESTADOS_NOTIFICACAO.PENDENTE
          : (notificacaoSnap.data()?.estado || ESTADOS_NOTIFICACAO.PENDENTE),
      },
      criadoEm: agora,
    });
    return {
      ...decisao,
      notificacaoId,
      notificacaoCriada,
      notificacaoEstado: notificacaoCriada
        ? ESTADOS_NOTIFICACAO.PENDENTE
        : (notificacaoSnap.data()?.estado || ESTADOS_NOTIFICACAO.PENDENTE),
    };
  });
}

module.exports = { operadorParaAuditoria, executarCancelamento };
