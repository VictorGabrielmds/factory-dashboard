// src/components/CozinhaDashboard/PedidoTicket.tsx
// A comanda em si é ESTÁTICA (sem zoom/pan próprio) — quem é o "canvas" é a
// arara inteira, lá em CozinhaDashboard. Aqui só tem dois gestos: arrastar a
// alça de cima pra concluir, e arrastar o cabeçalho pros lados pra reordenar.
import { useMemo, useRef, useState, memo, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { Pedido } from "../../types/Pedido";
import { calcularInteligenciaPedido, formatarEspera, URGENCIA_LABEL, ehPedidoDelivery } from "./cozinhaHelpers";
import { toTitleCase } from "../../utils/dateUtils";
import {
  MdOutlineSportsMotorsports,
  MdOutlineStorefront,
  MdDragIndicator,
  MdOpenWith,
  MdLocalFireDepartment,
  MdEvent,
} from "react-icons/md";

const LIMIAR_CONCLUIR_PX = 70;
// Papel de verdade nunca fica perfeitamente reto na arara — um leve
// desalinho (sempre o mesmo pro mesmo pedido, pra não "tremer" a cada
// re-render) ajuda a vender a ilusão de notinha física em vez de card de app.
function inclinacaoDeterministica(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return ((Math.abs(hash) % 100) / 100 - 0.5) * 2.2; // -1.1° a 1.1°
}

interface ArrastoOffset {
  x: number;
  y: number;
}

interface PedidoTicketProps {
  pedido: Pedido;
  agoraMs: number;
  onToggleItem: (pedido: Pedido, index: number, jaPronto: boolean) => void;
  onConcluir: (pedido: Pedido) => void;
  arrastoOffset?: ArrastoOffset | null;
  onIniciarArrasto: (id: string, clientX: number, clientY: number) => void;
  onMoverArrasto: (id: string, clientX: number, clientY: number) => void;
  onFinalizarArrasto: (id: string) => void;
}

function PedidoTicket({
  pedido,
  agoraMs,
  onToggleItem,
  onConcluir,
  arrastoOffset,
  onIniciarArrasto,
  onMoverArrasto,
  onFinalizarArrasto,
}: PedidoTicketProps) {
  const intel = useMemo(() => calcularInteligenciaPedido(pedido, agoraMs), [pedido, agoraMs]);
  const itensProntos = pedido.cozinha_itens_prontos ?? [];
  const totalTipos = pedido.descricao_item?.length ?? 0;
  const progressoPercentual = totalTipos > 0 ? Math.round((itensProntos.length / totalTipos) * 100) : 0;
  const idStr = String(pedido.order_id);
  const sendoArrastado = !!arrastoOffset;

  // ── Arrastar a alça de cima pra cima = "terminei com esse aqui" (concluir) ──
  const [dragY, setDragY] = useState(0);
  const [arrastandoHandle, setArrastandoHandle] = useState(false);
  const dragInicioY = useRef<number | null>(null);

  function handlePointerDownHandle(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    window.getSelection()?.removeAllRanges(); // evita seleção de texto grudar no meio do arrasto
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragInicioY.current = e.clientY;
    setArrastandoHandle(true);
  }
  function handlePointerMoveHandle(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragInicioY.current === null) return;
    const delta = e.clientY - dragInicioY.current;
    if (delta < 0) setDragY(delta);
  }
  function handlePointerUpHandle() {
    if (dragInicioY.current === null) return;
    dragInicioY.current = null;
    setArrastandoHandle(false);
    if (dragY <= -LIMIAR_CONCLUIR_PX) onConcluir(pedido);
    setDragY(0);
  }

  // ── Arrastar o cabeçalho pros lados = reordenar entre as outras comandas ──
  // Importante: NÃO usar a prop `sendoArrastado` pra decidir se repassa os
  // eventos de move/up pro pai — ela só fica true depois que o React
  // terminar de re-renderizar com o novo estado do pai, e os primeiros
  // pointermove de um arrasto real chegam ANTES disso. Gatear por ela
  // descartava esses primeiros pixels e fazia o arrasto parecer "engasgado"
  // ou simplesmente não começar. Um ref local (síncrono) resolve.
  const arrastandoLocalRef = useRef(false);

  function handlePointerDownReordenar(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    window.getSelection()?.removeAllRanges(); // evita seleção de texto grudar no meio do arrasto
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    arrastandoLocalRef.current = true;
    onIniciarArrasto(idStr, e.clientX, e.clientY);
  }
  function handlePointerMoveReordenar(e: ReactPointerEvent<HTMLDivElement>) {
    if (!arrastandoLocalRef.current) return;
    e.stopPropagation();
    onMoverArrasto(idStr, e.clientX, e.clientY);
  }
  function handlePointerUpReordenar(e: ReactPointerEvent<HTMLDivElement>) {
    if (!arrastandoLocalRef.current) return;
    arrastandoLocalRef.current = false;
    e.stopPropagation();
    onFinalizarArrasto(idStr);
  }

  const inclinacaoRepouso = useMemo(() => inclinacaoDeterministica(idStr), [idStr]);
  const rotacao = sendoArrastado ? Math.max(-6, Math.min(6, arrastoOffset!.x / 18)) : 0;
  const estilo: CSSProperties = sendoArrastado
    ? { transform: `translate(${arrastoOffset!.x}px, ${arrastoOffset!.y}px) rotate(${rotacao}deg) scale(1.03)` }
    : {
        transform: `translateY(${dragY}px) rotate(${inclinacaoRepouso}deg)`,
        opacity: arrastandoHandle ? Math.max(0.35, 1 + dragY / 160) : 1,
      };

  const tipoTexto = ehPedidoDelivery(pedido) ? "Entrega" : "Retirada";

  return (
    <div
      className={`pedido-ticket urgencia-${intel.urgencia}${arrastandoHandle ? " arrastando" : ""}${sendoArrastado ? " reordenando" : ""}`}
      style={estilo}
    >
      <div
        className="ticket-drag-handle"
        onPointerDown={handlePointerDownHandle}
        onPointerMove={handlePointerMoveHandle}
        onPointerUp={handlePointerUpHandle}
        onPointerCancel={handlePointerUpHandle}
        title="Arraste pra cima para concluir"
      >
        <MdDragIndicator size={16} />
      </div>

      <div className="ticket-torn topo" aria-hidden="true" />
      <div className="ticket-paper">
        <header
          className="ticket-header"
          onPointerDown={handlePointerDownReordenar}
          onPointerMove={handlePointerMoveReordenar}
          onPointerUp={handlePointerUpReordenar}
          onPointerCancel={handlePointerUpReordenar}
          title="Arraste para reordenar entre as comandas"
        >
          <div className="ticket-header-top">
            <span className="ticket-id">
              <MdOpenWith size={12} className="ticket-grip" aria-hidden="true" />#{pedido.order_id}
            </span>
            <span className="ticket-header-badges">
              {pedido.origem === "app" && <span className="ticket-origin-badge">App</span>}
              <span className={`ticket-badge badge-${intel.urgencia}`}>{URGENCIA_LABEL[intel.urgencia]}</span>
            </span>
          </div>
          <strong className="ticket-cliente">{toTitleCase(pedido.nome_destinatario)}</strong>
          <div className="ticket-meta-row">
            <span className="ticket-tipo">
              {ehPedidoDelivery(pedido) ? <MdOutlineSportsMotorsports size={14} /> : <MdOutlineStorefront size={14} />}
              {tipoTexto}
            </span>
            <span className="ticket-dificuldade" title={`Dificuldade estimada: ${intel.totalItens} unidades`}>
              {[1, 2, 3].map((n) => (
                <MdLocalFireDepartment key={n} size={13} className={n <= intel.dificuldade ? "chama-ativa" : "chama-inativa"} />
              ))}
            </span>
          </div>
          <div className="ticket-meta-row">
            {intel.horaAgendamento ? (
              <span className="ticket-hora">
                <MdEvent size={13} /> {intel.diaAgendamentoTexto} às {intel.horaAgendamento}
              </span>
            ) : (
              <span className="ticket-hora">Há {formatarEspera(intel.esperaMin)}</span>
            )}
          </div>
        </header>

        <ul className="ticket-itens">
          {(pedido.descricao_item ?? []).map((nome, index) => {
            const pronto = itensProntos.includes(index);
            const qtd = pedido.quantidade_item?.[index] ?? 1;
            return (
              <li
                key={index}
                className={`ticket-item${pronto ? " done" : ""}`}
                onClick={() => onToggleItem(pedido, index, pronto)}
              >
                <span className="ticket-item-check" aria-hidden="true">{pronto ? "✓" : ""}</span>
                <span className="ticket-item-qtd">{qtd}×</span>
                <span className="ticket-item-nome">{nome}</span>
              </li>
            );
          })}
        </ul>

        <footer className="ticket-footer">
          <div className="ticket-progress">
            <span className="ticket-progress-track" aria-hidden="true">
              <span className="ticket-progress-bar" style={{ width: `${progressoPercentual}%` }} />
            </span>
            <span className="ticket-progress-label">{itensProntos.length}/{totalTipos}</span>
          </div>
          <button type="button" className="ticket-concluir-btn" onClick={() => onConcluir(pedido)}>
            Concluir pedido
          </button>
        </footer>
      </div>
      <div className="ticket-torn" aria-hidden="true" />
    </div>
  );
}

export default memo(PedidoTicket);
