import {
  useState,
  memo,
  type MouseEvent,
} from "react";
import "./OrderCard.css";
import type { Pedido } from "../../types/Pedido";
import { PedidoStatus } from "../../types/Pedido";
import type { PixConflictAlert } from "../../hooks/usePixConflictAlerts";
import Tooltip from "../Tooltip/Tooltip";
import EditarPedidoAppModal from "./EditarPedidoAppModal";
import CancelarPedidoModal from "./CancelarPedidoModal";
import {
  MdDateRange,
  MdOutlineSportsMotorsports,
  MdLocationPin,
  MdOutlinePayments,
  MdOutlinePhone,
  MdExpandMore,
  MdExpandLess,
  MdMap,
  MdAccessTime,
  MdEdit,
  MdOutlineCancel,
  MdStorefront,
  MdWarningAmber,
} from "react-icons/md";
import {
  extractDayMonth,
  extractTime,
  formatToDDMMYYYY,
  isSameDay,
  parseAgendamentoDate,
  toTitleCase,
} from "../../utils/dateUtils";
import { ehPedidoDelivery } from "../CozinhaDashboard/cozinhaHelpers";
import { PAYMENT_LABELS, OUT_OF_BOX_KEYWORDS } from "./orderCardConstants";

const LINKABLE_PIX_CONFLICT_TYPES = new Set([
  "pix_sem_vinculo_exato",
  "pix_colisao",
]);

// Nada além do componente é exportado deste arquivo — PAYMENT_LABELS e
// OUT_OF_BOX_KEYWORDS moraram em orderCardConstants.ts (ver import acima)
// para o Fast Refresh funcionar.

// ------------------------------------
// Types
// ------------------------------------

type OrderCardProps = {
  orderData: Pedido;
  selectedDate: Date;
  isThisOrderSelectedForTrip: boolean;
  isCreatingTrip: boolean;
  openModal: (value: Pedido) => void;
  toggleOrderSelection: (value: Pedido) => void;
  startTripSelectionWithOrder: (value: Pedido) => void;
  canStartTripSelection: boolean;
  isScheduledForFuture?: boolean;
  isTripInteractionLocked: boolean;
  hasPixConflict?: boolean;
  pixConflictAlerts?: readonly PixConflictAlert[];
  onLinkPixToOrder?: (alert: PixConflictAlert, orderId: string) => void;
  linkingPixKey?: string | null;
};

// ------------------------------------
// Component
// ------------------------------------

