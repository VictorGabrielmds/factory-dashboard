// ============================================================================
// CONSULTA DE TAXA DE ENTREGA — App Cliente
// Só uma PRÉVIA pro cliente ver a taxa antes de finalizar (mesmo espírito
// de validarCupom): a Cloud Function é sempre a fonte da verdade, porque o
// app cliente nunca lê zonas_entrega/configuracoes direto (ver
// firestore.rules). criarPedido recalcula a taxa de novo na hora de
// gravar o pedido — esta consulta nunca é usada pra cobrar nada.
// ============================================================================

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { buscarInfoZona, listarBairrosAtivos } = require("../services/entrega");
const { CONSULTA_LEVE } = require("../runtime/capacidade");

const consultarTaxaEntrega = onCall(
  {
    ...CONSULTA_LEVE,
    region: "southamerica-east1",
    enforceAppCheck: true,
  },
  async (request) => {
    // Sem exigir login — visitante monta o pedido inteiro (endereço incluso)
    // antes de se cadastrar; login só é pedido no "Finalizar pedido".
    const bairro = String(request.data?.bairro || "").trim();
    if (!bairro) {
      throw new HttpsError("invalid-argument", "Informe o bairro.");
    }
    // tempoMinutos alimenta a antecedência mínima de agendamento no
    // carrinho — um bairro longe não pode ficar disponível pra daqui 10min.
    const { taxa, tempoEntregaMinutos } = await buscarInfoZona(bairro);
    return { taxa, tempoMinutos: tempoEntregaMinutos };
  }
);

// Lista os bairros cadastrados (só o nome) pra alimentar o autocomplete do
// campo de bairro no checkout — não é informação sensível (não é como um
// código de cupom, não há nada pra "abusar" sabendo quais bairros a loja
// atende), então nem exige login.
const listarBairrosEntrega = onCall(
  {
    ...CONSULTA_LEVE,
    region: "southamerica-east1",
    enforceAppCheck: true,
  },
  async () => {
    const bairros = await listarBairrosAtivos();
    return { bairros };
  }
);

module.exports = { consultarTaxaEntrega, listarBairrosEntrega };
