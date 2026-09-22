// src/types/chat.types.ts
import { Timestamp } from "firebase/firestore";

export interface Mensagem {
  id: string;
  sender: "incoming" | "outgoing";
  text: string;
  time: string;
  status?: "sent" | "delivered" | "read" | "failed" | "pending";
  erro?: string;
  mediaUrl?: string;
  mediaType?: "image" | "audio" | "sticker" | "document" | "video" | "location";
  timestamp?: Timestamp;
  editada?: boolean;
  textoOriginal?: string;
  replyTo?: string;
  editedAt?: Timestamp;
  clientId?: string;
  // Marca uma solicitação de alteração injetada pelo app cliente (ver
  // functions/src/cliente/solicitarAlteracao.js) — nunca veio de verdade
  // pelo WhatsApp, mas aparece no chat como se fosse. Vira o indicador "!".
  isAlteracao?: boolean;
  orderIdReferencia?: string;
}

export interface EnderecoContexto {
  bairro: string;
  detalhe: string;
  isRecorrente?: boolean;
}

export type PendenciaTipo =
  | "estorno"
  | "nota_fiscal"
  | "reentrega"
  | "robo_offline"
  | "outbox_falhou"
  | "whatsapp_falhou"
  | "pix_colisao"
  | "pix_sem_vinculo_exato"
  | "pix_evento_malformado"
  | "pix_evento_invalido"
  | "pix_processamento_atrasado"
  | "pix_status_inesperado"
  | "pix_pendente_sem_payment_id"
  | "pix_refunded"
  | "pix_partially_refunded"
  | "pix_refund_in_progress"
  | "payment_id_duplicado"
  | "pagamento_ja_usado"
  | "vinculo_pix_invalido"
  | "outro";

export interface Pendencia {
  id: string;
  chatId: string;
  tipo: PendenciaTipo;
  descricao: string;
  criadaEm: string;
  resolvida: boolean;
}

export interface Conversa {
  id: string;
  clientName: string;
  phone: string;
  lastMessage: string;
  time: string;
  unreadCount: number;
  hasCallPermission: boolean;
  tags: string[];
  pedidoHoje: {
    id: string;
    status: string;
    total: string;
    ehPix?: boolean;
    pixConfirmado?: boolean;
    pixStatus?: string;
    dataVenda?: string | null;
  } | null;
  enderecos: EnderecoContexto[];
  totalOrders: number;
  ltv: string;
  datasHistorico?: Array<Timestamp | Date>;
  messages: Mensagem[];
  isOnline?: boolean;
  finalizado?: boolean;
  pinned?: boolean;
  lastIncomingAt?: Timestamp | null;
  lastMessageAt?: Timestamp | null;
  criadoEm?: Timestamp | null;
  lastUnreadCount?: number;
  lastOrderAt?: { toMillis: () => number } | null;
  lastOrderType?: "DELIVERY" | "RETIRADA";
  lastMessageSender?: "incoming" | "outgoing";
  lastMessageStatus?: "sent" | "delivered" | "read" | "failed";
  lastMessageIsAlteracao?: boolean;
  pedidosBloqueados?: boolean;
  pedidosBloqueadosEm?: Timestamp | null;
}

export interface ConfigAtalhosRapidos {
  pix?: string;
  dadosCliente?: string;
}

export interface FrasePredefinida {
  shortcut: string;
  text: string;
}

export interface TagGlobal {
  label: string;
  color: string;
}

export interface TemplateComponent {
  type: string;
  text?: string;
  parameters?: { type: string }[];
}

export interface Template {
  id: string;
  name: string;
  status: string;
  category?: string;
  language?: string;
  components?: Record<string, unknown>[]; // ✅ O ESLint aceita isso sem reclamar
  preview?: string;
}

