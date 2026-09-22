// src/components/ContextPanel/ContextPanel.tsx
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { 
  MdKeyboardArrowDown, MdKeyboardArrowRight, 
  MdLocationOn, MdHistory, MdAssignment, MdAdd,
  MdTrendingUp, MdWarningAmber, MdPersonOutline, MdBlock, MdLockOpen,
} from "react-icons/md";
import type { Conversa, Pendencia, PendenciaTipo } from "../../../../types/chat.types";
import { calcularJanela24h, TIPOS_PENDENCIA } from "../../../../utils/chatHelpers";
import { Avatar } from "../Shared/ChatUI";

export interface PedidoDetalheData {
  id?: string;
  order_id?: string;
  data_venda?: string;
  agendamento?: string;
  atendente?: string;          // ← ADICIONE ESTA LINHA
  cep_destinatario?: string;
  forma_pagamento?: string[];
  logradouro_destinatario?: string;
  numero_destinatario?: string;
  complemento_destinatario?: string;
  bairro_destinatario?: string;
  data_saida?: string;
  motoboy_nome?: string;             // ← nome do motoboy, preenchido quando o pedido entra em rota de entrega
  pix_confirmado?: boolean;
  pix_status?: string;
}

interface ContextPanelProps {
  activeChat: Conversa;
  pendenciasDoChat: Pendencia[];
  isLogisticsOpen: boolean;
  setIsLogisticsOpen: (isOpen: boolean) => void;
  onCloseActiveChat: () => void;
  onOpenHistory: () => void;
  onOpenFicha: () => void;
  pedidoDetalhe?: PedidoDetalheData | null;
  onTogglePedido: (orderId: string) => void;
  onAddPendencia: (chatId: string, tipo: PendenciaTipo, descricao: string) => void; // ← NOVA
  onSetOrderBlocked: (blocked: boolean) => Promise<boolean>;
  isOrderBlockUpdating: boolean;
}

// 1. Tabela de conversão de pagamentos
const MAPA_PAGAMENTOS: Record<string, string> = {
  "01": "Dinheiro",
  "03": "Cartão de crédito",
  "04": "Cartão de débito",
  "10": "Vale Refeição / Alimentação",
  "17": "PIX",
  "42": "Cartão de crédito online",
  "43": "iFood pago",
  "47": "Fiado",
  "48": "Ticket Online",
  "50": "99Food pago",
  "99": "Outras"
};

// 2. Função que faz a tradução do código de pagamento (estava faltando)
function traduzirPagamento(codigo?: string): string {
  if (!codigo) return "—";
  return MAPA_PAGAMENTOS[codigo] || "Outras";
}

