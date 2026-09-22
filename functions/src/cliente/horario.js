// ============================================================================
// CONSULTA DE HORÁRIO DE FUNCIONAMENTO — App Cliente
// configuracoes/horario é staff-only nas regras (mesmo motivo de
// zonas_entrega/configuracoes-entrega) — o app cliente lê através desta
// function em vez de acessar o Firestore direto. criarPedido valida de novo
// no servidor; esta consulta só serve pro cardápio montar os horários
// disponíveis pra agendar.
// ============================================================================

const { onCall } = require("firebase-functions/v2/https");
const { buscarHorarioFuncionamento } = require("../services/horario");
const { CONSULTA_LEVE } = require("../runtime/capacidade");

const consultarHorarioFuncionamento = onCall(
  {
    ...CONSULTA_LEVE,
    region: "southamerica-east1",
    enforceAppCheck: true,
  },
  async () => {
    // Sem exigir login — visitante precisa ver "aberto agora"/horários antes
    // de se cadastrar, igual à ordem das categorias (ver categorias.js).
    const horario = await buscarHorarioFuncionamento();
    return { horario };
  }
);

module.exports = { consultarHorarioFuncionamento };
