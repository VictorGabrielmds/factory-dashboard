// Produtor interno para pedidos do App Cliente. Permanece sem exportação no
// index: só será ativado depois de configurar explicitamente a fila e concluir
// o piloto. O robô nunca cria trabalho a partir de um pedido por conta própria.
const admin = require("firebase-admin");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { UID_DISPOSITIVO, autorizarCadastro, COLECAO_DISPOSITIVOS } = require("./acessoDispositivo");
const { criarTrabalhoImpressao } = require("./trabalhos");
const { projetarRecibo } = require("./consultaRestrita");

const PAGAMENTOS = { "01": "Dinheiro", "03": "Cartão de crédito", "04": "Cartão de débito", "17": "PIX" };
const VERSAO_LIBERACAO_INICIAL = "app_liberado_v1";

function codigoPagamento(pedido) {
  const bruto = Array.isArray(pedido?.forma_pagamento) ? pedido.forma_pagamento[0] : pedido?.forma_pagamento;
  const codigo = String(bruto ?? "").trim();
  return /^\d{1,2}$/.test(codigo) ? codigo.padStart(2, "0") : null;
}
function valorEmCentavos(valor) {
  if (typeof valor !== "number" || !Number.isFinite(valor) || valor < 0 || valor > 1000000) return null;
  const centavos = Math.round((valor + Number.EPSILON) * 100);
  return Math.abs(valor * 100 - centavos) < 0.000001 ? centavos : null;
}
function texto(valor, limite = 500) {
  if (typeof valor !== "string") return "";
  return valor.length <= limite ? valor : "";
}
function pedidoElegivelParaImpressao(pedido) {
  if (pedido?.origem !== "app" || pedido?.status === 4 || !["delivery", "retirada"].includes(pedido?.tipo_entrega)) return false;
  const pagamento = codigoPagamento(pedido);
  if (pagamento === "17") return pedido.pix_confirmado === true && pedido.pix_status === "RECEIVED";
  // O checkout atual só oferece débito/crédito além de PIX. Dinheiro está
  // previsto para uma evolução futura, mantendo esta regra explícita.
  return ["01", "03", "04"].includes(pagamento) && pedido.status === 2;
}

function montarReciboDoPedido({ pedidoId, pedido }) {
  if (typeof pedidoId !== "string" || !pedidoElegivelParaImpressao(pedido)) return null;
  const descricao = Array.isArray(pedido.descricao_item) ? pedido.descricao_item : [];
  const quantidade = Array.isArray(pedido.quantidade_item) ? pedido.quantidade_item : [];
  const totalCentavos = valorEmCentavos(pedido.valor_venda);
  const pagamentoCodigo = codigoPagamento(pedido);
  if (!descricao.length || descricao.length !== quantidade.length || descricao.length > 100 || totalCentavos === null || !PAGAMENTOS[pagamentoCodigo]) {
    return null;
  }
  const itens = descricao.map((nome, indice) => ({ nome: texto(nome, 160), quantidade: quantidade[indice], observacoes: "" }));
  const recibo = {
    versao: 1,
    pedidoId,
    tipo: pedido.tipo_entrega,
    nome: texto(pedido.nome_destinatario, 160),
    horarioAgendado: texto(pedido.agendamento, 80),
    pagamento: PAGAMENTOS[pagamentoCodigo],
    pago: pagamentoCodigo === "17",
    totalCentavos,
    observacoes: texto(pedido.observacoes, 1000),
    itens,
  };
  if (pedido.tipo_entrega === "delivery") {
    const logradouro = texto(pedido.logradouro_destinatario, 180);
    const numero = texto(String(pedido.numero_destinatario ?? ""), 30);
    recibo.entrega = {
      endereco: logradouro && numero ? `${logradouro}, ${numero}` : "",
      bairro: texto(pedido.bairro_destinatario, 120),
      complemento: texto(pedido.complemento_destinatario, 240),
      referencia: texto(pedido.referencia, 240),
      contato: texto(pedido.telefone_destinatario, 30),
    };
  }
  try { return projetarRecibo(recibo); } catch { return null; }
}

function escolherDestino(configuracao, dispositivo, staffExiste) {
  const uid = configuracao?.dispositivoPadraoUid;
  if (configuracao?.filaAtiva !== true || !UID_DISPOSITIVO.test(uid || "")) {
    return { ok: false, codigo: "FILA_DE_IMPRESSAO_DESATIVADA" };
  }
  const identidade = { uid, credencialVersao: dispositivo?.credencialVersao };
  if (!Number.isSafeInteger(identidade.credencialVersao) || identidade.credencialVersao < 1) {
    return { ok: false, codigo: "DESTINO_DE_IMPRESSAO_INVALIDO" };
  }
  const decisao = autorizarCadastro({ identidade, dispositivo, staffExiste, configuracao });
  return decisao.ok
    ? { ok: true, dispositivoUid: uid, credencialVersao: identidade.credencialVersao }
    : { ok: false, codigo: decisao.codigo };
}

async function produzirTrabalhoDoPedido({ db, FieldValue, Timestamp, pedidoId, pedido, agoraMs = Date.now() }) {
  const recibo = montarReciboDoPedido({ pedidoId, pedido });
  if (!recibo) return { ok: false, status: 204, codigo: "PEDIDO_NAO_ELEGIVEL" };
  const configSnap = await db.collection("configuracoes").doc("impressao_api").get();
  const configuracao = configSnap.data();
  const uid = configuracao?.dispositivoPadraoUid;
  if (!UID_DISPOSITIVO.test(uid || "") || configuracao?.filaAtiva !== true) {
    return { ok: false, status: 204, codigo: "FILA_DE_IMPRESSAO_DESATIVADA" };
  }
  const [dispositivoSnap, staffSnap] = await Promise.all([
    db.collection(COLECAO_DISPOSITIVOS).doc(uid).get(),
    db.collection("staff").doc(uid).get(),
  ]);
  const destino = escolherDestino(configuracao, dispositivoSnap.data(), staffSnap.exists);
  if (!destino.ok) return { ok: false, status: 409, codigo: destino.codigo };
  return criarTrabalhoImpressao({ db, FieldValue, Timestamp, pedidoId, versaoFonte: VERSAO_LIBERACAO_INICIAL,
    dispositivoUid: destino.dispositivoUid, credencialVersao: destino.credencialVersao, recibo, agoraMs });
}

// Não exportar esta função no index enquanto não houver configuração de destino,
// endpoint de device e piloto coordenado. Firestore entrega eventos ao menos uma
// vez; o ID determinístico do trabalho absorve repetições sem nova impressão.
function criarGatilhoProdutorPedidos() {
  return onDocumentWritten({ document: "pedidos/{pedidoId}", retry: true, region: "southamerica-east1" }, async (event) => {
    const depois = event.data?.after;
    if (!depois?.exists) return;
    const resultado = await produzirTrabalhoDoPedido({ db: admin.firestore(), FieldValue: admin.firestore.FieldValue,
      Timestamp: admin.firestore.Timestamp, pedidoId: event.params.pedidoId, pedido: depois.data() });
    if (!resultado.ok && resultado.status >= 500) throw new Error(resultado.codigo);
  });
}

module.exports = {
  VERSAO_LIBERACAO_INICIAL, codigoPagamento, valorEmCentavos, pedidoElegivelParaImpressao,
  montarReciboDoPedido, escolherDestino, produzirTrabalhoDoPedido, criarGatilhoProdutorPedidos,
};
