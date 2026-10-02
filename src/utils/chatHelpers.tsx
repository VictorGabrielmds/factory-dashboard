// src/utils/chatHelpers.tsx
import React from "react";
import { Timestamp } from "firebase/firestore";
import {
  MdSwapHoriz, MdReceiptLong, MdWarningAmber,
  MdPendingActions, MdPrintDisabled,
  MdOutlineReportGmailerrorred, MdOutlineWifiOff
} from "react-icons/md";
import type { 
  FrasePredefinida, TagGlobal, PendenciaTipo, 
  Mensagem, TemplateComponent 
} from "../types/chat.types";

// ─── CONSTANTES PADRÃO ───
export const FRASES_PADRAO: FrasePredefinida[] = [
  { shortcut: "/ola",      text: "Olá! Como posso ajudar você hoje?" },
  { shortcut: "/cardapio", text: "Segue o nosso cardápio do dia com os valores atualizados: [Link]" },
  { shortcut: "/chegando", text: "O seu pedido já saiu para entrega e o motoboy está a caminho!" },
  { shortcut: "/pix",      text: "Nossa chave PIX celular é: (98) 99999-9999 (Fábrica de Salgados)" },
  { shortcut: "/fechado",  text: "Infelizmente já encerramos as atividades por hoje. Retornamos amanhã às 08h!" },
  { shortcut: "/prazo",    text: "O prazo de entrega estimado é de 40 a 60 minutos. 🛵" },
];

export const TAGS_PADRAO: TagGlobal[] = [
  { label: "VIP", color: "vip" },
  { label: "Frequente", color: "vip" },
  { label: "Novo", color: "new" },
  { label: "Problemático", color: "danger" },
  { label: "Devedor", color: "danger" },
];

export const COMMON_EMOJIS = [
  "😀","😂","🥰","😎","😉","😍","🤩","😋","😊","😏",
  "🙌","👍","✌","🤞","👏","🤝","🔥","✨","🎉","💯",
  "✅","❌","⚠","🍔","🍕","🍟","🥤","🛵","📦","💰"
];

export const TIPOS_PENDENCIA: { tipo: PendenciaTipo; label: string; icon: React.ReactNode }[] = [
  { tipo: "estorno",     label: "Estorno",       icon: <MdSwapHoriz size={14} /> },
  { tipo: "nota_fiscal", label: "Nota Fiscal",   icon: <MdReceiptLong size={14} /> },
  { tipo: "reentrega",   label: "Reentrega",     icon: <MdWarningAmber size={14} /> },
  { tipo: "robo_offline", label: "Robô de impressão offline", icon: <MdPrintDisabled size={14} /> },
  { tipo: "outbox_falhou", label: "Mensagem não entregue", icon: <MdOutlineReportGmailerrorred size={14} /> },
  { tipo: "whatsapp_falhou", label: "Falha no WhatsApp", icon: <MdOutlineWifiOff size={14} /> },
  { tipo: "outro",       label: "Outro",         icon: <MdPendingActions size={14} /> },
];

const LABELS_PENDENCIA_SISTEMA: Partial<Record<PendenciaTipo, string>> = {
  pix_colisao: "PIX com mais de um pedido possível",
  pix_sem_vinculo_exato: "PIX sem vínculo exato",
  pix_evento_malformado: "Evento inválido do Asaas",
  pix_evento_invalido: "Evento PIX inválido",
  pix_processamento_atrasado: "Confirmação PIX atrasada",
  pix_status_inesperado: "Status PIX divergente",
  pix_pendente_sem_payment_id: "PIX sem identificador",
  pix_refunded: "PIX estornado",
  pix_partially_refunded: "PIX parcialmente estornado",
  pix_refund_in_progress: "Estorno PIX em andamento",
  payment_id_duplicado: "Pagamento duplicado em pedidos",
  pagamento_ja_usado: "Pagamento já utilizado",
  vinculo_pix_invalido: "Dados do PIX não conferem",
};

const DICEBEAR_BG = ["bfdbfe","bbf7d0","fde68a","fecaca","e9d5ff","fed7aa"];

// ─── FUNÇÕES AUXILIARES ───
export function getInitials(name: string) {
  return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
}

export function getAvatarColor(name: string) {
  const colors = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export function getDiceBearUrl(name: string, size = 44): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const bg = DICEBEAR_BG[Math.abs(hash) % DICEBEAR_BG.length];
  return `https://api.dicebear.com/9.x/lorelei/svg?seed=${encodeURIComponent(name)}&size=${size}&radius=50&backgroundColor=${bg}`;
}

export function getTipoLabel(tipo: PendenciaTipo) {
  return TIPOS_PENDENCIA.find(t => t.tipo === tipo)?.label ?? LABELS_PENDENCIA_SISTEMA[tipo] ?? tipo;
}

export function getTipoIcon(tipo: PendenciaTipo) {
  return TIPOS_PENDENCIA.find(t => t.tipo === tipo)?.icon ?? <MdWarningAmber size={14} />;
}

export function getGroupClass(messages: Mensagem[], index: number): "solo" | "first" | "mid" | "last" {
  const curr = messages[index];
  const prev = messages[index - 1];
  const next = messages[index + 1];
  const sameAsPrev = prev && prev.sender === curr.sender;
  const sameAsNext = next && next.sender === curr.sender;
  if (sameAsPrev && sameAsNext) return "mid";
  if (sameAsPrev) return "last";
  if (sameAsNext) return "first";
  return "solo";
}

export function calcularJanela24h(lastIncomingAt: Timestamp | null | undefined): string | null {
  if (!lastIncomingAt) return null;
  const agora = Date.now();
  const ultima = lastIncomingAt.toMillis();
  const diff = 24 * 60 * 60 * 1000 - (agora - ultima);
  if (diff <= 0) return null;
  const horas = Math.floor(diff / (1000 * 60 * 60));
  const minutos = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (horas > 0) return `${horas}h ${minutos}m restantes`;
  return `${minutos}m restantes`;
}

export function contarVariaveisTemplate(components: TemplateComponent[]): number {
  const body = components.find(c => c.type === "BODY");
  if (!body?.text) return 0;
  const matches = body.text.match(/\{\{\d+\}\}/g);
  return matches ? matches.length : 0;
}

export function getTagClass(label: string): string {
  const tag = TAGS_PADRAO.find(t => t.label === label);
  if (!tag) return "tag-default";
  return `tag-${tag.color}`;
}

export function formatarHoraOuData(ts?: Timestamp | null): string {
  if (!ts) return "";
  const data = ts.toDate();
  const hoje = new Date();
  const ontem = new Date();
  ontem.setDate(ontem.getDate() - 1);
  const mesmoDia = (a: Date, b: Date) => a.toDateString() === b.toDateString();

  if (mesmoDia(data, hoje)) {
    return data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  if (mesmoDia(data, ontem)) return "Ontem";

  const diffDias = Math.floor((hoje.getTime() - data.getTime()) / 86400000);
  if (diffDias < 7) return data.toLocaleDateString("pt-BR", { weekday: "short" });
  return data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
