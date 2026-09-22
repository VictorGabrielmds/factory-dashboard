import { useState, useEffect } from "react";
import { MdDelete, MdCheckCircle } from "react-icons/md";
import ModalBase from "../../../ModalBase/ModalBase";
import type { TagGlobal } from "../../../../types/chat.types";

interface ModalTagsProps {
  isOpen: boolean;
  tagsGlobais: TagGlobal[];
  onClose: () => void;
  onSave: (tags: TagGlobal[]) => void;
}

const COR_OPTIONS = [
  { value: "vip",    label: "Dourado" },
  { value: "new",    label: "Verde" },
  { value: "danger", label: "Vermelho" },
  { value: "",       label: "Neutro" },
];

export default function ModalTags({ isOpen, tagsGlobais, onClose, onSave }: ModalTagsProps) {
  const [lista, setLista] = useState<TagGlobal[]>(tagsGlobais);
  const [form, setForm] = useState({ label: "", color: "" });

  useEffect(() => {
    setLista(tagsGlobais);
  }, [tagsGlobais]);

  const [erroDuplicada, setErroDuplicada] = useState(false);

  const adicionar = () => {
    const label = form.label.trim();
    if (!label) return;

    // Duas tags com o mesmo nome ficam impossíveis de diferenciar depois,
    // ao aplicar tags num cliente (o toggle não sabe qual das duas é qual).
    const jaExiste = lista.some(t => t.label.toLowerCase() === label.toLowerCase());
    if (jaExiste) {
      setErroDuplicada(true);
      return;
    }

    setErroDuplicada(false);
    setLista(prev => [...prev, { label, color: form.color }]);
    setForm({ label: "", color: "" });
  };

  const remover = (idx: number) => setLista(prev => prev.filter((_, i) => i !== idx));

  return (
    <ModalBase isOpen={isOpen} onClose={onClose} title="Gerenciar tags">
      <div className="modal-frases-body">
        <div className="frases-list">
          {lista.map((t, idx) => (
            <div key={idx} className="frase-item">
              <span className={`tag-badge ${t.color}`}>{t.label}</span>
              <button onClick={() => remover(idx)} className="btn-danger" title="Remover"><MdDelete size={16} /></button>
            </div>
          ))}
        </div>
        <div className="frase-form">
          <h4>Nova tag</h4>
          <input
            className="pendencia-input"
            placeholder="Nome da tag"
            value={form.label}
            onChange={e => { setForm(f => ({ ...f, label: e.target.value })); setErroDuplicada(false); }}
          />
          {erroDuplicada && <span className="pendencia-cliente-warning">Já existe uma tag com esse nome.</span>}
          <select className="pendencia-select" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))}>
            {COR_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <button className="pf-save" onClick={adicionar} disabled={!form.label.trim()}>Adicionar</button>
        </div>
        <div className="finalizar-actions" style={{ marginTop: 12 }}>
          <button className="pf-cancel" onClick={onClose}>Fechar</button>
          <button className="pf-save" onClick={() => { onSave(lista); onClose(); }}>
            <MdCheckCircle size={16} /> Salvar
          </button>
        </div>
      </div>
    </ModalBase>
  );
}