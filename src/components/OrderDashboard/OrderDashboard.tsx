import { useState, useRef, useEffect, useCallback, useMemo, Suspense, lazy } from "react";
import OrdersList from "../OrdersList/OrdersList";
import {
  filtrarPedidosDaBuscaPorDia,
  pedidoCorrespondeAoDia,
} from "../OrdersList/ordersListSearch";
import "./OrderDashboard.css";
import LazyDatePicker from "../Shared/LazyDatePicker";
import { MdCalendarMonth, MdClose, MdSearch, MdWarningAmber } from "react-icons/md";

// ✅ IMPORTANDO NOSSO MOTOR DE DADOS OTIMIZADO
import {
  usePedidos,
  usePedidosAbertos,
  usePedidosParaRotas,
  usePedidosPorDataOperacional,
} from "../../hooks/usePedidos";
import {
  usePixConflictAlerts,
  type PixConflictAlert,
} from "../../hooks/usePixConflictAlerts";
import { useToast } from "../../contexts/ToastContext";
import { apiFetch, BASE_URL } from "../../services/api";

import {
  isSameDay,
  isAfterDay,
  formatDateDay,
} from "../../utils/dateUtils";
import { ehPedidoDelivery, ehRetiradaDoAppCliente } from "../CozinhaDashboard/cozinhaHelpers";

// @hello-pangea/dnd só entra no bundle quando a mesa de roteirização é
// desenhada — isolado em chunk próprio para não pesar no parse do bundle
// principal (OrderDashboard é a tela padrão, carregada eager).
const RouteKaban = lazy(() =>
  import("../RouteKaban/RouteKaban").then((m) => ({ default: m.RouteKaban }))
);

export const DateOption = {
  Amanha:     "amanha",
  Hoje:       "hoje",
  Calendario: "calendario",
} as const;

export type DateOption = (typeof DateOption)[keyof typeof DateOption];

const DATE_OFFSETS: Partial<Record<DateOption, number>> = {
  [DateOption.Amanha]:    1,
  [DateOption.Hoje]:      0,
};

type FulfillmentFilter = "all" | "delivery" | "pickup";

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isFutureDay(selectedDay: Date): boolean {
  return isAfterDay(selectedDay, new Date());
}

function juntarPedidos<T extends { order_id: string | number }>(...listas: T[][]): T[] {
  const porId = new Map<string, T>();
  for (const lista of listas) {
    for (const pedido of lista) porId.set(String(pedido.order_id), pedido);
  }
  return Array.from(porId.values());
}

function pedidoEhPix(pedido: { forma_pagamento?: string[] | string | null }): boolean {
  const formas = Array.isArray(pedido.forma_pagamento)
    ? pedido.forma_pagamento
    : [pedido.forma_pagamento];
  return formas.some((forma) => {
    const codigo = String(forma || "").trim().toLowerCase();
    return codigo === "17" || codigo.includes("pix");
  });
}

type PixLinkResponse = {
  error?: string;
  motivos?: string[];
  jaConfirmado?: boolean;
};

