// src/components/ClientesDashboard/clientesHelpers.ts
// A agregação em si roda no servidor agora (functions/src/api/clientes.js) —
// baixar o histórico inteiro de pedidos pro navegador pra somar aqui travava
// a aba em períodos maiores ("todo o período" chegava a dezenas de milhares
// de documentos). Aqui só ficam os tipos (espelham o retorno do endpoint) e
// o formatador de moeda, usado na renderização.

export interface ClienteResumo {
  telefone: string;
  nome: string;
  totalPedidos: number;
  valorTotalGasto: number;
  primeiroPedidoEm: string;
  ultimoPedidoEm: string;
}

export interface ItemResumo {
  nome: string;
  quantidadeTotal: number;
  faturamentoTotal: number;
  pedidosCount: number;
}

export interface EstatisticasClientes {
  totalPedidosValidos: number;
  faturamentoTotal: number;
  ticketMedio: number;
  clientesUnicos: number;
  clientesRecorrentes: number;
  clientesUmPedido: number;
  clientesUmPedidoTruncado: boolean;
  taxaRecompra: number; // % de clientesUnicos que são recorrentes
  rankingClientes: ClienteResumo[];
  listaClientesUmPedido: ClienteResumo[];
  itensMaisPedidos: ItemResumo[];
}

export function formatarMoeda(valor: number): string {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
