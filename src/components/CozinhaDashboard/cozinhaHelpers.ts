// src/components/CozinhaDashboard/cozinhaHelpers.ts
// Regras de "inteligência" da fila da cozinha: dificuldade (quanto trabalho o
// pedido dá) e urgência (quanto tempo falta até ele atrasar), combinadas num
// score único usado pra ordenar a arara — o pedido mais crítico sempre no
// topo, sem ninguém precisar ficar calculando isso de cabeça.
import type { Pedido } from "../../types/Pedido";
import { parseAgendamentoDate, extractTime, parseISODateTime, isSameDay, dateToISOString } from "../../utils/dateUtils";

export type UrgenciaPedido = "atrasado" | "urgente" | "normal" | "agendado";

export interface InteligenciaPedido {
  totalItens: number;
  numTiposItens: number;
  dificuldade: 1 | 2 | 3;
  urgencia: UrgenciaPedido;
  esperaMin: number;
  minutosParaAgendamento: number | null;
  horaAgendamento: string | null;
  diaAgendamentoTexto: string | null; // "Hoje", "Amanhã" ou "DD/MM"
  score: number;
}

// Mesma lógica já usada e confiável em OrdersList.tsx (filteredOrders, filtro
// status===2): pedido agendado conta pelo DIA DO AGENDAMENTO, os demais pela
// data da venda — comparando só a parte de data como string, sem passar por
// timezone nenhum. Antes a Cozinha não tinha esse filtro e mostrava QUALQUER
// pedido "Aceito" dentro da janela larga (±1 dia) do usePedidos, incluindo
// pedidos velhos que ficaram presos em Aceito de dias anteriores.
export function pertenceAoDiaAtual(pedido: Pedido, hojeISO: string): boolean {
  if (pedido.agendamento) {
    const dataAgendamento = parseAgendamentoDate(pedido.agendamento);
    if (dataAgendamento) return dateToISOString(dataAgendamento) === hojeISO;
  }
  const dataVendaISO = pedido.data_venda?.split(" ")[0] ?? "";
  return dataVendaISO === hojeISO;
}

// "agendamento" vem como "Dia 08/12 - 19:30" (ou sem hora) — parseAgendamentoDate
// só pega o dia; aqui a gente combina com extractTime pra ter data+hora completas.
function parseAgendamentoDateTime(agendamento?: string | null): Date | null {
  const dia = parseAgendamentoDate(agendamento);
  if (!dia) return null;
  const hora = extractTime(agendamento);
  if (hora) {
    const [h, m] = hora.split(":").map(Number);
    dia.setHours(h || 0, m || 0, 0, 0);
  }
  return dia;
}

