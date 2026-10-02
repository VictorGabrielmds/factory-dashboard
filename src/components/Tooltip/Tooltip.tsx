// src/components/Tooltip.tsx
import { useRef, useState, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./Tooltip.css";

interface TooltipProps {
  text: string;
  children: ReactNode;
}

const GAP = 10; // distância entre o alvo e o balão
const MARGIN = 12; // respiro mínimo até a borda da tela

export default function Tooltip({ text, children }: TooltipProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; arrow: "top" | "bottom" } | null>(null);

  // Calcula a posição do balão relativa à VIEWPORT (não ao card), então
  // nunca é cortado por overflow/scroll de nenhum container pai e nunca
  // fica preso disputando espaço com o conteúdo do próprio card.
  const updatePosition = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;

    // Prefere abrir para cima; se não houver espaço, abre para baixo.
    const spaceAbove = rect.top;
    const openDown = spaceAbove < 90; // altura mínima aproximada do balão + seta

    const top = openDown ? rect.bottom + GAP : rect.top - GAP;
    const left = Math.min(
      Math.max(centerX, MARGIN + 100),
      window.innerWidth - MARGIN - 100
    );

    setCoords({ top, left, arrow: openDown ? "top" : "bottom" });
  }, []);

  const show = () => updatePosition();
  const hide = () => setCoords(null);

  return (
    <div
      className="tooltip"
      ref={wrapperRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {coords &&
        createPortal(
          <span
            className={`tooltip-text tooltip-text--fixed tooltip-text--${coords.arrow}`}
            role="tooltip"
            style={{
              top: coords.top,
              left: coords.left,
              transform:
                coords.arrow === "top"
                  ? "translate(-50%, 0)"
                  : "translate(-50%, -100%)",
            }}
          >
            {text}
          </span>,
          document.body
        )}
    </div>
  );
}