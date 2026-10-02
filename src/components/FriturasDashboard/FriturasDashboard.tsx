// src/components/FriturasDashboard/FriturasDashboard.tsx
import { useState, useEffect, useMemo } from "react";
import "./FriturasDashboard.css";
import { db, collection, onSnapshot, query, addDoc, updateDoc, deleteDoc, doc } from "../../services/firebase";
import ModalBase from "../ModalBase/ModalBase";
import DatePicker from "react-datepicker";
import { ptBR } from "date-fns/locale";
import "react-datepicker/dist/react-datepicker.css";
import {
  BsClock as Clock,
  BsGeoAlt as GeoAlt,
  BsCheckCircleFill as CheckCircleFill,
  BsPencilFill as PencilFill,
  BsTrash as Trash,
  BsCalendarX as CalendarX,
  BsFire as Fire,
} from "react-icons/bs";
import { useToast } from "../../contexts/ToastContext";
import { dateToISOString } from "../../utils/dateUtils";

interface Fritura {
  id?: string;
  cliente: string;
  dataAlvo: string; // Formato YYYY-MM-DD
  horario: string;
  local: string;
  observacoes: string;
  status: "solicitado" | "pendente" | "concluido";
  origem?: "app_cliente";
  telefoneCliente?: string;
  clienteUid?: string;
}

interface ResumoDia {
  total: number;
  pendentes: number;
  concluidas: number;
}

const parseLocalISO = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
};

