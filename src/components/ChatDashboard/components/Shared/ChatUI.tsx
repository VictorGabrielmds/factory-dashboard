// src/components/Shared/ChatUI.tsx
import { useState } from "react";
import { MdDoneAll, MdWarningAmber, MdDone, MdAccessTime } from "react-icons/md";
import { getAvatarColor, getInitials, getDiceBearUrl } from "../../../..//utils/chatHelpers";

// ─── AVATAR ───
export function Avatar({ name, size = 44, style = {} }: { name: string; size?: number; style?: React.CSSProperties }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", backgroundColor: getAvatarColor(name), display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 500, fontSize: size * 0.33, color: "#fff", flexShrink: 0, ...style }}>
        {getInitials(name)}
      </div>
    );
  }
  return (
    <img
      src={getDiceBearUrl(name, size)}
      width={size} height={size}
      alt={name}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        borderRadius: "50%",
        flexShrink: 0,
        display: "block",
        backgroundColor: getAvatarColor(name), // evita flash branco com internet lenta
        userSelect: "none",
        WebkitUserSelect: "none",
        ...style,
      }}
    />
  );
}

// ─── STATUS DA MENSAGEM (Vistos) ───
export function MessageStatus({ status, noMargin = false, reason }: { status?: string; noMargin?: boolean; reason?: string }) {
  if (!status) return null;
  const margin = noMargin ? 0 : 3;
  if (status === "pending") return <MdAccessTime size={13} style={{ color: "#9ca3af", marginLeft: margin, flexShrink: 0 }} title="Enviando…" />;
  if (status === "read") return <MdDoneAll size={14} style={{ color: "#22c55e", marginLeft: margin, flexShrink: 0 }} title="Lida" />;
  if (status === "delivered") return <MdDoneAll size={14} style={{ color: "#9ca3af", marginLeft: margin, flexShrink: 0 }} title="Entregue" />;
  if (status === "failed") return <MdWarningAmber size={13} style={{ color: "#ef4444", marginLeft: margin, flexShrink: 0 }} title={reason ? `Falha no envio: ${reason}` : "Falha no envio"} />;
  return <MdDone size={14} style={{ color: "#9ca3af", marginLeft: margin, flexShrink: 0 }} title="Enviada" />;
}

// ─── MOTIVO DA FALHA (texto sutil abaixo da bolha, só quando há um motivo conhecido) ───
export function FailureReason({ erro }: { erro?: string }) {
  if (!erro) return null;
  return <span className="bubble-failure-reason">{erro}</span>;
}

// ─── INDICADOR DE DIGITAÇÃO ───
export function TypingIndicator() {
  return (
    <div className="msg-row incoming">
      <div className="bubble typing-bubble">
        <div className="typing-dots"><span /><span /><span /></div>
      </div>
    </div>
  );
}