import type { Pedido } from "../../types/Pedido";
import { PedidoStatus } from "../../types/Pedido";
import {
  brDateToISO,
  dateToISOString,
  parseBRDateTime,
  parseAgendamentoDate,
  parseISODateTime,
  removeAccents,
} from "../../utils/dateUtils";

function dataOperacionalISO(pedido: Pedido): string {
  if (pedido.status === PedidoStatus.EmRota && pedido.data_saida) {
    const dataSaida = pedido.data_saida.split(" às")[0].trim();
    return brDateToISO(dataSaida);
  }
  const dataAgendada = parseAgendamentoDate(pedido.agendamento);
  if (dataAgendada) return dateToISOString(dataAgendada);

  return pedido.data_venda?.split(" ")[0] ?? "";
}

export function pedidoCorrespondeAoDia(pedido: Pedido, selectedISO: string): boolean {
  if (pedido.status === PedidoStatus.EmRota && pedido.data_saida) {
    return dataOperacionalISO(pedido) === selectedISO;
  }

  const dataAgendada = parseAgendamentoDate(pedido.agendamento);
  if (!dataAgendada) return dataOperacionalISO(pedido) === selectedISO;

  const agendamentoISO = dateToISOString(dataAgendada);
  if (agendamentoISO === selectedISO) return true;

  // Um agendamento futuro criado hoje aparece na busca de hoje também,
  // sempre mantendo a indicação de agendamento no card.
  const hojeISO = dateToISOString(new Date());
  const vendaISO = pedido.data_venda?.split(" ")[0] ?? "";
  return selectedISO === hojeISO && vendaISO === hojeISO && agendamentoISO > hojeISO;
}

function horarioOperacional(pedido: Pedido): number {
  if (pedido.status === PedidoStatus.EmRota && pedido.data_saida) {
    return parseBRDateTime(pedido.data_saida).getTime();
  }
  return parseISODateTime(pedido.data_venda).getTime();
}

export function pedidoCorrespondeBusca(pedido: Pedido, searchTerm: string): boolean {
  const term = removeAccents(searchTerm.toLowerCase().trim());
  if (!term) return true;

  const name = removeAccents((pedido.nome_destinatario ?? "").toLowerCase());
  const orderId = String(pedido.order_id ?? "").toLowerCase();
  const normalizedOrderIdTerm = term
    .replace(/^pedido\s*#?\s*/, "")
    .replace(/^#+/, "")
    .trim();

  return name.includes(term) || (
    normalizedOrderIdTerm.length > 0 && orderId.includes(normalizedOrderIdTerm)
  );
}

export function filtrarPedidosDaBuscaPorDia(
  data: Pedido[],
  selectedDate: Date,
  searchTerm: string
): Pedido[] {
  const term = removeAccents(searchTerm.toLowerCase().trim());
  if (!term) return [];
  const selectedISO = dateToISOString(selectedDate);

  return data
    .filter(
      (pedido) =>
        pedido.status === PedidoStatus.Recebido ||
        pedido.status === PedidoStatus.Aceito ||
        pedido.status === PedidoStatus.Pronto ||
        pedido.status === PedidoStatus.EmRota
    )
    .filter((pedido) => pedidoCorrespondeBusca(pedido, term))
    .filter((pedido) => pedidoCorrespondeAoDia(pedido, selectedISO))
    .sort((a, b) => horarioOperacional(b) - horarioOperacional(a));
}
