// ============================================================================
// CONSULTA DE ORDEM DAS CATEGORIAS — App Cliente
// configuracoes/categorias é staff-only nas regras (mesma coleção de
// horário/entrega) — o app cliente lê a ordem através desta function em vez
// de acessar o Firestore direto. Sem risco nenhum de exposta (só nomes de
// categoria, nada sensível), só não pode ler a coleção genérica.
// ============================================================================

const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { CONSULTA_LEVE } = require("../runtime/capacidade");

const db = () => admin.firestore();

const consultarOrdemCategorias = onCall(
  {
    ...CONSULTA_LEVE,
    region: "southamerica-east1",
    enforceAppCheck: true,
  },
  async () => {
    // Sem exigir login: é só a ordem/descrição das seções do cardápio, o
    // mesmo tipo de config não-sensível que "produtos" já expõe direto no
    // Firestore — visitante navega o cardápio inteiro antes de se cadastrar.
    const dados = (await db().collection("configuracoes").doc("categorias").get()).data();
    const ordem = dados?.ordem;
    const descricoes = dados?.descricoes;
    return {
      ordem: Array.isArray(ordem) ? ordem : [],
      descricoes: descricoes && typeof descricoes === "object" ? descricoes : {},
    };
  }
);

module.exports = { consultarOrdemCategorias };
