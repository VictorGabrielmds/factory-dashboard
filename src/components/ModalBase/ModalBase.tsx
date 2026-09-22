import { useEffect, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./ModalBase.css";
import { BsXLg as XLg } from "react-icons/bs";

type ModalBaseProps = {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  title: string;
  className?: string;
  size?: "sm" | "md" | "lg";
  closeDisabled?: boolean;
};

function ModalBase({
  isOpen,
  onClose,
  children,
  title,
  className = "",
  size = "md",
  closeDisabled = false,
}: ModalBaseProps) {
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeDisabled) onClose();
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeDisabled, isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="modal-base"
      role="presentation"
      onClick={(event) => {
        // Portals continuam pertencendo à árvore React de quem os abriu.
        // Interromper aqui evita que um clique dentro do modal também acione
        // o card de pedido que está por trás dele.
        event.stopPropagation();
        if (
          !closeDisabled &&
          event.target === event.currentTarget
        ) {
          onClose();
        }
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div
        className={`modal-container modal-container--${size}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <div className="modal-title">
            <span className="modal-title-mark" aria-hidden="true" />
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            type="button"
            className="close-btn"
            onClick={onClose}
            aria-label="Fechar"
            disabled={closeDisabled}
          >
            <XLg size={16} />
          </button>
        </div>
        <div className="modal-content">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ModalBase;
