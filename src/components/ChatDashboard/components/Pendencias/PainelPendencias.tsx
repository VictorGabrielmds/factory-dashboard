// src/components/Pendencias/PainelPendencias.tsx
import { useState } from "react";
import {
  MdPendingActions, MdAdd, MdCheckCircle,
  MdRadioButtonUnchecked, MdKeyboardArrowDown, MdKeyboardArrowRight,
  MdOutlineWifiOff
} from "react-icons/md";
import type { Pendencia, Conversa, PendenciaTipo } from "../../../../types/chat.types";
import { getTipoLabel, getTipoIcon, TIPOS_PENDENCIA } from "../../../../utils/chatHelpers";

interface PainelPendenciasProps {
  pendencias: Pendencia[];
  conversas: Conversa[];
  onResolve: (id: string) => void;
  onAdd: (chatId: string, tipo: PendenciaTipo, descricao: string) => void;
  onGoToChat: (chatId: string) => void;
  /** true depois de falhas seguidas ao buscar pendências — polling em cooldown. */
  offline?: boolean;
}

export default function PainelPendencias({ pendencias, conversas, onResolve, onAdd, onGoToChat, offline }: PainelPendenciasProps) {
  const [showForm, setShowForm] = useState(false);
  const [formClienteNome, setFormClienteNome] = useState(conversas[0]?.clientName ?? "");
  const [formClienteId, setFormClienteId] = useState<string | null>(conversas[0]?.id ?? null);
  const [formTipo, setFormTipo] = useState<PendenciaTipo>("estorno");
  const [formDesc, setFormDesc] = useState("");
  const [showResolvidas, setShowResolvidas] = useState(false);
  const [sugestoesAbertas, setSugestoesAbertas] = useState(false);

  // Nomes repetidos são comuns em delivery — por isso o cliente é sempre
  // selecionado pelo id (único), nunca pelo texto digitado, mesmo com autocomplete.
  const sugestoesCliente = formClienteNome.trim()
    ? conversas.filter(c => c.clientName.toLowerCase().includes(formClienteNome.trim().toLowerCase())).slice(0, 6)
    : [];

  const clienteSelecionado = conversas.find(c => c.id === formClienteId) ?? null;

  const abertas   = pendencias.filter(p => !p.resolvida);
  const resolvidas = pendencias.filter(p => p.resolvida);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formDesc.trim() || !clienteSelecionado) return;
    onAdd(clienteSelecionado.id, formTipo, formDesc.trim());
    setFormDesc("");
    setFormClienteNome(conversas[0]?.clientName ?? "");
    setFormClienteId(conversas[0]?.id ?? null);
    setShowForm(false);
  };

  return (
    <div className="pendencias-panel">
      <div className="pendencias-header">
        <div className="pendencias-title-row">
          <MdPendingActions size={18} />
          <h3>Pendências</h3>
          {abertas.length > 0 && <span className="pendencias-count">{abertas.length}</span>}
        </div>
        <button className={`pendencias-add-btn ${showForm ? "active" : ""}`} onClick={() => setShowForm(v => !v)} title="Nova pendência">
          <MdAdd size={18} />
        </button>
      </div>

      {offline && (
        <div className="pendencias-offline-banner">
          <MdOutlineWifiOff size={16} />
          <span>Sem conexão com o servidor de pendências — tentando reconectar…</span>
        </div>
      )}

      {showForm && (
        <form className="pendencia-form" onSubmit={handleSubmit}>
          <div style={{ position: "relative" }}>
            <input
              className="pendencia-input"
              placeholder="Nome do cliente…"
              value={formClienteNome}
              onChange={e => {
                setFormClienteNome(e.target.value);
                setFormClienteId(null); // precisa escolher de novo na lista para confirmar qual "Maria"
                setSugestoesAbertas(true);
              }}
              onFocus={() => setSugestoesAbertas(true)}
              onBlur={() => setTimeout(() => setSugestoesAbertas(false), 150)}
            />
            {sugestoesAbertas && sugestoesCliente.length > 0 && (
              <div className="forward-suggestions">
                {sugestoesCliente.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    className="forward-suggestion-item"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setFormClienteNome(c.clientName);
                      setFormClienteId(c.id);
                      setSugestoesAbertas(false);
                    }}
                  >
                    <div className="forward-suggestion-info">
                      <span className="fs-name">{c.clientName}</span>
                      <span className="fs-phone">{c.phone}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {formClienteNome.trim() && !clienteSelecionado && (
            <span className="pendencia-cliente-warning">Selecione um cliente da lista de sugestões</span>
          )}
          <div className="pendencia-tipo-grid">
            {TIPOS_PENDENCIA.map(t => (
              <button key={t.tipo} type="button" className={`tipo-chip ${formTipo === t.tipo ? "active" : ""}`} onClick={() => setFormTipo(t.tipo)}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <input className="pendencia-input" placeholder="Descreva a pendência…" value={formDesc} onChange={e => setFormDesc(e.target.value)} autoFocus />
          <div className="pendencia-form-actions">
            <button type="button" className="pf-cancel" onClick={() => setShowForm(false)}>Cancelar</button>
            <button type="submit" className="pf-save" disabled={!formDesc.trim() || !clienteSelecionado}>Salvar</button>
          </div>
        </form>
      )}

      <div className="pendencias-list">
        {abertas.length === 0 && !showForm && (
          <div className="pendencias-empty"><MdCheckCircle size={30} /><p>Tudo em dia!</p></div>
        )}
        {abertas.map(p => {
          const conversa = conversas.find(c => c.id === p.chatId);
          return (
            <div key={p.id} className="pendencia-item">
              <button className="pendencia-check" onClick={() => onResolve(p.id)} title="Marcar como resolvida">
                <MdRadioButtonUnchecked size={18} />
              </button>
              <div className="pendencia-body">
                <div className="pendencia-meta">
                  <span className={`pendencia-tipo tipo-${p.tipo}`}>{getTipoIcon(p.tipo)} {getTipoLabel(p.tipo)}</span>
                  <button className="pendencia-client-link" onClick={() => onGoToChat(p.chatId)}>{conversa?.clientName ?? "—"}</button>
                </div>
                <p className="pendencia-desc">{p.descricao}</p>
                <span className="pendencia-time">{p.criadaEm}</span>
              </div>
            </div>
          );
        })}
      </div>

      {resolvidas.length > 0 && (
        <div className="pendencias-resolvidas">
          <button className="resolvidas-toggle" onClick={() => setShowResolvidas(v => !v)}>
            {showResolvidas ? <MdKeyboardArrowDown size={16}/> : <MdKeyboardArrowRight size={16}/>}
            {resolvidas.length} resolvida{resolvidas.length > 1 ? "s" : ""}
          </button>
          {showResolvidas && resolvidas.map(p => {
            const conversa = conversas.find(c => c.id === p.chatId);
            return (
              <div key={p.id} className="pendencia-item resolvida">
                <MdCheckCircle size={18} className="check-done" />
                <div className="pendencia-body">
                  <div className="pendencia-meta">
                    <span className="pendencia-tipo">{getTipoLabel(p.tipo)}</span>
                    <span className="pendencia-client-link muted">{conversa?.clientName ?? "—"}</span>
                  </div>
                  <p className="pendencia-desc">{p.descricao}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}