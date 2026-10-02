// src/components/Sidebar/ChatSidebar.tsx
import { memo, useState } from "react";
import type { RefObject } from "react";
import { 
  MdPersonAdd, MdBolt, MdLabel,
  MdSearch, MdClose, MdPushPin, 
  MdCheckCircle, MdPendingActions 
} from "react-icons/md";
import type { Conversa, Mensagem } from "../../../../types/chat.types";
import { calcularJanela24h, formatarHoraOuData } from "../../../../utils/chatHelpers";
import { Avatar, MessageStatus } from "../Shared/ChatUI";

interface ChatSidebarProps {
  conversas: Conversa[];
  conversasOrdenadas: Conversa[];
  activeChatId: string | null;
  searchQuery: string;
  setSearchQuery: (val: string) => void;
  sidebarSearchRef: RefObject<HTMLInputElement | null>; // <-- Adicione o " | null" aqui
  totalPendenciasAbertas: number;
  searchResults: { 
    contatos: Conversa[]; 
    mensagens: { chatId: string; clientName: string; msg: Mensagem }[] 
  };
  pedidoSearchResults: {
    orderId: string;
    nome: string;
    telefone: string;
    status: number;
    total: string;
    bairro: string;
    dataVenda: string
  }[];
  contatoSearchResults: {
    id: string;
    clientName: string;
    phone: string;
  }[];
  onSelectChat: (id: string) => void;
  onOpenIniciarConversa: () => void;
  onOpenFrases: () => void;
  onOpenTags: () => void;
  onContextMenu: (e: React.MouseEvent, chatId: string) => void;
  onJumpToMessage: (chatId: string, msgId: string) => void;
  onOpenPendencias: () => void;
  abaAtiva: "todas" | "naoLidas";
  onChangeAba: (aba: "todas" | "naoLidas") => void;
}