const OrderDashboard = () => {
  const { addToast } = useToast();
  // ✅ BUG DA MADRUGADA CORRIGIDO: Data dinâmica e não congelada.
  const today = new Date(); 

  const [selectedDay,    setSelectedDay]    = useState<Date>(today);
  const [activeOption,   setActiveOption]   = useState<DateOption>(DateOption.Hoje);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [searchTerm,     setSearchTerm]     = useState("");
  const [isSearchOpen,   setIsSearchOpen]   = useState(false);
  const [fulfillmentFilter, setFulfillmentFilter] = useState<FulfillmentFilter>("all");
  const [activeTripDraftOwners, setActiveTripDraftOwners] = useState<Set<string>>(
    () => new Set()
  );
  const [linkingPixKey, setLinkingPixKey] = useState<string | null>(null);

  const inputRef       = useRef<HTMLInputElement>(null);
  const calendarRef    = useRef<HTMLLIElement>(null);
  const fulfillmentBeforeTripRef = useRef<FulfillmentFilter>("all");
  const hadActiveTripDraftRef = useRef(false);

  const normalizedSearch = searchTerm.trim();
  const isSearching = normalizedSearch.length > 0;
  const hasActiveTripDraft = activeTripDraftOwners.size > 0;
  const todayKey = formatDateDay(today);
  const selectedDayIsToday = isSameDay(selectedDay, today);

  const recentSearchDates = useMemo(() => {
    const [day, month, year] = todayKey.split("/").map(Number);
    const base = new Date(year, month - 1, day, 12, 0, 0, 0);

    return {
      today: base,
      yesterday: addDays(base, -1),
      dayBeforeYesterday: addDays(base, -2),
    };
  }, [todayKey]);

  // A busca usa um listener separado. Assim, consultar ontem/anteontem não
  // troca os pedidos entregues à mesa de rotas da data selecionada — antes,
  // uma busca podia esvaziar e reconstruir uma corrida já organizada.
  const pedidosDaJanelaDeCriacao = usePedidos(selectedDay);
  const pedidosAbertos = usePedidosAbertos();
  const pedidosDaDataOperacional = usePedidosPorDataOperacional(selectedDay);
  const todosPedidosDoPeriodo = useMemo(
    () => juntarPedidos(
      pedidosDaJanelaDeCriacao,
      pedidosAbertos,
      pedidosDaDataOperacional,
    ),
    [pedidosAbertos, pedidosDaDataOperacional, pedidosDaJanelaDeCriacao]
  );
  const todosPedidosParaRotas = usePedidosParaRotas();
  const pedidosRecentesDaBusca = usePedidos(
    recentSearchDates.yesterday,
    (isSearching && selectedDayIsToday) || hasActiveTripDraft
  );
  const todosPedidosDaBusca = useMemo(
    () => juntarPedidos(pedidosRecentesDaBusca, pedidosAbertos),
    [pedidosAbertos, pedidosRecentesDaBusca]
  );
  const todosPedidos = isSearching && selectedDayIsToday
    ? todosPedidosDaBusca
    : todosPedidosDoPeriodo;
  const {
    alerts: pixConflictAlerts,
    orderIds: pixConflictOrderIds,
  } = usePixConflictAlerts();
  const pixConflictAlertsByOrderId = useMemo(() => {
    const alertsByOrderId = new Map<string, PixConflictAlert[]>();

    for (const alert of pixConflictAlerts) {
      for (const orderId of alert.orderIds) {
        const orderAlerts = alertsByOrderId.get(orderId) ?? [];
        orderAlerts.push(alert);
        alertsByOrderId.set(orderId, orderAlerts);
      }
    }

    return alertsByOrderId;
  }, [pixConflictAlerts]);

  // Filtramos em memória apenas o que esse Dashboard precisa (extremamente rápido)
  const pedidos = useMemo(() => {
    return todosPedidos.filter(
      (p) => p.status === 1 || p.status === 2 || p.status === 3 || p.status === 5
    );
  }, [todosPedidos]);

  const pedidosDoPeriodo = useMemo(() => {
    return todosPedidosDoPeriodo.filter(
      (p) => p.status === 1 || p.status === 2 || p.status === 3 || p.status === 5
    );
  }, [todosPedidosDoPeriodo]);

  const matchesFulfillmentFilter = useCallback((pedido: (typeof pedidos)[number]) => {
    const isDelivery = ehPedidoDelivery(pedido);
    const isPickupFromCustomerApp = ehRetiradaDoAppCliente(pedido);

    if (fulfillmentFilter === "delivery") return isDelivery;
    if (fulfillmentFilter === "pickup") return isPickupFromCustomerApp;
    return isDelivery || isPickupFromCustomerApp;
  }, [fulfillmentFilter]);

  const pedidosFiltrados = useMemo(
    () => pedidos.filter(matchesFulfillmentFilter),
    [matchesFulfillmentFilter, pedidos]
  );

  const pedidosDoPeriodoFiltrados = useMemo(
    () => pedidosDoPeriodo.filter(matchesFulfillmentFilter),
    [matchesFulfillmentFilter, pedidosDoPeriodo]
  );

  const handleTripDraftChange = useCallback((ownerId: string, active: boolean) => {
    setActiveTripDraftOwners((current) => {
      if (current.has(ownerId) === active) return current;

      const next = new Set(current);
      if (active) next.add(ownerId);
      else next.delete(ownerId);
      return next;
    });
  }, []);

  // Digitar fora de outro campo abre a busca já com o caractere digitado.
  // O valor entra no estado manualmente porque o foco só chega ao input após
  // este mesmo evento de teclado terminar.
  useEffect(() => {
    const handleQuickSearch = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== "Backspace" && event.key.length !== 1) return;
      if (event.key === " ") return;

      const active = document.activeElement as HTMLElement | null;
      const isTypingInField =
        active?.tagName === "INPUT" ||
        active?.tagName === "TEXTAREA" ||
        active?.isContentEditable;

      if (isTypingInField) return;

      event.preventDefault();
      setSearchTerm((current) =>
        event.key === "Backspace" ? current.slice(0, -1) : `${current}${event.key}`
      );
      setIsSearchOpen(true);
    };

    document.addEventListener("keydown", handleQuickSearch);
    return () => document.removeEventListener("keydown", handleQuickSearch);
  }, []);

  useEffect(() => {
    if (!isSearchOpen) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isSearchOpen]);

  useEffect(() => {
    if (!hasActiveTripDraft) return;
    setIsCalendarOpen(false);
  }, [hasActiveTripDraft]);

  useEffect(() => {
    const wasActive = hadActiveTripDraftRef.current;

    if (hasActiveTripDraft && !wasActive) {
      fulfillmentBeforeTripRef.current = fulfillmentFilter;
      setFulfillmentFilter("delivery");
      setIsSearchOpen(false);
    } else if (!hasActiveTripDraft && wasActive) {
      setFulfillmentFilter(fulfillmentBeforeTripRef.current);
    }

    hadActiveTripDraftRef.current = hasActiveTripDraft;
  }, [fulfillmentFilter, hasActiveTripDraft]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(e.target as Node)) {
        setIsCalendarOpen(false);
      }
    };
    if (isCalendarOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isCalendarOpen]);

  const handleDateSelection = useCallback(
    (option: DateOption) => {
      if (hasActiveTripDraft) return;
      setActiveOption(option);
      if (option === DateOption.Calendario) {
        setIsCalendarOpen((prev) => !prev);
        return;
      }
      const offset = DATE_OFFSETS[option] ?? 0;
      
      // ✅ FIX: Ajusta para o meio-dia para proteger contra o fuso horário
      const dataSegura = addDays(new Date(), offset);
      dataSegura.setHours(12, 0, 0, 0);
      
      setSelectedDay(dataSegura);
      setIsCalendarOpen(false);
    },
    [hasActiveTripDraft]
  );

  const handleCalendarChange = useCallback((date: Date | null) => {
    if (!date || hasActiveTripDraft) return;
    
    // ✅ FIX: O calendário devolve a data às 00:00:00. 
    // Colocamos 12:00:00 para evitar que o GMT-3 empurre para o dia anterior.
    const safeDate = new Date(date);
    safeDate.setHours(12, 0, 0, 0);
    
    setSelectedDay(safeDate);
    setIsCalendarOpen(false);
    setActiveOption(DateOption.Calendario);
  }, [hasActiveTripDraft]);

  const handleSearch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchTerm("");
    inputRef.current?.focus();
  }, []);

  const closeSearch = useCallback(() => {
    // O campo continua montado para a animação de fechamento. Tirar o foco
    // antes de escondê-lo evita que ele receba texto invisivelmente depois do Esc.
    inputRef.current?.blur();
    setSearchTerm("");
    setIsSearchOpen(false);
  }, []);

  const handleLinkPixToOrder = useCallback(async (
    alert: PixConflictAlert,
    orderId: string,
  ) => {
    if (!alert.pagamentoId || linkingPixKey) return;

    const hasMultipleCandidates = alert.orderIds.length > 1;
    const confirmed = window.confirm(
      hasMultipleCandidates
        ? `Este PIX possui ${alert.orderIds.length} pedidos candidatos. Confirma o vínculo com o pedido #${orderId}?`
        : `Confirma o vínculo deste PIX com o pedido #${orderId}?`,
    );
    if (!confirmed) return;

    const requestKey = `${alert.id}:${orderId}`;
    setLinkingPixKey(requestKey);

    try {
      const response = await apiFetch(`${BASE_URL}/conversas`, {
        method: "POST",
        body: JSON.stringify({
          action: "confirmarPixManualmente",
          idPagamento: alert.pagamentoId,
          orderId,
          pendenciaId: alert.id,
        }),
      });
      const result = await response.json().catch(() => null) as PixLinkResponse | null;

      if (!response.ok) {
        const details = result?.motivos?.filter(Boolean).join(" ");
        throw new Error(
          [result?.error || "Não foi possível vincular o PIX.", details]
            .filter(Boolean)
            .join(" "),
        );
      }

      addToast(
        result?.jaConfirmado
          ? `O PIX já estava vinculado ao pedido #${orderId}.`
          : `PIX vinculado ao pedido #${orderId}.`,
        "success",
      );
    } catch (error) {
      console.error("Erro ao vincular PIX manualmente:", error);
      addToast(
        error instanceof Error
          ? error.message
          : "Não foi possível vincular o PIX. Tente novamente.",
        "error",
      );
    } finally {
      setLinkingPixKey((current) => current === requestKey ? null : current);
    }
  }, [addToast, linkingPixKey]);

  // Retirada não passa por roteirização/motoboy — só delivery entra na fila de rotas.
  const pedidosParaRoteirizar = useMemo(
    () => todosPedidosParaRotas.filter(ehPedidoDelivery),
    [todosPedidosParaRotas]
  );

  const showFutureView = activeOption === DateOption.Amanha || isFutureDay(selectedDay);
  const isToday = selectedDayIsToday;
  const headerLabel = formatDateDay(selectedDay);

  const searchResultsToday = useMemo(
    () => filtrarPedidosDaBuscaPorDia(pedidosFiltrados, recentSearchDates.today, normalizedSearch),
    [normalizedSearch, pedidosFiltrados, recentSearchDates.today]
  );
  const searchResultsYesterday = useMemo(
    () => filtrarPedidosDaBuscaPorDia(pedidosFiltrados, recentSearchDates.yesterday, normalizedSearch),
    [normalizedSearch, pedidosFiltrados, recentSearchDates.yesterday]
  );
  const searchResultsDayBeforeYesterday = useMemo(
    () => filtrarPedidosDaBuscaPorDia(pedidosFiltrados, recentSearchDates.dayBeforeYesterday, normalizedSearch),
    [normalizedSearch, pedidosFiltrados, recentSearchDates.dayBeforeYesterday]
  );
  const selectedDateSearchResults = useMemo(
    () => filtrarPedidosDaBuscaPorDia(pedidosFiltrados, selectedDay, normalizedSearch),
    [normalizedSearch, pedidosFiltrados, selectedDay]
  );
  const scopedSearchResults = useMemo(() => {
    if (!isToday) return selectedDateSearchResults;
    return [
      ...searchResultsToday,
      ...searchResultsYesterday,
      ...searchResultsDayBeforeYesterday,
    ];
  }, [
    isToday,
    searchResultsDayBeforeYesterday,
    searchResultsToday,
    searchResultsYesterday,
    selectedDateSearchResults,
  ]);
  const pendingPaymentSearchResults = useMemo(
    () => scopedSearchResults.filter(
      (pedido) => pedido.status === 1 && pedidoEhPix(pedido)
    ),
    [scopedSearchResults]
  );
  const selectableSearchResults = useMemo(
    () => scopedSearchResults.filter((pedido) => pedido.status === 2),
    [scopedSearchResults]
  );
  const readyPickupSearchResults = useMemo(
    () => scopedSearchResults.filter(
      (pedido) => pedido.status === 3 && ehRetiradaDoAppCliente(pedido)
    ),
    [scopedSearchResults]
  );
  const pendingPaymentOrders = useMemo(() => {
    const selectedISO = [
      selectedDay.getFullYear(),
      String(selectedDay.getMonth() + 1).padStart(2, "0"),
      String(selectedDay.getDate()).padStart(2, "0"),
    ].join("-");
    return pedidosDoPeriodoFiltrados.filter(
      (pedido) =>
        pedido.status === 1 &&
        pedidoEhPix(pedido) &&
        pedidoCorrespondeAoDia(pedido, selectedISO)
    );
  }, [pedidosDoPeriodoFiltrados, selectedDay]);
  const completedSearchResultsToday = useMemo(
    () => searchResultsToday.filter((pedido) => pedido.status === 5),
    [searchResultsToday]
  );
  const completedSearchResultsYesterday = useMemo(
    () => searchResultsYesterday.filter((pedido) => pedido.status === 5),
    [searchResultsYesterday]
  );
  const completedSearchResultsDayBeforeYesterday = useMemo(
    () => searchResultsDayBeforeYesterday.filter((pedido) => pedido.status === 5),
    [searchResultsDayBeforeYesterday]
  );
  const completedSearchResultsSelectedDate = useMemo(
    () => selectedDateSearchResults.filter((pedido) => pedido.status === 5),
    [selectedDateSearchResults]
  );
  const tripSourceData = useMemo(() => {
    const latestById = new Map<string, (typeof todosPedidosDoPeriodo)[number]>();
    for (const pedido of [...todosPedidosDoPeriodo, ...todosPedidosDaBusca]) {
      latestById.set(String(pedido.order_id), pedido);
    }
    return Array.from(latestById.values());
  }, [todosPedidosDaBusca, todosPedidosDoPeriodo]);

  const acceptedTitle = fulfillmentFilter === "delivery"
    ? (isToday ? "Entregas de hoje" : `Entregas em ${headerLabel}`)
    : fulfillmentFilter === "pickup"
      ? (isToday ? "Retiradas de hoje" : `Retiradas em ${headerLabel}`)
      : (isToday ? "Aguardando pedidos" : `Pedidos em ${headerLabel}`);
  const acceptedDescription = fulfillmentFilter === "delivery"
    ? "Aguardando despacho"
    : fulfillmentFilter === "pickup"
      ? "Pedidos do app cliente aguardando ficar prontos"
      : "Entregas e retiradas do app cliente em atendimento";
  const completedTitle = fulfillmentFilter === "delivery"
    ? (isToday ? "Saíram hoje" : `Saíram em ${headerLabel}`)
    : fulfillmentFilter === "pickup"
      ? (isToday ? "Retirados hoje" : `Retirados em ${headerLabel}`)
      : (isToday ? "Finalizados hoje" : `Finalizados em ${headerLabel}`);
  const completedDescription = fulfillmentFilter === "delivery"
    ? "Pedidos entregues aos motoboys"
    : fulfillmentFilter === "pickup"
      ? "Pedidos retirados no balcão"
      : "Despachados ou retirados no balcão";

  return (
    <div className="ops">
      <Suspense fallback={null}>
        <RouteKaban orders={pedidosParaRoteirizar} selectedDate={selectedDay} />
      </Suspense>

      <nav
        className={`order-dashboard-menu${hasActiveTripDraft ? " is-trip-locked" : ""}`}
        aria-label="Controles dos pedidos"
        title={
          hasActiveTripDraft
            ? "Finalize ou descarte a viagem para mudar a data ou o tipo de pedido"
            : undefined
        }
      >
        <div className="order-date-filter">
          <ul className="data-button-list" role="list">
            {(
              [
                { option: DateOption.Hoje,       label: "Hoje"       },
                { option: DateOption.Amanha,    label: "Amanhã"     },
              ] as const
            ).map(({ option, label }) => (
              <li key={option}>
                <button
                  onClick={() => handleDateSelection(option)}
                  className={activeOption === option ? "active" : ""}
                  aria-pressed={activeOption === option}
                  disabled={hasActiveTripDraft}
                >
                  {label}
                </button>
              </li>
            ))}

            <li className="open-calendar-button" ref={calendarRef}>
              <button
                onClick={() => handleDateSelection(DateOption.Calendario)}
                className={activeOption === DateOption.Calendario ? "active" : ""}
                aria-label="Escolher outra data"
                aria-expanded={isCalendarOpen}
                disabled={hasActiveTripDraft}
              >
                <MdCalendarMonth aria-hidden="true" />
              </button>
              {isCalendarOpen && (
                <div className="calendar" role="dialog" aria-label="Seletor de data">
                  <Suspense fallback={null}>
                    <LazyDatePicker
                      selected={selectedDay}
                      onChange={handleCalendarChange}
                      inline
                    />
                  </Suspense>
                </div>
              )}
            </li>
          </ul>
        </div>

        <div className="fulfillment-filter" role="group" aria-label="Tipo de pedido">
          {(
            [
              { value: "all", label: "Todos" },
              { value: "delivery", label: "Delivery" },
              { value: "pickup", label: "Retirada" },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              className={fulfillmentFilter === option.value ? "active" : ""}
              onClick={() => setFulfillmentFilter(option.value)}
              aria-pressed={fulfillmentFilter === option.value}
              disabled={hasActiveTripDraft}
              title={option.value === "pickup" ? "Pedidos para retirada feitos pelo App Cliente" : undefined}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className={`order-search-control${isSearchOpen ? " is-open" : ""}`}>
          {!isSearchOpen && (
            <button
              type="button"
              className="search-trigger-button"
              onClick={() => setIsSearchOpen(true)}
              aria-label="Pesquisar pedidos"
              aria-expanded={isSearchOpen}
              title="Pesquisar por cliente ou número do pedido"
            >
              <MdSearch aria-hidden="true" />
              <span>Pesquisar</span>
            </button>
          )}

          <div className="search-box" aria-hidden={!isSearchOpen}>
            <label htmlFor="dashboard-search" className="sr-only">Buscar por cliente ou número do pedido</label>
            <MdSearch className="search-box-icon" aria-hidden="true" />
            <input
              id="dashboard-search"
              type="search"
              ref={inputRef}
              tabIndex={isSearchOpen ? 0 : -1}
              placeholder={hasActiveTripDraft ? "Buscar e adicionar pedidos" : "Nome ou nº do pedido"}
              value={searchTerm}
              onChange={handleSearch}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeSearch();
                }
              }}
              autoComplete="off"
            />
            <button
              type="button"
              className="search-clear-button"
              onClick={closeSearch}
              aria-label="Fechar pesquisa"
              title="Fechar pesquisa"
              tabIndex={isSearchOpen ? 0 : -1}
            >
              <MdClose aria-hidden="true" />
            </button>
          </div>
        </div>
      </nav>

      {pixConflictAlerts.length > 0 && (
        <aside className="pix-conflict-notice" role="alert" aria-live="polite">
          <span className="pix-conflict-notice-icon" aria-hidden="true">
            <MdWarningAmber />
          </span>
          <div className="pix-conflict-notice-copy">
            <strong>
              {pixConflictAlerts.length === 1
                ? "Conflito na confirmação do PIX"
                : `${pixConflictAlerts.length} conflitos na confirmação do PIX`}
            </strong>
            <span>
              Confira {pixConflictOrderIds.size === 1 ? "o pedido indicado" : "os pedidos indicados"} antes de considerar o pagamento confirmado.
            </span>
          </div>
          {pixConflictOrderIds.size > 0 && (
            <div className="pix-conflict-order-list" aria-label="Pedidos relacionados aos conflitos PIX">
              {Array.from(pixConflictOrderIds).slice(0, 5).map((orderId) => (
                <span className="pix-conflict-order-chip" key={orderId}>
                  #{orderId}
                </span>
              ))}
              {pixConflictOrderIds.size > 5 && (
                <span className="pix-conflict-order-more">
                  +{pixConflictOrderIds.size - 5}
                </span>
              )}
            </div>
          )}
        </aside>
      )}

      {isSearching && (
        <div className="order-search-view">
          <div className="order-search-overview" aria-live="polite">
            <div className="order-search-overview-copy">
              <strong>Resultados por dia</strong>
              <span>
                {isToday
                  ? "Em Hoje, a busca inclui automaticamente hoje, ontem e anteontem."
                  : `A busca está limitada ao dia ${headerLabel}.`}
              </span>
            </div>

            <div className="order-search-days" aria-label="Quantidade de resultados por dia">
              {isToday ? (
                <>
                  <span className="order-search-day-pill order-search-day-pill--today">
                    Hoje <b>{searchResultsToday.length}</b>
                  </span>
                  <span className="order-search-day-pill">
                    Ontem <b>{searchResultsYesterday.length}</b>
                  </span>
                  <span className="order-search-day-pill order-search-day-pill--older">
                    Anteontem <b>{searchResultsDayBeforeYesterday.length}</b>
                  </span>
                </>
              ) : (
                <span className="order-search-day-pill order-search-day-pill--today">
                  {headerLabel} <b>{selectedDateSearchResults.length}</b>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        className={`lists${
          isSearching
            ? " lists--search"
            : showFutureView
              ? " lists--single"
              : fulfillmentFilter === "delivery"
                ? " lists--two"
                : " lists--three"
        }`}
      >
        {(
          (isSearching && pendingPaymentSearchResults.length > 0) ||
          (!isSearching && pendingPaymentOrders.length > 0)
        ) && (
          <section
            className="order-section order-section--payment"
            aria-label="Pedidos aguardando confirmação do PIX"
          >
            <OrdersList
              data={isSearching ? pendingPaymentSearchResults : pendingPaymentOrders}
              statusFilter={isSearching ? "search" : 1}
              selectedDate={selectedDay}
              searchTerm={isSearching ? normalizedSearch : ""}
              onClearSearch={clearSearch}
              title="Aguardando PIX"
              description="Visível para conferência, ainda fora da expedição"
              tone="payment"
              pixConflictOrderIds={pixConflictOrderIds}
              pixConflictAlertsByOrderId={pixConflictAlertsByOrderId}
              onLinkPixToOrder={handleLinkPixToOrder}
              linkingPixKey={linkingPixKey}
              tripSelectionBlocked={hasActiveTripDraft}
            />
          </section>
        )}

        <section
          className={
            isSearching
              ? "order-section order-search-day order-search-day--today"
              : showFutureView
                ? "order-section order-section--scheduled"
                : "order-section order-section--pending"
          }
          aria-label={
            isSearching
              ? "Pedidos aguardando encontrados"
              : showFutureView
                ? `Agendados para ${headerLabel}`
                : acceptedTitle
          }
        >
          <OrdersList
            agendado={!isSearching && showFutureView}
            data={isSearching ? selectableSearchResults : pedidosDoPeriodoFiltrados}
            tripSourceData={tripSourceData}
            statusFilter={isSearching ? "selection-search" : 2}
            selectedDate={selectedDay}
            searchTerm={searchTerm}
            onClearSearch={clearSearch}
            title={
              isSearching
                ? "Aguardando encontrados"
                : showFutureView
                  ? `Agendados para ${headerLabel}`
                  : acceptedTitle
            }
            description={
              isSearching
                ? "Pedidos ainda aguardando despacho ou preparo"
                : showFutureView
                  ? "Pedidos programados para esta data"
                  : acceptedDescription
            }
            tone={isSearching ? "search" : showFutureView ? "scheduled" : "pending"}
            pixConflictOrderIds={pixConflictOrderIds}
            pixConflictAlertsByOrderId={pixConflictAlertsByOrderId}
            onLinkPixToOrder={handleLinkPixToOrder}
            linkingPixKey={linkingPixKey}
            tripSelectionBlocked={hasActiveTripDraft}
            onTripDraftChange={handleTripDraftChange}
          />
        </section>

        {(
          (isSearching && readyPickupSearchResults.length > 0) ||
          (!isSearching && !showFutureView && fulfillmentFilter !== "delivery")
        ) && (
          <section
            className={isSearching
              ? "order-section order-search-day order-search-day--ready"
              : "order-section order-section--ready"
            }
            aria-label="Retiradas prontas"
          >
            <OrdersList
              data={isSearching ? readyPickupSearchResults : pedidosDoPeriodoFiltrados}
              statusFilter={isSearching ? "search" : 3}
              selectedDate={selectedDay}
              searchTerm={isSearching ? normalizedSearch : ""}
              onClearSearch={clearSearch}
              title={isSearching ? "Retiradas prontas encontradas" : "Retiradas prontas"}
              description={isSearching ? "Pedido do app cliente aguardando no balcão" : "Pedido do app cliente aguardando o cliente buscar"}
              tone="ready"
              pixConflictOrderIds={pixConflictOrderIds}
              pixConflictAlertsByOrderId={pixConflictAlertsByOrderId}
              onLinkPixToOrder={handleLinkPixToOrder}
              linkingPixKey={linkingPixKey}
              tripSelectionBlocked={hasActiveTripDraft}
            />
          </section>
        )}

        {isSearching ? (
          <>
            {isToday && completedSearchResultsToday.length > 0 && (
              <section
                className="order-section order-search-day order-search-day--today"
                aria-label={`Pedidos que saíram hoje, ${formatDateDay(recentSearchDates.today)}`}
              >
                <OrdersList
                  data={completedSearchResultsToday}
                  statusFilter="search"
                  selectedDate={recentSearchDates.today}
                  searchTerm={normalizedSearch}
                  onClearSearch={clearSearch}
                  title="Saíram hoje"
                  description={formatDateDay(recentSearchDates.today)}
                  tone="completed"
                  pixConflictOrderIds={pixConflictOrderIds}
                  pixConflictAlertsByOrderId={pixConflictAlertsByOrderId}
                  onLinkPixToOrder={handleLinkPixToOrder}
                  linkingPixKey={linkingPixKey}
                  tripSelectionBlocked={hasActiveTripDraft}
                />
              </section>
            )}

            {isToday && completedSearchResultsYesterday.length > 0 && (
              <section
                className="order-section order-search-day order-search-day--yesterday"
                aria-label={`Pedidos que saíram ontem, ${formatDateDay(recentSearchDates.yesterday)}`}
              >
                <OrdersList
                  data={completedSearchResultsYesterday}
                  statusFilter="search"
                  selectedDate={recentSearchDates.yesterday}
                  searchTerm={normalizedSearch}
                  onClearSearch={clearSearch}
                  title="Saíram ontem"
                  description={formatDateDay(recentSearchDates.yesterday)}
                  tone="completed"
                  pixConflictOrderIds={pixConflictOrderIds}
                  pixConflictAlertsByOrderId={pixConflictAlertsByOrderId}
                  onLinkPixToOrder={handleLinkPixToOrder}
                  linkingPixKey={linkingPixKey}
                  tripSelectionBlocked={hasActiveTripDraft}
                />
              </section>
            )}

            {isToday && completedSearchResultsDayBeforeYesterday.length > 0 && (
              <section
                className="order-section order-search-day order-search-day--older"
                aria-label={`Pedidos que saíram em anteontem, ${formatDateDay(recentSearchDates.dayBeforeYesterday)}`}
              >
                <OrdersList
                  data={completedSearchResultsDayBeforeYesterday}
                  statusFilter="search"
                  selectedDate={recentSearchDates.dayBeforeYesterday}
                  searchTerm={normalizedSearch}
                  onClearSearch={clearSearch}
                  title="Saíram em anteontem"
                  description={formatDateDay(recentSearchDates.dayBeforeYesterday)}
                  tone="completed"
                  pixConflictOrderIds={pixConflictOrderIds}
                  pixConflictAlertsByOrderId={pixConflictAlertsByOrderId}
                  onLinkPixToOrder={handleLinkPixToOrder}
                  linkingPixKey={linkingPixKey}
                  tripSelectionBlocked={hasActiveTripDraft}
                />
              </section>
            )}

            {!isToday && completedSearchResultsSelectedDate.length > 0 && (
              <section
                className="order-section order-search-day order-search-day--today"
                aria-label={`Pedidos finalizados em ${headerLabel}`}
              >
                <OrdersList
                  data={completedSearchResultsSelectedDate}
                  statusFilter="search"
                  selectedDate={selectedDay}
                  searchTerm={normalizedSearch}
                  onClearSearch={clearSearch}
                  title={`Finalizados em ${headerLabel}`}
                  description="Busca limitada à data selecionada"
                  tone="completed"
                  pixConflictOrderIds={pixConflictOrderIds}
                  pixConflictAlertsByOrderId={pixConflictAlertsByOrderId}
                  onLinkPixToOrder={handleLinkPixToOrder}
                  linkingPixKey={linkingPixKey}
                  tripSelectionBlocked={hasActiveTripDraft}
                />
              </section>
            )}
          </>
        ) : !showFutureView ? (
          <section
            className="order-section order-section--completed"
            aria-label={completedTitle}
          >
            <OrdersList
              data={pedidosDoPeriodoFiltrados}
              statusFilter={5}
              selectedDate={selectedDay}
              searchTerm=""
              onClearSearch={clearSearch}
              title={completedTitle}
              description={completedDescription}
              tone="completed"
              pixConflictOrderIds={pixConflictOrderIds}
              pixConflictAlertsByOrderId={pixConflictAlertsByOrderId}
              onLinkPixToOrder={handleLinkPixToOrder}
              linkingPixKey={linkingPixKey}
              tripSelectionBlocked={hasActiveTripDraft}
            />
          </section>
        ) : null}
      </div>
    </div>
  );
};

export default OrderDashboard;
