import { useState, useEffect } from "react";
import { MdEdit, MdDelete, MdCheckCircle } from "react-icons/md";
import ModalBase from "../../../ModalBase/ModalBase";
import type { FrasePredefinida } from "../../../../types/chat.types";

interface ModalFrasesProps {
  isOpen: boolean;
  frases: FrasePredefinida[];
  onClose: () => void;
  onSave: (frases: FrasePredefinida[]) => void;
}

export default function ModalFrases({ isOpen, frases, onClose, onSave }: ModalFrasesProps) {
  const [lista, setLista] = useState<FrasePredefinida[]>(frases);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [form, setForm] = useState({ shortcut: "", text: "" });

  useEffect(() => {
    setLista(frases);
  }, [frases]);

  const abrirEdicao = (idx: number) => {
    setEditIndex(idx);
    setForm({ shortcut: lista[idx].shortcut, text: lista[idx].text });
  };

  const salvarEdicao = () => {
    if (!form.shortcut.trim() || !form.text.trim()) return;
    const shortcut = form.shortcut.startsWith("/") ? form.shortcut : `/${form.shortcut}`;
    const nova = [...lista];
    if (editIndex === null) nova.push({ shortcut, text: form.text.trim() });
    else nova[editIndex] = { shortcut, text: form.text.trim() };
    setLista(nova);
    setEditIndex(null);
    setForm({ shortcut: "", text: "" });
  };

  const remover = (idx: number) => {
    setLista(prev => prev.filter((_, i) => i !== idx));

    // Sem isto, remover uma frase ANTES da que está sendo editada deslocava os
    // índices e o "Salvar edição" seguinte sobrescrevia a frase errada.
    if (editIndex !== null) {
      if (idx === editIndex) {
        setEditIndex(null);
        setForm({ shortcut: "", text: "" });
      } else if (idx < editIndex) {
        setEditIndex(editIndex - 1);
      }
    }
  };

  return (
    <ModalBase isOpen={isOpen} onClose={onClose} title="Frases predefinidas">
      <div className="modal-frases-body">
        <div className="frases-list">
          {lista.map((f, idx) => (
            <div key={idx} className="frase-item">
              <div className="frase-info">
                <span className="frase-shortcut">{f.shortcut}</span>
                <p className="frase-text">{f.text}</p>
              </div>
              <div className="frase-actions">
                <button onClick={() => abrirEdicao(idx)} title="Editar"><MdEdit size={16} /></button>
                <button onClick={() => remover(idx)} title="Remover" className="btn-danger"><MdDelete size={16} /></button>
              </div>
            </div>
          ))}
        </div>
        <div className="frase-form">
          <h4>{editIndex !== null ? "Editar frase" : "Nova frase"}</h4>
          <input
            className="pendencia-input"
            placeholder="Atalho (ex: /prazo)"
            value={form.shortcut}
            onChange={e => setForm(f => ({ ...f, shortcut: e.target.value }))}
          />
          <textarea
            className="pendencia-input"
            placeholder="Texto da resposta"
            rows={3}
            value={form.text}
            onChange={e => setForm(f => ({ ...f, text: e.target.value }))}
          />
          <div className="pendencia-form-actions">
            {editIndex !== null && (
              <button className="pf-cancel" onClick={() => { setEditIndex(null); setForm({ shortcut: "", text: "" }); }}>
                Cancelar
              </button>
            )}
            <button className="pf-save" onClick={salvarEdicao} disabled={!form.shortcut.trim() || !form.text.trim()}>
              {editIndex !== null ? "Salvar edição" : "Adicionar"}
            </button>
          </div>
        </div>
        <div className="finalizar-actions" style={{ marginTop: 12 }}>
          <button className="pf-cancel" onClick={onClose}>Fechar</button>
          <button className="pf-save" onClick={() => { onSave(lista); onClose(); }}>
            <MdCheckCircle size={16} /> Salvar todas
          </button>
        </div>
      </div>
    </ModalBase>
  );
}