// memo: a sidebar não depende de nada que mude a cada tecla digitada no
// campo de mensagem — sem isso, ela reconciliava (e recalculava toda a
// lista de conversas) a cada keystroke, mesmo sem nenhuma conversa nova.
function ChatSidebar({
  conversas,
  conversasOrdenadas,
  activeChatId,
  searchQuery,
  setSearchQuery,
  sidebarSearchRef,
  totalPendenciasAbertas,
  searchResults,
  pedidoSearchResults,
  contatoSearchResults,
  onSelectChat,
  onOpenIniciarConversa,
  onOpenFrases,
  onOpenTags,
  onContextMenu,
  onJumpToMessage,
  onOpenPendencias,
  abaAtiva,
  onChangeAba,
}: ChatSidebarProps) {
  const [hoveredPreviewId, setHoveredPreviewId] = useState<string | null>(null);
  const unreadConversationsCount = conversasOrdenadas.filter(c => c.unreadCount > 0).length;

  return (
    <div className="chat-sidebar">
      <div className="sidebar-header">
        <div className="sidebar-heading">
          <span className="sidebar-eyebrow">Atendimento</span>
          <h2 className="sidebar-title">Conversas</h2>
        </div>
        <div className="sidebar-header-actions">
          <button
            type="button"
            className="new-chat-btn"
            title="Iniciar nova conversa"
            aria-label="Iniciar nova conversa"
            onClick={onOpenIniciarConversa}
          >
            <MdPersonAdd size={17} />
            <span>Nova</span>
          </button>
          <button type="button" className="header-icon-btn" aria-label="Gerenciar frases rápidas" title="Gerenciar frases rápidas" onClick={onOpenFrases}>
            <MdBolt size={18} />
          </button>
          <button type="button" className="header-icon-btn" aria-label="Gerenciar etiquetas" title="Gerenciar etiquetas" onClick={onOpenTags}>
            <MdLabel size={18} />
          </button>
        </div>
      </div>

      <div className="sidebar-search-wrap">
        <MdSearch size={16} className="sidebar-search-icon" />
        <input 
          ref={sidebarSearchRef} 
          type="text" 
          className="sidebar-search-input" 
          placeholder="Buscar clientes, pedidos ou mensagens…" 
          value={searchQuery} 
          onChange={(e) => setSearchQuery(e.target.value)} 
        />
        {searchQuery && <button className="sidebar-search-clear" onClick={() => setSearchQuery("")}><MdClose size={14} /></button>}
      </div>

      {!searchQuery.trim() && (
        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab ${abaAtiva === "todas" ? "active" : ""}`}
            onClick={() => onChangeAba("todas")}
          >
            <span>Todas</span>
          </button>
          <button
            className={`sidebar-tab ${abaAtiva === "naoLidas" ? "active" : ""}`}
            onClick={() => onChangeAba("naoLidas")}
          >
            <span>Não lidas</span>
            {unreadConversationsCount > 0 && (
              <span className="sidebar-tab-count">{unreadConversationsCount}</span>
            )}
          </button>
        </div>
      )}

      <div className="chat-list">
        {searchQuery.trim().length > 0 ? (
          <>
            {searchResults.contatos.length > 0 && (
              <>
                <div className="search-group-label">Contatos</div>
                {searchResults.contatos.map(c => (
                  <button key={c.id} className="search-result-item" onClick={() => onSelectChat(c.id)}>
                    <Avatar name={c.clientName} size={36} />
                    <span className="sr-client">{c.clientName}</span>
                  </button>
                ))}
              </>
            )}
            {searchResults.mensagens.length > 0 && (
              <>
                <div className="search-group-label">Mensagens</div>
                {searchResults.mensagens.map(res => (
                  <button key={res.msg.id} className="search-result-item" onClick={() => onJumpToMessage(res.chatId, res.msg.id)}>
                    <Avatar name={res.clientName} size={36} />
                    <div className="sr-info">
                      <span className="sr-client">{res.clientName}</span>
                      <span className="sr-text">{res.msg.text}</span>
                    </div>
                  </button>
                ))}
              </>
            )}
            {pedidoSearchResults.length > 0 && (() => {
              const localChatIds = new Set(searchResults.contatos.map(c => c.id));
              const extras = pedidoSearchResults.filter(r => {
                if (localChatIds.has(r.telefone)) return false;
                const semNove = r.telefone.startsWith('55') && r.telefone.length === 13 ? r.telefone.slice(0, 4) + r.telefone.slice(5) : null;
                const comNove = r.telefone.startsWith('55') && r.telefone.length === 12 ? r.telefone.slice(0, 4) + '9' + r.telefone.slice(4) : null;
                if (semNove && localChatIds.has(semNove)) return false;
                if (comNove && localChatIds.has(comNove)) return false;
                return true;
              });
              if (extras.length === 0) return null;
              return (
                <>
                  <div className="search-group-label">Pedidos</div>
                  {extras.map(r => {
                    const conversaLocal = conversas.find(c => {
                      if (c.id === r.telefone || c.phone === r.telefone) return true;
                      const semNove = r.telefone.startsWith('55') && r.telefone.length === 13 ? r.telefone.slice(0, 4) + r.telefone.slice(5) : null;
                      const comNove = r.telefone.startsWith('55') && r.telefone.length === 12 ? r.telefone.slice(0, 4) + '9' + r.telefone.slice(4) : null;
                      return (semNove && (c.id === semNove || c.phone === semNove)) || (comNove && (c.id === comNove || c.phone === comNove));
                    });
                    return (
                      <button key={r.orderId} className="search-result-item" onClick={() => onSelectChat(conversaLocal ? conversaLocal.id : r.telefone)}>
                        <Avatar name={r.nome} size={36} />
                        <div className="sr-info">
                          <span className="sr-client">{r.nome}</span>
                          <span className="sr-text">Pedido #{r.orderId} · {r.bairro || r.dataVenda}</span>
                        </div>
                      </button>
                    );
                  })}
                </>
              );
            })()}
            {contatoSearchResults.length > 0 && (() => {
              const localChatIds = new Set(searchResults.contatos.map(c => c.id));
              const extras = contatoSearchResults.filter(r => !localChatIds.has(r.id));
              if (extras.length === 0) return null;
              return (
                <>
                  <div className="search-group-label">Contatos (histórico)</div>
                  {extras.map(r => (
                    <button key={r.id} className="search-result-item" onClick={() => onSelectChat(r.id)}>
                      <Avatar name={r.clientName} size={36} />
                      <span className="sr-client">{r.clientName}</span>
                    </button>
                  ))}
                </>
              );
            })()}
            {searchResults.contatos.length === 0 && searchResults.mensagens.length === 0 && pedidoSearchResults.length === 0 && contatoSearchResults.length === 0 && (
              <div className="search-empty">Nenhum resultado para "<strong>{searchQuery}</strong>"</div>
            )}
          </>
        ) : (
          <>
            {(abaAtiva === "naoLidas"
              ? conversasOrdenadas.filter(c => c.unreadCount > 0)
              : conversasOrdenadas
            ).map(c => {
              // Badge de pendência individual precisaria da lista `pendencias` nas props; por ora
              // o total fica só no footer (totalPendenciasAbertas).
              const janelaAberta = !!calcularJanela24h(c.lastIncomingAt);
              const agora = new Date().getTime();

              // Aceita Timestamp do Firestore (.toMillis), objeto serializado
              // ({seconds}/{_seconds}) ou string/number de data — cobre qualquer
              // formato que o campo lastOrderAt possa assumir vindo do hook/API.
              const getMillis = (v: unknown): number => {
                if (!v) return 0;
                if (typeof v === "object" && v !== null && "toMillis" in v && typeof (v as { toMillis: () => number }).toMillis === "function") {
                  return (v as { toMillis: () => number }).toMillis();
                }
                if (typeof v === "object" && v !== null && ("seconds" in v || "_seconds" in v)) {
                  const secs = (v as { seconds?: number; _seconds?: number }).seconds ?? (v as { _seconds?: number })._seconds ?? 0;
                  return secs * 1000;
                }
                const parsed = new Date(v as string | number).getTime();
                return Number.isNaN(parsed) ? 0 : parsed;
              };

              const orderTime = getMillis(c.lastOrderAt);
              const isRecentOrder = !!c.lastOrderType && orderTime > 0 && (agora - orderTime) < 36 * 60 * 60 * 1000;
              const orderIcon = c.lastOrderType === "DELIVERY" ? "🛵" : "📦";
              const orderLabel = c.lastOrderType === "DELIVERY" ? "Delivery" : "Retirada";

              // Quem mandou a última mensagem: "outgoing" = empresa, qualquer outro valor = cliente.
              const ultimaFoiEmpresa = c.lastMessageSender === "outgoing";
              const aguardandoResposta = !ultimaFoiEmpresa; // cliente falou por último

              return (
                <button 
                  key={c.id} 
                  className={`chat-item ${c.id === activeChatId ? "active" : ""} ${c.pinned ? "pinned" : ""} ${aguardandoResposta ? "aguardando-resposta" : ""}`} 
                  onClick={() => onSelectChat(c.id)} 
                  onContextMenu={(e) => onContextMenu(e, c.id)}
                >
                  <div className="avatar-wrapper">
                    <Avatar name={c.clientName} size={44} />
                    {c.isOnline && <span className="status-dot" />}
                    {janelaAberta && <span className="janela-dot" title="Janela de 24h aberta" />}
                    <span
                      className={`last-sender-dot ${ultimaFoiEmpresa ? "empresa" : "cliente"}`}
                      title={ultimaFoiEmpresa ? "Você enviou a última mensagem" : "Cliente enviou a última mensagem"}
                    />
                  </div>
                  <div
                    className="chat-info"
                    onMouseEnter={() => setHoveredPreviewId(c.id)}
                    onMouseLeave={() => setHoveredPreviewId(prev => (prev === c.id ? null : prev))}
                  >
                    <div className="chat-info-top">
                      <h4>
                        {c.pinned && <MdPushPin size={11} className="pin-icon" />} 
                        {c.clientName}
                      </h4>
                      <div className="chat-info-top-right">
                        {c.lastMessageIsAlteracao && (
                          <span className="sidebar-alteracao-badge" title="Solicitação de alteração pendente">!</span>
                        )}
                        {c.lastIncomingAt && <span className="chat-time">{formatarHoraOuData(c.lastIncomingAt)}</span>}
                        {c.unreadCount > 0 && <span className="unread-badge">{c.unreadCount}</span>}
                      </div>
                    </div>
                    <div className="chat-meta">
                      <p className="chat-last-msg">
  <span className={`sender-indicator ${ultimaFoiEmpresa ? "you" : "client"}`}>
    {ultimaFoiEmpresa ? (
      <MessageStatus status={c.lastMessageStatus} noMargin />
    ) : (
      "↩"
    )}
  </span>
  <span className="chat-last-msg-text">
    {ultimaFoiEmpresa && <strong className="sender-prefix"> </strong>}
    {c.lastMessage}
  </span>
</p>
                      {aguardandoResposta && (
                        <span className="reply-pending-badge" title="Aguardando resposta">
                          Aguardando
                        </span>
                      )}
                      {isRecentOrder && (
                        <span className={`order-chip ${c.lastOrderType === "DELIVERY" ? "delivery" : "pickup"}`} title={`Pedido recente: ${orderLabel}`}>
                          {orderIcon}
                        </span>
                      )}
                    </div>
                    {hoveredPreviewId === c.id && c.lastMessage && (
                      <div className="chat-item-preview">{c.lastMessage}</div>
                    )}
                  </div>
                </button>
              );
            })}
            {abaAtiva === "naoLidas" && conversasOrdenadas.filter(c => c.unreadCount > 0).length === 0 && (
              <div className="search-empty" style={{ padding: "32px 16px", textAlign: "center" }}>
                <span style={{ fontSize: "1.5rem" }}>✅</span>
                <p style={{ marginTop: 8, color: "var(--sys-color-text-faint, #8696a0)", fontSize: "0.85rem" }}>Nenhuma mensagem não lida</p>
              </div>
            )}
            {conversas.some(c => c.finalizado) && (
              <>
              
                <div className="search-group-label" style={{ marginTop: 8 }}>Finalizados</div>
                {conversas.filter(c => c.finalizado).map(c => (
                  <button key={c.id} className={`chat-item finalizado ${c.id === activeChatId ? "active" : ""}`} onClick={() => onSelectChat(c.id)}>
                    <div className="avatar-wrapper">
                      <Avatar name={c.clientName} size={44} style={{ opacity: 0.45 }} />
                    </div>
                    <div className="chat-info">
                      <div className="chat-info-top">
                        <h4>{c.clientName}</h4>
                        <MdCheckCircle size={13} style={{ color: "#22c55e", flexShrink: 0 }} />
                      </div>
                      <p className="chat-last-msg">{c.lastMessage}</p>
                    </div>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </div>
      <button className={`sidebar-pendencias-footer ${!activeChatId ? "active" : ""}`} onClick={onOpenPendencias}>
        <MdPendingActions size={16} />
        <span>Pendências</span>
        {totalPendenciasAbertas > 0 && (<span className="pendencias-footer-badge">{totalPendenciasAbertas}</span>)}
      </button>
    </div>
  );
}

export default memo(ChatSidebar);
