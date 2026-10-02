import { useState, useEffect } from "react";
import { MdLabel, MdCheckCircle } from "react-icons/md";
import ModalBase from "../../../ModalBase/ModalBase";
import type { Conversa, TagGlobal } from "../../../../types/chat.types";

interface ModalAplicarTagsProps {
  isOpen: boolean;
  conversa: Conversa | null;
  tagsGlobais: TagGlobal[];
  onClose: () => void;
  onSave: (telefone: string, tags: string[]) => void;
}

export default function ModalAplicarTags({ isOpen, conversa, tagsGlobais, onClose, onSave }: ModalAplicarTagsProps) {
  const [selecionadas, setSelecionadas] = useState<string[]>([]);

  useEffect(() => {
    if (conversa) setSelecionadas(conversa.tags || []);
  }, [conversa]);

  const toggle = (label: string) =>
    setSelecionadas(prev => (prev.includes(label) ? prev.filter(t => t !== label) : [...prev, label]));

  return (
    <ModalBase isOpen={isOpen} onClose={onClose} title={`Tags · ${conversa?.clientName}`}>
      <div className="modal-frases-body">
        <div className="tags-grid">
          {tagsGlobais.map((t, idx) => (
            <button
              key={idx}
              className={`tipo-chip ${selecionadas.includes(t.label) ? "active" : ""}`}
              onClick={() => toggle(t.label)}
            >
              <MdLabel size={14} /> {t.label}
            </button>
          ))}
        </div>
        <div className="finalizar-actions" style={{ marginTop: 16 }}>
          <button className="pf-cancel" onClick={onClose}>Cancelar</button>
          <button className="pf-save" onClick={() => { onSave(conversa!.id, selecionadas); onClose(); }}>
            <MdCheckCircle size={16} /> Aplicar
          </button>
        </div>
      </div>
    </ModalBase>
  );
}