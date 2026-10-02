// src/types/Pedido.ts

/**
 * Status possíveis de um pedido (Mapeados da API do InstaDelivery e Firebase).
 */
export const PedidoStatus = {
  Recebido: 1,
  Aceito: 2,
  Pronto: 3, // Pode ser Saiu para Entrega ou Pronto para Retirada
  Cancelado: 4,
  EmRota: 5, // Status interno da fábrica quando o motoboy pega
} as const;

export type PedidoStatusType = typeof PedidoStatus[keyof typeof PedidoStatus];

export interface Pedido {
  // --- IDENTIFICAÇÃO ---
  order_id: string | number; // InstaDelivery manda number, Firebase doc.id é string
  data_venda: string;
  data_operacional?: string;
  status?: PedidoStatusType | number;
  status_interno?: string; // ✅ Nosso controle do chat/confirmação no WhatsApp
  
  // --- CLIENTE ---
  nome_destinatario: string;
  telefone_destinatario: string;

  // --- VALORES E PAGAMENTO ---
  valor_venda: number | string; // Pode vir como "278" da API
  valor_itens?: number; // subtotal dos itens, só em pedidos do app cliente
  valor_desconto?: number;
  valor_taxa_cartao?: number;
  forma_pagamento: string[] | string; // API manda ["01"]

  // --- OBSERVAÇÕES ---
  // Texto livre digitado pelo cliente no checkout (só em pedidos do app
  // cliente, ver criarPedido em functions/src/cliente/pedidos.js).
  observacoes?: string;
  
  // --- ITENS ---
  descricao_item: string[];
  quantidade_item: number[];
  // Paralelo a descricao_item/quantidade_item — só em pedidos do app cliente
  valor_total_item?: number[];
  produto_id_item?: string[];

  // --- ORIGEM ---
  // Presente só em pedidos vindos do app cliente (criarPedido); ausente = InstaDelivery/PDV.
  origem?: "app" | "instadelivery" | "insta_delivery" | number;

  // --- ENTREGA E ENDEREÇO (Tudo Opcional pois RETIRADA não tem) ---
  // Explícito só em pedidos criados pelo app cliente (criarPedido); pedidos
  // vindos do InstaDelivery (webhook) não têm — usar ehPedidoDelivery() como
  // fallback nesse caso, nunca ler este campo diretamente.
  tipo_entrega?: "delivery" | "retirada";
  bairro_destinatario?: string;
  logradouro_destinatario?: string;
  numero_destinatario?: number | string;
  complemento_destinatario?: string;
  cep_destinatario?: string;
  valor_taxa?: number | string; 
  
  // --- LOGÍSTICA INTERNA (App da Fábrica) ---
  motoboy_id?: string;
  motoboy_nome?: string;
  data_saida?: string;
  agendamento?: string | null;
  extras_trip?: string[];
  avulso?: boolean;
  isOk?: boolean;
  pix_confirmado?: boolean;
  pix_status?: "CREATING" | "PENDING" | "OVERDUE" | "RECEIVED" | "REFUND_IN_PROGRESS" | "PARTIALLY_REFUNDED" | "REFUNDED" | string;
  pix_pagamento_id?: string;
  pix_estornado?: boolean;
  pix_estorno_parcial?: boolean;
  pix_estorno_em_andamento?: boolean;

  // --- COZINHA (tela de preparo) ---
  cozinha_itens_prontos?: number[]; // índices de descricao_item/quantidade_item já preparados
  cozinha_concluido?: boolean;
  cozinha_concluido_em?: { toMillis: () => number } | null;

  // --- IMPRESSÃO (RoboImpressaoDelivery) ---
  // Gravado false pelo painel pra forçar reimpressão automática (o robô escuta
  // pedidos com status 2 e reimprime sozinho quando este campo vira false).
  impresso?: boolean;
}
