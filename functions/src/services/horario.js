// ============================================================================
// SERVIÇO DE HORÁRIO DE FUNCIONAMENTO
// Config única (configuracoes/horario) compartilhada entre a consulta pública
// (consultarHorarioFuncionamento) e a validação de verdade em criarPedido —
// o cliente escolhe um horário só como prévia, o servidor sempre confere de
// novo antes de gravar o pedido (mesmo princípio de taxa/cupom/produto).
// ============================================================================

const admin = require("firebase-admin");
const { dataHoraAtualSP } = require("../lib/util");

const db = () => admin.firestore();

const DIAS_SEMANA = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];

// Um dia é uma lista de TURNOS (não um único abre/fecha) — cada turno tem
// seu próprio horário e seus próprios toggles de delivery/retirada. Isso
// cobre de um jeito só: horário de almoço (dois turnos com um vão entre
// eles), e dias em que delivery e retirada funcionam em janelas diferentes
// (ex.: retirada abre mais cedo pro almoço, delivery só à noite).
const DIA_PADRAO = { ativo: false, turnos: [] };

const DIAS_ANTECEDENCIA_PADRAO = 1; // hoje + amanhã, se o doc nunca foi configurado
const INTERVALO_MINUTOS_PADRAO = 30;

// Sempre devolve os 7 dias preenchidos, mesmo se o doc nunca foi salvo ou
// algum dia individual estiver faltando — nunca deixa a validação quebrar
// por config incompleta. `turnos` sempre vira array (defende contra doc no
// formato antigo, de antes dos turnos, que tinha abre/fecha direto no dia).
async function buscarHorarioFuncionamento() {
  const snap = await db().collection("configuracoes").doc("horario").get();
  const dados = snap.exists ? snap.data() : {};
  const diasSalvos = dados.dias || {};

  const dias = {};
  for (const dia of DIAS_SEMANA) {
    const diaSalvo = diasSalvos[dia] || {};
    dias[dia] = {
      ativo: diaSalvo.ativo ?? DIA_PADRAO.ativo,
      turnos: Array.isArray(diaSalvo.turnos) ? diaSalvo.turnos : [],
    };
  }

  return {
    diasAntecedencia: Number.isFinite(dados.diasAntecedencia) ? dados.diasAntecedencia : DIAS_ANTECEDENCIA_PADRAO,
    intervaloMinutos: Number.isFinite(dados.intervaloMinutos) ? dados.intervaloMinutos : INTERVALO_MINUTOS_PADRAO,
    dias,
  };
}

// "2026-07-15" → "terca". Deriva o dia da semana só a partir dos componentes
// ano/mês/dia (nunca de um instante/timestamp), pra não depender do fuso
// horário do runtime da function.
function diaSemanaKey(dataISO) {
  const [ano, mes, dia] = String(dataISO).split("-").map(Number);
  return DIAS_SEMANA[new Date(ano, mes - 1, dia).getDay()];
}

// Diferença em dias de calendário entre duas datas "AAAA-MM-DD" (positiva se
// b é depois de a) — só olha ano/mês/dia, nunca hora, então não sofre com
// horário de verão nem fuso do runtime.
function diasEntre(dataISOa, dataISOb) {
  const [a1, a2, a3] = String(dataISOa).split("-").map(Number);
  const [b1, b2, b3] = String(dataISOb).split("-").map(Number);
  const da = new Date(a1, a2 - 1, a3);
  const db_ = new Date(b1, b2 - 1, b3);
  return Math.round((db_.getTime() - da.getTime()) / 86400000);
}

function horaParaMinutos(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Mesmo formato/fuso de dataHoraAtualSP (lib/util.js), mas pra uma Date
// arbitrária — usado aqui pra deslocar "agora" pela antecedência mínima.
function formatarDataHoraSP(data) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(data);
}

