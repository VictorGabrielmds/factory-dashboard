// src/components/Modals/ModalFinalizar.tsx
import { MdWarningAmber, MdCheckCircle } from "react-icons/md";
import ModalBase from "../../../ModalBase/ModalBase"; // Ajuste o caminho se necessário
import type { Pendencia } from "../../../../types/chat.types";
import { getTipoLabel } from "../../../../utils/chatHelpers";

interface ModalFinalizarProps {
  isOpen: boolean;
  clientName: string;
  chatId: string;
  pendenciasAbertas: Pendencia[];
  onClose: () => void;
  onConfirm: () => void;
  onGoToPendencias: () => void;
}

export default function ModalFinalizar({ isOpen, clientName, pendenciasAbertas, onClose, onConfirm, onGoToPendencias }: ModalFinalizarProps) {
  if (!isOpen) return null;
    return (
      <ModalBase isOpen={isOpen} onClose={onClose} title="Finalizar atendimento">
        <div className="modal-finalizar-body">
          {pendenciasAbertas.length > 0 ? (
            <>
              <div className="finalizar-warning">
                <MdWarningAmber size={24} />
                <div>
                  <strong>Atenção: há {pendenciasAbertas.length} pendência{pendenciasAbertas.length > 1 ? "s" : ""} em aberto</strong> para {clientName}.
                  Deseja resolver antes de finalizar?
                </div>
              </div>
              <ul className="finalizar-pendencias-list">
                {pendenciasAbertas.map(p => (
                  <li key={p.id}><span className={`pendencia-tipo tipo-${p.tipo}`}>{getTipoLabel(p.tipo)}</span> {p.descricao}</li>
                ))}
              </ul>
              <div className="finalizar-actions">
                <button className="pf-cancel" onClick={onGoToPendencias}>Ver pendências</button>
                <button className="pf-save danger" onClick={onConfirm}>Finalizar mesmo assim</button>
              </div>
            </>
          ) : (
            <>
              <p className="finalizar-ok-msg">Nenhuma pendência em aberto para <strong>{clientName}</strong>. Deseja marcar como concluído?</p>
              <div className="finalizar-actions">
                <button className="pf-cancel" onClick={onClose}>Cancelar</button>
                <button className="pf-save" onClick={onConfirm}><MdCheckCircle size={16} /> Finalizar atendimento</button>
              </div>
            </>
          )}
        </div>
      </ModalBase>
    );
}