const isLocalISO = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = parseLocalISO(value);
  return !Number.isNaN(parsed.getTime()) && dateToISOString(parsed) === value;
};

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export default function FriturasDashboard() {
  const { addToast } = useToast();
  const [frituras, setFrituras] = useState<Fritura[]>([]);
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());
  
  // Modais
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingFrituraId, setEditingFrituraId] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [frituraToDelete, setFrituraToDelete] = useState<string | null>(null);
  
  // Form state
  const [form, setForm] = useState({ cliente: "", horario: "", local: "", observacoes: "" });

  useEffect(() => {
    const q = query(collection(db, "frituras"));
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as Fritura));
      setFrituras(data);
    });
    return () => unsub();
  }, []);

  const dataAlvoFormatada = dateToISOString(selectedDate);

  const resumoPorData = useMemo(() => {
    const resumo = new Map<string, ResumoDia>();

    frituras.forEach((fritura) => {
      if (!isLocalISO(fritura.dataAlvo)) return;

      const atual = resumo.get(fritura.dataAlvo) ?? {
        total: 0,
        pendentes: 0,
        concluidas: 0,
      };

      atual.total += 1;
      if (fritura.status !== "concluido") atual.pendentes += 1;
      if (fritura.status === "concluido") atual.concluidas += 1;
      resumo.set(fritura.dataAlvo, atual);
    });

    return resumo;
  }, [frituras]);

  const friturasDoDia = useMemo(
    () => frituras
      .filter(f => f.dataAlvo === dataAlvoFormatada)
      .sort((a, b) => (a.horario || "").localeCompare(b.horario || "")),
    [dataAlvoFormatada, frituras],
  );
  const pendentesDoDia = friturasDoDia.filter(f => f.status === 'pendente').length;
  const solicitacoesDoDia = friturasDoDia.filter(f => f.status === 'solicitado').length;

  const selecionarData = (date: Date) => {
    setSelectedDate(date);
  };

  const abrirNovoAgendamento = () => {
    setEditingFrituraId(null);
    setForm({ cliente: "", horario: "", local: "", observacoes: "" });
    setIsModalOpen(true);
  };

  const revisarSolicitacao = (fritura: Fritura) => {
    setSelectedDate(parseLocalISO(fritura.dataAlvo));
    setEditingFrituraId(fritura.id ?? null);
    setForm({
      cliente: fritura.cliente,
      horario: fritura.horario || "",
      local: fritura.local || "",
      observacoes: fritura.observacoes || "",
    });
    setIsModalOpen(true);
  };

  const fecharModal = () => {
    setIsModalOpen(false);
    setEditingFrituraId(null);
  };

  const classeDoDia = (date: Date) => {
    const resumo = resumoPorData.get(dateToISOString(date));
    if (!resumo) return "";

    return [
      "frituras-calendar-day--scheduled",
      resumo.pendentes > 0
        ? "frituras-calendar-day--pending"
        : "frituras-calendar-day--completed",
    ].join(" ");
  };

  const conteudoDoDia = (day: number, date?: Date) => {
    const resumo = date ? resumoPorData.get(dateToISOString(date)) : undefined;
    const quantidade = resumo?.total ?? 0;

    return (
      <span
        className="frituras-calendar-day-content"
        aria-label={quantidade > 0
          ? `${day}, ${quantidade} ${quantidade === 1 ? "fritura agendada" : "frituras agendadas"}`
          : String(day)}
      >
        <span>{day}</span>
        {quantidade > 0 && (
          <span className="frituras-calendar-day-count" aria-hidden="true">
            {quantidade > 9 ? "9+" : quantidade}
          </span>
        )}
      </span>
    );
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.cliente || !form.horario || !form.local) {
      addToast("Preencha cliente, horário e local.", "warning");
      return;
    }
    
    try {
      if (editingFrituraId) {
        await updateDoc(doc(db, "frituras", editingFrituraId), {
          ...form,
          dataAlvo: dataAlvoFormatada,
          status: "pendente",
        });
        addToast("Solicitação confirmada e adicionada à agenda!", "success");
      } else {
        await addDoc(collection(db, "frituras"), {
          ...form,
          dataAlvo: dataAlvoFormatada,
          status: "pendente"
        });
        addToast("Fritura agendada com sucesso!", "success");
      }
      fecharModal();
      setForm({ cliente: "", horario: "", local: "", observacoes: "" });
    } catch (err) {
      console.error(err);
      addToast("Erro ao salvar a fritura.", "error");
    }
  };

  const toggleStatus = async (id: string, currentStatus: string) => {
    try {
      const novoStatus = currentStatus === "pendente" ? "concluido" : "pendente";
      await updateDoc(doc(db, "frituras", id), { status: novoStatus });
      if (novoStatus === "concluido") {
        addToast("Fritura marcada como concluída!", "success");
      }
    } catch (err) {
      console.error(err);
      addToast("Erro ao atualizar status.", "error");
    }
  };

  const confirmDelete = (id: string) => {
    setFrituraToDelete(id);
    setIsDeleteModalOpen(true);
  };

  const executeDelete = async () => {
    if (!frituraToDelete) return;
    try {
      await deleteDoc(doc(db, "frituras", frituraToDelete));
      addToast("Fritura cancelada e removida.", "info");
      setIsDeleteModalOpen(false);
      setFrituraToDelete(null);
    } catch (err) {
      console.error(err);
      addToast("Erro ao cancelar fritura.", "error");
    }
  };

  return (
    <div className="frituras-container fade-in">
      <div className="frituras-header">
        {/* O <h2> foi removido daqui para evitar repetição! */}
        <button className="btn btn-primary" onClick={abrirNovoAgendamento}>
          <Fire size={18} /> Agendar Nova Fritura
        </button>
      </div>

      <div className="frituras-layout">
        {/* Sidebar com Calendário e KPI */}
        <div className="frituras-sidebar">
          <div className="frituras-calendar-card">
            <div className="frituras-calendar-heading">
              <span>Calendário</span>
              <small>O número mostra quantas frituras há no dia</small>
            </div>
            <DatePicker
              selected={selectedDate}
              onChange={(date: Date | null) => date && selecionarData(date)}
              dayClassName={classeDoDia}
              renderDayContents={conteudoDoDia}
              locale={ptBR}
              inline
            />
            <div className="frituras-calendar-legend" aria-label="Legenda do calendário">
              <span><i className="is-pending" /> Com pendência</span>
              <span><i className="is-completed" /> Tudo concluído</span>
            </div>
          </div>
          
          <div className="resumo-card">
            <span className="frituras-overline">
              Resumo: {selectedDate.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
            </span>
            <div className="frituras-day-total">
              <h3>
                {friturasDoDia.length}
              </h3>
              <span>
                {friturasDoDia.length === 1 ? "agendamento no dia" : "agendamentos no dia"}
              </span>
            </div>
            {pendentesDoDia > 0 && (
              <p className="frituras-day-pending">
                <Clock size={14} /> {pendentesDoDia} aguardando execução
              </p>
            )}
            {solicitacoesDoDia > 0 && (
              <p className="frituras-day-requested">
                <PencilFill size={13} /> {solicitacoesDoDia} {solicitacoesDoDia === 1 ? "solicitação para revisar" : "solicitações para revisar"}
              </p>
            )}
          </div>
        </div>

        {/* Lista de Frituras */}
        <div className="frituras-list-area">
          <div className="frituras-list-heading">
            <div>
              <span className="frituras-overline">Agenda do dia</span>
              <h3>{capitalize(selectedDate.toLocaleDateString("pt-BR", {
                weekday: "long",
                day: "2-digit",
                month: "long",
              }))}</h3>
            </div>
            <span className="frituras-list-count">
              {friturasDoDia.length} {friturasDoDia.length === 1 ? "fritura" : "frituras"}
            </span>
          </div>
          {friturasDoDia.length === 0 ? (
            <div className="frituras-empty fade-in">
              <div style={{ width: '64px', height: '64px', borderRadius: '50%', backgroundColor: 'var(--sys-color-input-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--sys-color-text-muted)', marginBottom: '8px' }}>
                <CalendarX size={28} />
              </div>
              <p>O calendário está livre.<br/>Nenhuma fritura agendada para <strong>{selectedDate.toLocaleDateString('pt-BR')}</strong>.</p>
            </div>
          ) : (
            friturasDoDia.map(f => (
              <div key={f.id} className={`fritura-card fade-in${f.status === "solicitado" ? " fritura-card-requested" : ""}`}>
                <div className="fritura-card-main">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '4px' }}>
                    <h4 style={{ textDecoration: f.status === 'concluido' ? 'line-through' : 'none', color: f.status === 'concluido' ? 'var(--sys-color-text-muted)' : 'var(--sys-color-text-main)' }}>
                      {f.cliente}
                    </h4>
                    {f.origem === "app_cliente" && (
                      <span className="fritura-origin-badge">Solicitação do app</span>
                    )}
                  </div>
                  
                  <div className="fritura-info">
                    <span><Clock size={16} color="var(--sys-color-primary)"/> {f.horario || "Horário a confirmar"}</span>
                    <span><GeoAlt size={16} color="var(--sys-color-primary)"/> {f.local || "Local a confirmar"}</span>
                    {f.telefoneCliente && <span>WhatsApp: {f.telefoneCliente}</span>}
                  </div>
                  
                  {f.observacoes && (
                    <div className="fritura-obs"><strong>Nota:</strong> {f.observacoes}</div>
                  )}
                </div>

                <div className="fritura-actions">
                  <span className={`badge-status ${f.status === 'concluido' ? 'badge-concluido' : f.status === "solicitado" ? "badge-solicitado" : 'badge-pendente'}`}>
                    {f.status === 'concluido' ? <CheckCircleFill size={12}/> : f.status === "solicitado" ? <PencilFill size={11} /> : <Clock size={12}/>}
                    {f.status === "solicitado" ? "Aguardando confirmação" : f.status}
                  </span>
                  
                  <div className="action-buttons-group">
                    {f.status === "solicitado" ? (
                      <button
                        className="btn-icon-action btn-review"
                        title="Revisar e confirmar solicitação"
                        aria-label={`Revisar solicitação de ${f.cliente}`}
                        onClick={() => revisarSolicitacao(f)}
                      >
                        <PencilFill size={17} />
                      </button>
                    ) : (
                      <button 
                        className="btn-icon-action btn-check" 
                        title={f.status === 'pendente' ? "Marcar como Concluído" : "Desmarcar"}
                        onClick={() => toggleStatus(f.id!, f.status)}
                        style={{ 
                          backgroundColor: f.status === 'concluido' ? 'var(--sys-color-success)' : '', 
                          color: f.status === 'concluido' ? 'white' : '' 
                        }}
                      >
                        <CheckCircleFill size={18} />
                      </button>
                    )}
                    <button className="btn-icon-action btn-trash" title="Cancelar Fritura" onClick={() => confirmDelete(f.id!)}>
                      <Trash size={18} />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ─── MODAL DE AGENDAMENTO ─── */}
      <ModalBase
        isOpen={isModalOpen}
        onClose={fecharModal}
        title={editingFrituraId ? "Revisar solicitação de fritura" : "Agendar Nova Fritura"}
      >
  <form onSubmit={handleSave} className="fritura-form">
    {/* Bloco de Contexto (Somente Leitura) */}
    <div className="form-info-bar">
      <span className="info-label">Data do Evento</span>
      <span className="info-value">{selectedDate.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
    </div>

    {/* Campo Principal */}
    <div className="form-group">
      <label>Nome do Cliente ou Evento</label>
      <input 
        type="text" 
        value={form.cliente} 
        onChange={e => setForm({...form, cliente: e.target.value})} 
        placeholder="Ex: Casamento Silva ou Aniversário Maria" 
        required 
        autoFocus 
      />
    </div>

    {/* Linha de Logística (Grid 1:2) */}
    <div className="form-grid">
      <div className="form-group">
        <label>Horário</label>
        <div className="input-with-icon">
          <Clock size={18} />
          <input 
            type="time" 
            value={form.horario} 
            onChange={e => setForm({...form, horario: e.target.value})} 
            required 
          />
        </div>
      </div>
      <div className="form-group">
        <label>Localização / Endereço</label>
        <div className="input-with-icon">
          <GeoAlt size={18} />
          <input 
            type="text" 
            value={form.local} 
            onChange={e => setForm({...form, local: e.target.value})} 
            placeholder="Ex: Salão de Festas Ed. Roma" 
            required 
          />
        </div>
      </div>
    </div>

    {/* Bloco de Detalhes */}
    <div className="form-group">
      <label>Observações Adicionais <span className="label-optional">(Opcional)</span></label>
      <textarea 
        rows={3} 
        value={form.observacoes} 
        onChange={e => setForm({...form, observacoes: e.target.value})}
        placeholder="Ex: Levar 2 tachos, contato com o porteiro..." 
      />
    </div>

    {/* Ação Principal com Espaçamento */}
    <div className="form-actions">
      <button type="submit" className="btn btn-primary btn-confirm">
        <CheckCircleFill size={18} /> {editingFrituraId ? "Confirmar e adicionar à agenda" : "Confirmar Agendamento"}
      </button>
    </div>
  </form>
</ModalBase>

      {/* ─── MODAL DE EXCLUSÃO (UX PREMIUM) ─── */}
      <ModalBase isOpen={isDeleteModalOpen} onClose={() => setIsDeleteModalOpen(false)} title="Cancelar Fritura">
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <div style={{ width: '56px', height: '56px', borderRadius: '50%', backgroundColor: 'rgba(225, 29, 72, 0.1)', color: 'var(--sys-color-danger)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px auto' }}>
            <Trash size={28} />
          </div>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '1.2rem', color: 'var(--sys-color-text-main)' }}>Tem a certeza?</h3>
          <p style={{ margin: 0, color: 'var(--sys-color-text-muted)', fontSize: '0.95rem' }}>
            Esta ação irá remover o agendamento desta fritura permanentemente do sistema.
          </p>
        </div>
        <div className="modal-buttons" style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
          <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setIsDeleteModalOpen(false)}>
            Voltar
          </button>
          <button type="button" className="btn btn-primary" style={{ flex: 1, backgroundColor: 'var(--sys-color-danger)' }} onClick={executeDelete}>
            Sim, Cancelar Evento
          </button>
        </div>
      </ModalBase>
    </div>
  );
}