// Um turno "atende" um tipo de entrega se estiver marcado pra isso E a hora
// cair dentro dele (inclusive nas pontas).
function turnoAtende(turno, hora, tipoEntrega) {
  const habilitado = tipoEntrega === "delivery" ? turno.deliveryAtivo : turno.retiradaAtivo;
  if (!habilitado) return false;
  const minutos = horaParaMinutos(hora);
  return minutos >= horaParaMinutos(turno.abre) && minutos <= horaParaMinutos(turno.fecha);
}

// Confere se a data+hora escolhida é agendável de verdade — usada tanto pra
// devolver uma prévia (consultarHorarioFuncionamento) quanto pra recusar de
// verdade um pedido fora de hora (criarPedido), sempre com a MESMA regra.
//
// `antecedenciaMinutos` é o tempo mínimo entre agora e o horário escolhido —
// 0 pra retirada, ou o tempo estimado de moto até o bairro pra delivery (ver
// buscarInfoZona em services/entrega.js). Sem isso, um bairro a 40min de
// moto ficaria "disponível" pra daqui 10min, o que não faz sentido.
function validarAgendamento(configHorario, dataISO, hora, tipoEntrega, antecedenciaMinutos = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataISO)) || !/^\d{2}:\d{2}$/.test(String(hora))) {
    return { valido: false, motivo: "Data ou horário inválidos." };
  }

  const hojeISO = dataHoraAtualSP().slice(0, 10);
  const diasAFrente = diasEntre(hojeISO, dataISO);
  if (diasAFrente < 0) {
    return { valido: false, motivo: "Escolha um horário que ainda não passou." };
  }
  if (diasAFrente > configHorario.diasAntecedencia) {
    const limite = configHorario.diasAntecedencia;
    return {
      valido: false,
      motivo: limite === 0
        ? "Só é possível agendar para hoje."
        : `Só é possível agendar com até ${limite} dia${limite > 1 ? "s" : ""} de antecedência.`,
    };
  }

  const dia = diaSemanaKey(dataISO);
  const config = configHorario.dias[dia];
  if (!config?.ativo || config.turnos.length === 0) {
    return { valido: false, motivo: "Fechado nesse dia." };
  }

  const algumTurnoAtende = config.turnos.some((turno) => turnoAtende(turno, hora, tipoEntrega));
  if (!algumTurnoAtende) {
    const tipoIndisponivel = tipoEntrega === "delivery"
      ? config.turnos.every((t) => !t.deliveryAtivo)
      : config.turnos.every((t) => !t.retiradaAtivo);
    return {
      valido: false,
      motivo: tipoIndisponivel
        ? (tipoEntrega === "delivery" ? "Delivery indisponível nesse dia." : "Retirada indisponível nesse dia.")
        : "Fora do horário de funcionamento.",
    };
  }

  // Não deixa agendar antes de "agora + antecedência mínima" — comparação
  // lexicográfica de strings "AAAA-MM-DD HH:mm", mesmo truque já usado com
  // data_venda no projeto.
  const agendamentoStr = `${dataISO} ${hora}`;
  const minimoPermitido = new Date(Date.now() + antecedenciaMinutos * 60000);
  const minimoStr = formatarDataHoraSP(minimoPermitido).slice(0, 16);
  if (agendamentoStr < minimoStr) {
    return {
      valido: false,
      motivo: antecedenciaMinutos > 0
        ? `Escolha um horário com pelo menos ${antecedenciaMinutos} min de antecedência (tempo estimado até esse endereço).`
        : "Escolha um horário que ainda não passou.",
    };
  }

  return { valido: true };
}

// "2026-07-15" + "19:30" → "Dia 15/07 - 19:30" — MESMO formato que o painel
// já lê em toda parte (ver parseAgendamentoDate em src/utils/dateUtils.ts
// no factory-dashboard: CozinhaDashboard, OrderDashboard, OrderCard).
function formatarAgendamento(dataISO, hora) {
  const [, mes, dia] = String(dataISO).split("-");
  return `Dia ${dia}/${mes} - ${hora}`;
}

module.exports = {
  DIAS_SEMANA,
  buscarHorarioFuncionamento,
  diaSemanaKey,
  validarAgendamento,
  formatarAgendamento,
};