export default function ContextPanel({
  activeChat,
  pendenciasDoChat,
  isLogisticsOpen,
  setIsLogisticsOpen,
  onCloseActiveChat,
  onOpenHistory,
  onOpenFicha,
  pedidoDetalhe,
  onTogglePedido,
  onAddPendencia,
  onSetOrderBlocked,
  isOrderBlockUpdating,
}: ContextPanelProps) {
  
  const isPedidoExpanded = pedidoDetalhe && (pedidoDetalhe.id === activeChat.pedidoHoje?.id || pedidoDetalhe.order_id === activeChat.pedidoHoje?.id);
  const janela = calcularJanela24h(activeChat.lastIncomingAt);
  const pixStatus = String(
    activeChat.pedidoHoje?.pixStatus ||
    pedidoDetalhe?.pix_status ||
    (activeChat.pedidoHoje?.pixConfirmado ? "RECEIVED" : "PENDING")
  ).toUpperCase();
  const pixTag =
    pixStatus === "REFUNDED"
      ? { classe: "tag-danger", texto: "↩ PIX estornado" }
      : pixStatus === "PARTIALLY_REFUNDED"
        ? { classe: "tag-danger", texto: "↩ Estorno parcial" }
        : pixStatus === "REFUND_IN_PROGRESS"
          ? { classe: "tag-alerta", texto: "↻ Estorno em andamento" }
          : activeChat.pedidoHoje?.pixConfirmado
            ? { classe: "tag-transit", texto: "✓ PIX pago" }
            : { classe: "tag-alerta", texto: "Aguardando PIX" };

  const pedidoDentroDe48h = (() => {
    const p = activeChat.pedidoHoje;
    if (!p) return false;
    if (!p.dataVenda) return true; // fichas antigas, sem o campo ainda
    const feitoEm = new Date(p.dataVenda.replace(" ", "T")).getTime();
    return Number.isNaN(feitoEm) || Date.now() - feitoEm < 48 * 60 * 60 * 1000;
  })();

  // ↓ NOVO: estado do mini-form de pendência
  const [showPendenciaForm, setShowPendenciaForm] = useState(false);
  const [tipoPendencia, setTipoPendencia] = useState<PendenciaTipo>("estorno");
  const [descricaoPendencia, setDescricaoPendencia] = useState("");
  const [showBlockConfirmation, setShowBlockConfirmation] = useState(false);

  useEffect(() => {
    setShowBlockConfirmation(false);
  }, [activeChat.id]);

  const handleOrderAccessChange = async (blocked: boolean) => {
    const changed = await onSetOrderBlocked(blocked);
    if (changed) setShowBlockConfirmation(false);
  };

  const handleSubmitPendencia = (e: FormEvent) => {
    e.preventDefault();
    if (!descricaoPendencia.trim()) return;
    onAddPendencia(activeChat.id, tipoPendencia, descricaoPendencia.trim());
    setDescricaoPendencia("");
    setShowPendenciaForm(false);
  };

  return (
    
    <div className="chat-context-panel">
      <div className="context-panel-label">
        <MdPersonOutline size={15} />
        <span>Detalhes do cliente</span>
      </div>
      <div className="context-client-header">
        <Avatar name={activeChat.clientName} size={48} />
        <div className="context-client-info">
          <h3>{activeChat.clientName}</h3>
          <span>{activeChat.phone}</span>
        </div>
        <div className="context-window-status">
          <span className={`context-status-dot ${janela ? "open" : "closed"}`} />
          <div>
            <strong>{janela ? "Atendimento aberto" : "Atendimento fechado"}</strong>
            <span>{janela ? `${janela} restantes` : "Requer mensagem aprovada"}</span>
          </div>
        </div>
      </div>

      <div className="context-body">

        <div className={`context-order-access${activeChat.pedidosBloqueados ? " blocked" : ""}`}>
          <div className="context-order-access-main">
            <span className="context-order-access-icon" aria-hidden="true">
              {activeChat.pedidosBloqueados ? <MdBlock size={17} /> : <MdLockOpen size={17} />}
            </span>
            <div>
              <strong>
                {activeChat.pedidosBloqueados ? "Pedidos bloqueados" : "Pedidos liberados"}
              </strong>
              <span>
                {activeChat.pedidosBloqueados
                  ? "O cliente não consegue finalizar novos pedidos."
                  : "O cliente pode comprar normalmente pelo aplicativo."}
              </span>
            </div>
          </div>

          {showBlockConfirmation ? (
            <div className="context-order-block-confirm">
              <p>Confirmar o bloqueio de novos pedidos deste cliente?</p>
              <div>
                <button
                  type="button"
                  onClick={() => setShowBlockConfirmation(false)}
                  disabled={isOrderBlockUpdating}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void handleOrderAccessChange(true)}
                  disabled={isOrderBlockUpdating}
                >
                  {isOrderBlockUpdating ? "Bloqueando…" : "Confirmar bloqueio"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={`context-order-access-action${activeChat.pedidosBloqueados ? " release" : ""}`}
              onClick={() => {
                if (activeChat.pedidosBloqueados) {
                  void handleOrderAccessChange(false);
                } else {
                  setShowBlockConfirmation(true);
                }
              }}
              disabled={isOrderBlockUpdating}
            >
              {isOrderBlockUpdating
                ? "Salvando…"
                : activeChat.pedidosBloqueados
                  ? "Liberar pedidos"
                  : "Bloquear pedidos"}
            </button>
          )}
        </div>

        {pedidoDentroDe48h && activeChat.pedidoHoje && (
          <div className="order-card">
            <button
              type="button"
              className={`order-card-summary ${isPedidoExpanded ? "expanded" : ""}`}
              onClick={() => onTogglePedido(activeChat.pedidoHoje!.id)}
            >
              <span className="order-card-dot" />
              <div className="order-card-main">
                <div className="order-card-toprow">
                  <span className="order-card-eyebrow">Pedido de hoje · #{activeChat.pedidoHoje.id}</span>
                  <span className="order-status-pill">{activeChat.pedidoHoje.status}</span>
                </div>
                <div className="order-card-bottomrow">
                  <span className="order-card-total">{activeChat.pedidoHoje.total}</span>
                  {activeChat.pedidoHoje.ehPix ? (
                    <span className={`order-card-tag ${pixTag.classe}`}>
                      {pixTag.texto}
                    </span>
                  ) : pedidoDetalhe?.motoboy_nome ? (
                    <span className="order-card-tag tag-transit">🛵 {pedidoDetalhe.motoboy_nome}</span>
                  ) : pedidoDetalhe?.atendente ? (
                    <span className="order-card-tag">Atendido por {pedidoDetalhe.atendente}</span>
                  ) : null}
                </div>
              </div>
              <span className="order-card-chevron">
                {isPedidoExpanded ? <MdKeyboardArrowDown size={20} /> : <MdKeyboardArrowRight size={20} />}
              </span>
            </button>

            {isPedidoExpanded && (
              <div className="order-card-details fade-in">
                <dl className="order-detail-list">
                  <div className="order-detail-line">
                    <dt>Feito em</dt>
                    <dd>{pedidoDetalhe?.data_venda || "—"}</dd>
                  </div>
                  <div className="order-detail-line">
                    <dt>Atendente</dt>
                    <dd>{pedidoDetalhe?.atendente || "—"}</dd>
                  </div>
                  <div className="order-detail-line">
                    <dt>Agendamento</dt>
                    <dd className={pedidoDetalhe?.agendamento ? "highlight" : ""}>
                      {pedidoDetalhe?.agendamento || "Para agora"}
                    </dd>
                  </div>
                  <div className="order-detail-line">
                    <dt>Tipo</dt>
                    <dd>{pedidoDetalhe?.cep_destinatario ? "🛵 Delivery" : "📦 Retirada"}</dd>
                  </div>
                  <div className="order-detail-line">
                    <dt>Pagamento</dt>
                    <dd>{traduzirPagamento(pedidoDetalhe?.forma_pagamento?.[0])}</dd>
                  </div>
                </dl>

                {pedidoDetalhe?.cep_destinatario && (
                  <div className="order-address-card">
                    <div className="order-address-header">
                      <MdLocationOn size={14} />
                      <span>Endereço de entrega</span>
                    </div>
                    <p className="order-address-text">
                      {pedidoDetalhe.logradouro_destinatario}, {pedidoDetalhe.numero_destinatario}
                      {pedidoDetalhe.complemento_destinatario && ` - Comp: ${pedidoDetalhe.complemento_destinatario}`}
                      <br />
                      Bairro: {pedidoDetalhe.bairro_destinatario}
                    </p>
                    {(pedidoDetalhe?.motoboy_nome || pedidoDetalhe?.data_saida) && (
                      <div className="order-transit-strip">
                        🛵 {pedidoDetalhe.motoboy_nome ? `Com ${pedidoDetalhe.motoboy_nome}` : "A caminho"}
                        {pedidoDetalhe.data_saida && ` · saiu ${pedidoDetalhe.data_saida}`}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="context-section">
          <div className="context-section-header">
            <span className="context-section-title">
              <MdWarningAmber size={15} />
              Pendências
              {pendenciasDoChat.length > 0 && (
                <span className="context-count-badge">{pendenciasDoChat.length}</span>
              )}
            </span>
            <div className="context-section-header-actions">
              {pendenciasDoChat.length > 0 && (
                <button className="alert-link" onClick={onCloseActiveChat}>Ver todas</button>
              )}
              <button
                type="button"
                className="context-add-btn"
                onClick={() => setShowPendenciaForm(v => !v)}
                title="Nova pendência para este cliente"
              >
                <MdAdd size={16} />
              </button>
            </div>
          </div>

          {showPendenciaForm && (
            <form className="pendencia-form context-pendencia-form" onSubmit={handleSubmitPendencia}>
              <div className="pendencia-tipo-grid">
                {TIPOS_PENDENCIA.map(t => (
                  <button
                    key={t.tipo}
                    type="button"
                    className={`tipo-chip ${tipoPendencia === t.tipo ? "active" : ""}`}
                    onClick={() => setTipoPendencia(t.tipo)}
                  >
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>
              <input
                className="pendencia-input"
                placeholder="Descreva a pendência…"
                value={descricaoPendencia}
                onChange={e => setDescricaoPendencia(e.target.value)}
                autoFocus
              />
              <div className="pendencia-form-actions">
                <button type="button" className="pf-cancel" onClick={() => setShowPendenciaForm(false)}>
                  Cancelar
                </button>
                <button type="submit" className="pf-save" disabled={!descricaoPendencia.trim()}>
                  Salvar
                </button>
              </div>
            </form>
          )}

          {pendenciasDoChat.length === 0 && !showPendenciaForm && (
            <p className="context-empty-hint">Nenhuma pendência aberta para este cliente.</p>
          )}
        </div>

        <div className="context-section">
          <span className="context-section-title"><MdTrendingUp size={15} />Resumo do cliente</span>
          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">Pedidos</span>
              <p className="stat-value">{activeChat.totalOrders}</p>
            </div>
            <div className="stat-card">
              <span className="stat-label">LTV Total</span>
              <p className="stat-value green">{activeChat.ltv}</p>
            </div>
          </div>
        </div>

        <div className="context-section">
          <div className="context-section-header collapsible-header" onClick={() => setIsLogisticsOpen(!isLogisticsOpen)}>
            <span className="context-section-title">Locais de Entrega</span>
            {isLogisticsOpen ? <MdKeyboardArrowDown size={18} /> : <MdKeyboardArrowRight size={18} />}
          </div>
          {isLogisticsOpen && (
            <div className="collapsible-content">
              {activeChat.enderecos.map((end, idx) => (
                <div key={idx} className="logistics-item">
                  <MdLocationOn size={16} className={end.isRecorrente ? "location-primary" : "location-muted"} />
                  <div>
                    <span className="bairro-text">
                      {end.bairro}
                      {end.isRecorrente && <span className="badge-principal">Principal</span>}
                    </span>
                    <span className="bairro-sub">{end.detalhe}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      <div className="context-actions">
        <button className="ctx-btn outline" onClick={onOpenHistory}>
          <MdHistory size={16} /> Calendário
        </button>
        <button className="ctx-btn primary" onClick={onOpenFicha}>
          <MdAssignment size={16} /> Ficha Completa
        </button>
      </div>
    </div>
  );
}