export function calcularInteligenciaPedido(pedido: Pedido, agoraMs: number): InteligenciaPedido {
  const quantidades = pedido.quantidade_item ?? [];
  const totalItens = quantidades.reduce((soma, q) => soma + (Number(q) || 0), 0);
  const numTiposItens = (pedido.descricao_item ?? []).length;

  // Dificuldade: proxy simples de "quanto trabalho dá" pela quantidade total de unidades.
  let dificuldade: 1 | 2 | 3 = 1;
  if (totalItens >= 8) dificuldade = 3;
  else if (totalItens >= 4) dificuldade = 2;

  const dataVenda = parseISODateTime(pedido.data_venda);
  const esperaMin = dataVenda.getTime() > 0 ? (agoraMs - dataVenda.getTime()) / 60000 : 0;

  const dataAgendamento = parseAgendamentoDateTime(pedido.agendamento);
  const minutosParaAgendamento = dataAgendamento ? (dataAgendamento.getTime() - agoraMs) / 60000 : null;
  const horaAgendamento = extractTime(pedido.agendamento);

  let diaAgendamentoTexto: string | null = null;
  if (dataAgendamento) {
    const agora = new Date(agoraMs);
    const amanha = new Date(agora);
    amanha.setDate(amanha.getDate() + 1);
    if (isSameDay(dataAgendamento, agora)) diaAgendamentoTexto = "Hoje";
    else if (isSameDay(dataAgendamento, amanha)) diaAgendamentoTexto = "Amanhã";
    else diaAgendamentoTexto = `${String(dataAgendamento.getDate()).padStart(2, "0")}/${String(dataAgendamento.getMonth() + 1).padStart(2, "0")}`;
  }

  let urgencia: UrgenciaPedido;
  let scoreUrgencia: number;

  if (dataAgendamento && minutosParaAgendamento !== null && Math.abs(minutosParaAgendamento) < 20 * 60) {
    // Agendamento é hoje/próximo (dentro de ±20h) — pesa na urgência de agora.
    if (minutosParaAgendamento <= 0) {
      urgencia = "atrasado";
      scoreUrgencia = 1000 + Math.min(Math.abs(minutosParaAgendamento), 500);
    } else if (minutosParaAgendamento <= 20) {
      urgencia = "urgente";
      scoreUrgencia = 500 + (20 - minutosParaAgendamento);
    } else {
      urgencia = "agendado";
      scoreUrgencia = -minutosParaAgendamento;
    }
  } else if (dataAgendamento) {
    // Agendamento distante — fica no fim da fila, mais perto primeiro.
    urgencia = "agendado";
    scoreUrgencia = -(minutosParaAgendamento ?? 999999);
  } else {
    // Sem agendamento = pedido "para já": urgência cresce com o tempo de espera.
    urgencia = esperaMin >= 15 ? "atrasado" : esperaMin >= 8 ? "urgente" : "normal";
    scoreUrgencia = 300 + Math.min(esperaMin, 200);
  }

  const score = scoreUrgencia + dificuldade * 2; // dificuldade só desempata levemente

  return { totalItens, numTiposItens, dificuldade, urgencia, esperaMin, minutosParaAgendamento, horaAgendamento, diaAgendamentoTexto, score };
}

export function formatarEspera(minutos: number): string {
  if (minutos < 1) return "agora";
  if (minutos < 60) return `${Math.floor(minutos)} min`;
  const horas = Math.floor(minutos / 60);
  const resto = Math.floor(minutos % 60);
  return `${horas}h${resto > 0 ? ` ${resto}min` : ""}`;
}

const DIAS_SEMANA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** Date → "segunda-feira, 13 de julho" — cabeçalho de orientação na tela da cozinha. */
export function formatarDataCompletaPorExtenso(data: Date): string {
  return `${DIAS_SEMANA[data.getDay()]}, ${data.getDate()} de ${MESES[data.getMonth()]}`;
}

export const URGENCIA_LABEL: Record<UrgenciaPedido, string> = {
  atrasado: "Atrasado",
  urgente: "Urgente",
  normal: "Em preparo",
  agendado: "Agendado",
};

// Pedidos criados pelo app cliente (criarPedido) já vêm com tipo_entrega
// explícito. Pedidos do InstaDelivery (webhook) não têm esse campo — pra
// esses, cai no mesmo critério do robô de impressão (Form1.cs,
// EhPedidoDelivery) e das Cloud Functions (services/pedidos.js, ehDelivery):
// não depende só do CEP, porque pedidos reais às vezes chegam sem CEP mas
// com bairro/taxa preenchidos.
export function ehPedidoDelivery(pedido: Pedido): boolean {
  if (pedido.tipo_entrega === "delivery") return true;
  if (pedido.tipo_entrega === "retirada") return false;
  if (pedido.cep_destinatario) return true;
  if (pedido.bairro_destinatario) return true;
  const taxa = parseFloat(String(pedido.valor_taxa ?? "0").replace(",", "."));
  return !Number.isNaN(taxa) && taxa > 0;
}

// A retirada que aparece no painel operacional é a que o próprio cliente
// escolheu no Cardápio. Pedidos antigos, internos ou vindos de integrações sem
// essa origem não devem cair nessa fila por simples ausência de endereço.
export function ehRetiradaDoAppCliente(pedido: Pedido): boolean {
  return pedido.origem === "app" && pedido.tipo_entrega === "retirada";
}
