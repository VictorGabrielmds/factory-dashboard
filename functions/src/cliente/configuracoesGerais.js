// ============================================================================
// CONSULTA DE CONFIGURAÇÕES GERAIS — App Cliente
// Taxa de débito/crédito (pra mostrar no resumo do pedido) e o WhatsApp da
// loja (pra montar o link de "solicitar alteração") — nada sensível, mesmo
// espírito de consultarHorarioFuncionamento/consultarOrdemCategorias.
// ============================================================================

const { onCall } = require("firebase-functions/v2/https");
const { buscarConfiguracaoGeral } = require("../services/pagamento");
const { CONSULTA_LEVE } = require("../runtime/capacidade");

const consultarConfiguracoesGerais = onCall(
  {
    ...CONSULTA_LEVE,
    region: "southamerica-east1",
    enforceAppCheck: true,
  },
  async () => {
    return buscarConfiguracaoGeral();
  }
);

module.exports = { consultarConfiguracoesGerais };