function OrderCard({
  orderData,
  isCreatingTrip,
  toggleOrderSelection,
  startTripSelectionWithOrder,
  canStartTripSelection,
  isScheduledForFuture = false,
  isTripInteractionLocked,
  openModal,
  isThisOrderSelectedForTrip = false,
  hasPixConflict = false,
  pixConflictAlerts = [],
  onLinkPixToOrder,
  linkingPixKey,
}: OrderCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);

  const orderId = String(orderData.order_id);
  const linkablePixAlertsByPayment = new Map<string, PixConflictAlert>();
  let hasStructuralPixConflict = false;

  for (const alert of pixConflictAlerts) {
    if (
      alert.pagamentoId &&
      LINKABLE_PIX_CONFLICT_TYPES.has(alert.tipo)
    ) {
      if (!linkablePixAlertsByPayment.has(alert.pagamentoId)) {
        linkablePixAlertsByPayment.set(alert.pagamentoId, alert);
      }
    } else {
      hasStructuralPixConflict = true;
    }
  }

  const hasMultipleLinkablePix =
    linkablePixAlertsByPayment.size > 1;
  const linkablePixAlert =
    linkablePixAlertsByPayment.size === 1 && !hasStructuralPixConflict
      ? linkablePixAlertsByPayment.values().next().value as PixConflictAlert
      : null;
  const pixLinkKey = linkablePixAlert
    ? `${linkablePixAlert.id}:${orderId}`
    : null;
  const isLinkingThisPix = pixLinkKey === linkingPixKey;

  // Editar e cancelar só ficam disponíveis pra pedidos do app cliente ainda
  // não despachados — depois disso (pronto/em rota) mexer no pedido exige
  // avisar o motoboy também, não só o cliente, então fica de fora por ora.
  const podeGerenciarPedidoApp =
    orderData.origem === "app" && (orderData.status === 1 || orderData.status === 2);

  // Items that require special handling (out-of-box)
  const outOfBoxItems = orderData.descricao_item?.filter((item) =>
    OUT_OF_BOX_KEYWORDS.some((kw) => item.includes(kw))
  ) ?? [];

  // Address helpers
  const fullAddress = [
    orderData.logradouro_destinatario,
    orderData.numero_destinatario,
    orderData.bairro_destinatario,
  ]
    .filter(Boolean)
    .join(", ");

  const mapsQuery = encodeURIComponent(
    `${fullAddress} ${orderData.cep_destinatario ?? ""}`.trim()
  );
  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;

  // Event handlers
  function handleExpand(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsExpanded((prev) => !prev);
  }

  function handleOpenMaps(e: MouseEvent<HTMLAnchorElement>) {
    e.stopPropagation();
  }

  const eventCameFromCardSurface = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return false;

    // Eventos de um modal aberto pelo card sobem pela árvore React mesmo
    // quando o portal está fora do card no DOM. Esses cliques nunca devem
    // alterar a seleção da viagem.
    if (!event.currentTarget.contains(target)) return false;

    return !target.closest("button, a, input, select, textarea, [role='dialog']");
  };

  function handleCardClick(event: MouseEvent<HTMLDivElement>) {
    if (!eventCameFromCardSurface(event)) return;

    // Um duplo clique emite dois eventos de clique antes do dblclick. O
    // primeiro seleciona; os seguintes precisam ser ignorados para o pedido
    // não entrar e sair da viagem imediatamente.
    if (event.detail > 1) return;

    if (
      isCreatingTrip &&
      !isScheduledForFuture &&
      isDelivery &&
      orderData.status === PedidoStatus.Aceito
    ) {
      toggleOrderSelection(orderData);
    }
  }

  function handleCardDoubleClick(e: MouseEvent<HTMLDivElement>) {
    if (!eventCameFromCardSurface(e)) return;
    if (
      isCreatingTrip ||
      !canStartTripSelection ||
      !isDelivery ||
      orderData.status !== PedidoStatus.Aceito
    ) return;

    e.preventDefault();
    startTripSelectionWithOrder(orderData);
  }

  const pagamentos = Array.isArray(orderData.forma_pagamento)
    ? orderData.forma_pagamento
    : [orderData.forma_pagamento].filter(Boolean);

  // Indicador de PIX: "pago" só quando o webhook do Asaas confirmou de fato
  const isPix = pagamentos.some((c) => String(c).trim() === "17");
  const pixPago = orderData.pix_confirmado === true;
  const pixStatus = String(orderData.pix_status || (pixPago ? "RECEIVED" : "PENDING")).toUpperCase();
  const pixIndicador =
    pixStatus === "REFUNDED"
      ? { classe: "pix-chip--estornado", texto: "Estornado", aria: "PIX estornado" }
      : pixStatus === "PARTIALLY_REFUNDED"
        ? { classe: "pix-chip--estorno", texto: "Estorno parcial", aria: "PIX parcialmente estornado" }
        : pixStatus === "REFUND_IN_PROGRESS"
          ? { classe: "pix-chip--estorno", texto: "Estorno em curso", aria: "Estorno do PIX em andamento" }
          : pixPago
            ? { classe: "pix-chip--pago", texto: "Pago", aria: "PIX pago" }
            : { classe: "pix-chip--pendente", texto: "Aguardando", aria: "PIX ainda não confirmado" };

  // Mapeia os códigos para os nomes e junta com " + " caso haja mais de um
  const paymentLabel = pagamentos.length > 0
    ? pagamentos.map(codigo => PAYMENT_LABELS[String(codigo)] ?? codigo).join(" + ")
    : "—";
  const recipientName = toTitleCase(orderData.nome_destinatario);
  const motoboyDisplay =
    orderData.motoboy_nome ? toTitleCase(orderData.motoboy_nome.replace(/_/g, " ")) :
    orderData.motoboy_id ? toTitleCase(orderData.motoboy_id.replace(/_/g, " ")) :
    null;

  const precoFormatado = Number(orderData.valor_venda).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const isDelivery = ehPedidoDelivery(orderData);

  const isSelectableForTrip =
    isCreatingTrip && !isScheduledForFuture && isDelivery && orderData.status === PedidoStatus.Aceito;

  const isConfirmadoPeloCliente = orderData.status_interno === "confirmado_pelo_cliente";

  // Agendamento fica em primeiro plano; os demais dados aparecem agrupados
  // por significado para serem encontrados sem depender apenas dos ícones.
  const scheduledDay = extractDayMonth(orderData.agendamento);
  const scheduledTime = extractTime(orderData.agendamento);
  const scheduledDate = parseAgendamentoDate(orderData.agendamento);
  const isScheduledForToday = Boolean(
    scheduledDate && isSameDay(scheduledDate, new Date())
  );
  const scheduleDisplay = orderData.agendamento
    ? scheduledDay
      ? scheduledTime
        ? `${scheduledDay} às ${scheduledTime}`
        : `${scheduledDay} · Horário não informado`
      : orderData.agendamento
    : null;
  const scheduleDisplayForCard = isScheduledForToday && scheduledTime
    ? `Hoje às ${scheduledTime}`
    : scheduleDisplay;

  const movementDate =
    orderData.status === 5 && orderData.data_saida
      ? { label: "Saiu em", value: orderData.data_saida }
      : orderData.data_venda
        ? { label: "Pedido feito em", value: orderData.data_venda }
        : null;

  const chatUrl = orderData.telefone_destinatario
    ? (() => {
        const url = new URL(window.location.href);
        url.searchParams.set("view", "chat");
        url.searchParams.set("phone", orderData.telefone_destinatario);
        url.hash = "";
        return url.toString();
      })()
    : null;

  const pixConflictMessage = hasMultipleLinkablePix
    ? "Há mais de um PIX pendente para este pedido. Confira na área de pendências."
    : hasStructuralPixConflict
      ? "Este conflito precisa ser conferido na área de pendências antes de confirmar o pagamento."
      : linkablePixAlert?.tipo === "pix_colisao"
        ? "Este PIX possui mais de um pedido candidato. Confira os dados antes de vincular."
        : "O pagamento foi recebido, mas ainda não possui vínculo exato com este pedido.";

  return (
    <div
      className={[
        "order-card",
        isThisOrderSelectedForTrip ? "checked-block" : "",
        isExpanded ? "card-expanded" : "",
        isSelectableForTrip ? "selectable" : "",
        orderData.status === 5 ? 'card-completed' : '',
        hasPixConflict ? "has-pix-conflict" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={handleCardClick}
      onDoubleClick={handleCardDoubleClick}
    >
      <div className="order-block">
        {/* Cabeçalho: quem + quanto — os dois anchors do olho do operador */}
        <header className="oc-head">
          {isSelectableForTrip && (
            <button
              type="button"
              className="trip-select-toggle"
              aria-pressed={isThisOrderSelectedForTrip}
              aria-label={
                isThisOrderSelectedForTrip
                  ? `Remover pedido ${orderData.order_id} da viagem`
                  : `Adicionar pedido ${orderData.order_id} à viagem`
              }
              onClick={(event) => {
                event.stopPropagation();
                toggleOrderSelection(orderData);
              }}
            >
              <span aria-hidden="true">
                {isThisOrderSelectedForTrip ? "✓" : ""}
              </span>
            </button>
          )}
          {outOfBoxItems.length > 0 && (
            <Tooltip text={outOfBoxItems.join("\n")}>
              <div className="out-box-items" aria-label="Atenção: itens fora da caixa">
                !
              </div>
            </Tooltip>
          )}
          <div className="oc-identity">
            <strong className="oc-name" id={`order-name-${orderData.order_id}`}>
              {recipientName}
            </strong>
            <div className="oc-tags">
              <span className="oc-id">Pedido #{orderData.order_id}</span>
              {orderData.origem === "app" && (
                <>
                  <span className="oc-dot" aria-hidden="true">·</span>
                  <span className="oc-tag oc-tag--accent">App</span>
                </>
              )}
              {isConfirmadoPeloCliente && (
                <>
                  <span className="oc-dot" aria-hidden="true">·</span>
                  <span className="oc-tag oc-tag--ok">Confirmado pelo cliente</span>
                </>
              )}
              {!isDelivery && (
                <>
                  <span className="oc-dot" aria-hidden="true">·</span>
                  <span className="oc-tag oc-tag--pickup">
                    <MdStorefront aria-hidden="true" />
                    Retirada
                  </span>
                </>
              )}
            </div>
          </div>
          <p className="oc-price">
            <span className="oc-price-currency">R$</span> {precoFormatado}
          </p>
        </header>

        {hasPixConflict && (
          <div className="oc-pix-conflict" role="note" aria-label="Conflito na confirmação do PIX">
            <MdWarningAmber aria-hidden="true" />
            <span>
              <strong>Conferir PIX</strong>
              {pixConflictMessage}
            </span>
            {linkablePixAlert && onLinkPixToOrder && (
              <button
                type="button"
                className="oc-pix-conflict-action"
                disabled={Boolean(linkingPixKey)}
                aria-busy={isLinkingThisPix}
                aria-label={`Vincular PIX ao pedido ${orderId}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onLinkPixToOrder(linkablePixAlert, orderId);
                }}
              >
                {isLinkingThisPix ? "Vinculando…" : "Vincular PIX ao pedido"}
              </button>
            )}
          </div>
        )}

        {scheduleDisplayForCard && (
          <div
            className={`oc-schedule${isScheduledForToday ? " oc-schedule--today" : ""}`}
            aria-label={`Agendamento: ${scheduleDisplayForCard}`}
          >
            <span className="oc-schedule-icon">
              <MdAccessTime aria-hidden="true" />
            </span>
            <span className="oc-info-copy">
              <span className="oc-info-label">
                {isScheduledForToday ? "Para hoje" : "Agendamento"}
              </span>
              <strong>{scheduleDisplayForCard}</strong>
            </span>
          </div>
        )}

        <div className="oc-info-grid">
          {isDelivery && orderData.bairro_destinatario && (
            <div className="oc-info-item">
              <MdLocationPin aria-hidden="true" />
              <span className="oc-info-copy">
                <span className="oc-info-label">Destino</span>
                <span className="oc-info-value">{orderData.bairro_destinatario}</span>
              </span>
            </div>
          )}

          <div className="oc-info-item">
            <MdOutlinePayments aria-hidden="true" />
            <span className="oc-info-copy">
              <span className="oc-info-label">Pagamentos</span>
              <span className="oc-info-value oc-info-value--payment">
                <span>{paymentLabel}</span>
                {isPix && (
                  <span
                    className={`pix-chip ${pixIndicador.classe}`}
                    aria-label={pixIndicador.aria}
                  >
                    <span className="pix-chip-dot" aria-hidden="true" />
                    {pixIndicador.texto}
                  </span>
                )}
              </span>
            </span>
          </div>

          {orderData.telefone_destinatario && (
            <div className="oc-info-item">
              <MdOutlinePhone aria-hidden="true" />
              <span className="oc-info-copy">
                <span className="oc-info-label">Contato</span>
                <a
                  className="oc-info-value"
                  href={chatUrl ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Abrir conversa com ${orderData.telefone_destinatario} no Chat`}
                >
                  {orderData.telefone_destinatario}
                </a>
              </span>
            </div>
          )}

          {motoboyDisplay && (
            <div className="oc-info-item">
              <MdOutlineSportsMotorsports aria-hidden="true" />
              <span className="oc-info-copy">
                <span className="oc-info-label">Motoboy</span>
                <span className="oc-info-value">{motoboyDisplay}</span>
              </span>
            </div>
          )}
        </div>

        {movementDate && (
          <p className="oc-timeline">
            <MdDateRange aria-hidden="true" />
            <span>{movementDate.label} {formatToDDMMYYYY(movementDate.value)}</span>
          </p>
        )}

        {/* Expanded: itens do pedido + endereço (quando houver entrega) */}
        {isExpanded && (
          <div className="expanded-details">
            {orderData.descricao_item && orderData.descricao_item.length > 0 && (
              <div className="expanded-section">
                <p className="address-label">Itens</p>
                <ul className="items-list">
                  {orderData.descricao_item.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {isDelivery && (
              <div className="expanded-section">
                <p className="address-label">Endereço</p>
                <p>
                  {orderData.logradouro_destinatario}
                  {orderData.numero_destinatario ? `, ${orderData.numero_destinatario}` : ""}
                </p>
                {orderData.complemento_destinatario && (
                  <p className="complemento">Comp: {orderData.complemento_destinatario}</p>
                )}
                <p>
                  {[orderData.bairro_destinatario, orderData.cep_destinatario]
                    .filter(Boolean)
                    .join(" — ")}
                </p>
                <a
                  href={googleMapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="maps-link"
                  onClick={handleOpenMaps}
                >
                  <MdMap aria-hidden="true" /> Abrir no Google Maps
                </a>
              </div>
            )}
          </div>
        )}

        {/* Ações — separadas pelo "picote" da comanda */}
        <div className="order-actions">
          <button
            className="btn-expand"
            onClick={handleExpand}
            aria-expanded={isExpanded}
            aria-controls={`details-${orderData.order_id}`}
          >
            {isExpanded ? "Menos detalhes" : "Mais detalhes"}
            {isExpanded ? <MdExpandLess size={16} aria-hidden="true" /> : <MdExpandMore size={16} aria-hidden="true" />}
          </button>

          {podeGerenciarPedidoApp && !isTripInteractionLocked && (
            <button
              className="btn-icon btn-icon--edit"
              onClick={(e) => {
                e.stopPropagation();
                setIsEditModalOpen(true);
              }}
              aria-label={`Editar pedido ${orderData.order_id}`}
            >
              <MdEdit size={16} aria-hidden="true" />
            </button>
          )}

          {podeGerenciarPedidoApp && !isTripInteractionLocked && (
            <button
              className="btn-icon btn-icon--danger"
              onClick={(e) => {
                e.stopPropagation();
                setIsCancelModalOpen(true);
              }}
              aria-label={`Cancelar pedido ${orderData.order_id}`}
            >
              <MdOutlineCancel size={16} aria-hidden="true" />
            </button>
          )}

          {orderData.status === 5 && !isTripInteractionLocked && (
            <button
              className="btn-action btn-action--secondary"
              onClick={(e) => {
                e.stopPropagation();
                openModal(orderData);
              }}
              aria-label={`Editar pedido ${orderData.order_id}`}
            >
              Editar
            </button>
          )}

          {orderData.status === 2 && !isTripInteractionLocked && !isScheduledForFuture && (
            <button
              className="btn-action btn-action--primary"
              onClick={(e) => {
                e.stopPropagation();
                openModal(orderData);
              }}
              aria-label={isDelivery ? `Enviar pedido ${orderData.order_id}` : `Marcar pedido ${orderData.order_id} como pronto`}
            >
              {isDelivery ? "Enviar" : "Marcar pronto"}
            </button>
          )}
        </div>
      </div>

      {isEditModalOpen && (
        <EditarPedidoAppModal
          orderId={String(orderData.order_id)}
          onClose={() => setIsEditModalOpen(false)}
        />
      )}

      {isCancelModalOpen && (
        <CancelarPedidoModal
          orderId={String(orderData.order_id)}
          pedido={orderData}
          onClose={() => setIsCancelModalOpen(false)}
        />
      )}
    </div>
  );
}

export default memo(OrderCard);
