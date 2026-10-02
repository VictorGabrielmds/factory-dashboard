// src/components/OrdersList/OrdersList.tsx
import { useEffect, useState, useCallback, useMemo, useRef, useId } from "react";
import "./OrdersList.css";
import {
  collection,
  doc,
  runTransaction,
  increment,
  serverTimestamp,
  updateDoc,
  type DocumentData,
  getDocs,
} from "firebase/firestore";
import { db } from "../../services/firebase";
import type { Pedido } from "../../types/Pedido";
import { useToast } from "../../contexts/ToastContext";
import { MdDateRange, MdAccessTime, MdInbox, MdWarningAmber, MdOutlinePayments } from "react-icons/md";
import OrderCard from "../OrderCard/OrderCard";
import { BsX as X } from "react-icons/bs";
import ModalBase from "../ModalBase/ModalBase";
import { ehPedidoDelivery, ehRetiradaDoAppCliente } from "../CozinhaDashboard/cozinhaHelpers";
import { PedidoStatus } from "../../types/Pedido";
import type { PixConflictAlert } from "../../hooks/usePixConflictAlerts";
import { filtrarPedidosDaBuscaPorDia, pedidoCorrespondeBusca } from "./ordersListSearch";
import {
  removeAccents,
  brDateToISO,
  dateToISOString,
  parseAgendamentoDate,
  parseBRDateTime,
  parseISODateTime,
  isSameDay,
  formatDate,
  formatDateDay,
  formatDateHour,
  normalizeName,
} from "../../utils/dateUtils";

// ------------------------------------
// Types
// ------------------------------------

type OrdersListProps = {
  statusFilter: number | "search" | "selection-search";
  selectedDate: Date;
  searchTerm: string;
  agendado?: boolean;
  data: Pedido[];
  tripSourceData?: Pedido[];
  title: string;
  description: string;
  tone: "payment" | "pending" | "ready" | "completed" | "scheduled" | "search";
  onClearSearch: () => void;
  pixConflictOrderIds?: ReadonlySet<string>;
  pixConflictAlertsByOrderId?: ReadonlyMap<string, readonly PixConflictAlert[]>;
  onLinkPixToOrder?: (alert: PixConflictAlert, orderId: string) => void;
  linkingPixKey?: string | null;
  tripSelectionBlocked?: boolean;
  onTripDraftChange?: (ownerId: string, active: boolean) => void;
};

interface Motoboy {
  id: string;
  nome: string;
  fixo: boolean;
  entregas: number;
  taxas: number;
}

type MachinePendency = {
  haveMachine: boolean;
  machineNumber: string;
};

// Modal flow steps
type ModalStep = "selection" | "confirm" | "saving";

const EMPTY_MACHINE_PENDENCY: MachinePendency = { haveMachine: false, machineNumber: "" };

function orderKey(orderId: string | number): string {
  return String(orderId);
}

// ✅ Detecta se um pedido foi pago no cartão (débito/crédito), pra avisar
// gentilmente que é bom levar maquininha. Cobre tanto texto ("cartão",
// "card"...) quanto códigos numéricos comuns nesse tipo de sistema.
// AJUSTE AQUI se os códigos do seu forma_pagamento forem diferentes de 02/03.
const CARD_TEXT_HINTS = ["cart", "card", "credito", "crédito", "debito", "débito"];
// Códigos conforme o dicionário oficial do sistema:
// 03 = crédito, 04 = débito, 42 = crédito online
const CARD_CODE_HINTS = ["03", "04", "42"];

function isCartaoPayment(forma?: string[] | string | null): boolean {
  if (!forma) return false;
  const values = Array.isArray(forma) ? forma : [forma];
  return values.some((v) => {
    const raw = String(v).trim().toLowerCase();
    if (CARD_CODE_HINTS.includes(raw)) return true;
    return CARD_TEXT_HINTS.some((hint) => raw.includes(hint));
  });
}

function isPixPayment(forma?: string[] | string | null): boolean {
  if (!forma) return false;
  const values = Array.isArray(forma) ? forma : [forma];
  return values.some((v) => {
    const raw = String(v).trim().toLowerCase();
    return raw === "17" || raw.includes("pix");
  });
}

function isScheduledAfterSelectedDate(order: Pedido, selectedDate: Date): boolean {
  const scheduledDate = parseAgendamentoDate(order.agendamento);
  return Boolean(
    scheduledDate && dateToISOString(scheduledDate) > dateToISOString(selectedDate)
  );
}

// ------------------------------------
// Component
// ------------------------------------

export default function OrdersList({
  data,
  tripSourceData,
  statusFilter,
  selectedDate,
  searchTerm,
  agendado = false,
  title,
  description,
  tone,
  onClearSearch,
  pixConflictOrderIds,
  pixConflictAlertsByOrderId,
  onLinkPixToOrder,
  linkingPixKey,
  tripSelectionBlocked = false,
  onTripDraftChange,
}: OrdersListProps) {
  const { addToast } = useToast();

  const [modalStep, setModalStep] = useState<ModalStep>("selection");
  const [isCreatingTrip, setIsCreatingTrip] = useState(false);
  const [isTripDraft, setIsTripDraft] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // ✅ Agora é um único estado de maquininha para a viagem/pedido em edição,
  // em vez de um dicionário por order_id. Isso reflete o que o código já fazia
  // na prática (só o primeiro pedido da viagem carregava a extra), e garante
  // que, se qualquer pedido da seleção tiver maquininha marcada, ela permanece
  // marcada para a viagem inteira.
  const [machinePendency, setMachinePendency] = useState<MachinePendency>(EMPTY_MACHINE_PENDENCY);

  const [motoboysData, setMotoboysData] = useState<Motoboy[]>([]);
  const [deliveryDate, setDeliveryDate] = useState<Date | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<Pedido[]>([]);
  const [selectedMotoboy, setSelectedMotoboy] = useState<Motoboy | null>(null);

  // ✅ Retirada não passa pelo fluxo de motoboy: modal próprio, só com
  // confirmação de "pronto" (o backend dispara a mensagem pro cliente
  // sozinho ao ver o status virar 3 — ver functions/src/webhooks/pedidos.js).
  const [pickupOrder, setPickupOrder] = useState<Pedido | null>(null);
  const [isPickupModalOpen, setIsPickupModalOpen] = useState(false);
  const [isMarkingPickupReady, setIsMarkingPickupReady] = useState(false);

  // ------------------------------------
  // Motoboy autocomplete state
  // ------------------------------------
  const [motoboyQuery, setMotoboyQuery] = useState("");
  const [showMotoboySuggestions, setShowMotoboySuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const motoboyBoxRef = useRef<HTMLDivElement>(null);
  const motoboyInputRef = useRef<HTMLInputElement>(null);
  const machineSwitchRef = useRef<HTMLInputElement>(null);
  const machineNumberRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);
  const tripDraftOwnerId = useId();

  // O dashboard usa este registro para garantir que só exista uma viagem em
  // montagem e para impedir que busca/período desmontem a lista sem querer.
  useEffect(() => {
    if (!isTripDraft || !onTripDraftChange) return;

    onTripDraftChange(tripDraftOwnerId, true);
    return () => onTripDraftChange(tripDraftOwnerId, false);
  }, [isTripDraft, onTripDraftChange, tripDraftOwnerId]);

  // ------------------------------------
  // Motoboys
  // ------------------------------------
  useEffect(() => {
    const fetchMotoboys = async () => {
      try {
        const snap = await getDocs(collection(db, "motoboys"));
        const lista = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Motoboy, "id">) }));
        setMotoboysData(lista);
      } catch (err) {
        console.error("Erro ao buscar motoboys:", err);
        addToast("Erro ao carregar lista de motoboys.", "error");
      }
    };
    fetchMotoboys();
  }, [addToast]);

  // Memoized lookup: normalized name → motoboy id
  const nameToIdMap = useMemo(
    () =>
      motoboysData.reduce<Record<string, string>>((acc, m) => {
        acc[normalizeName(m.nome)] = m.id;
        return acc;
      }, {}),
    [motoboysData]
  );

  // Lista filtrada pelo texto digitado (autocomplete estilo Google)
  const filteredMotoboys = useMemo(() => {
    const q = removeAccents(motoboyQuery.toLowerCase().trim());
    if (!q) return motoboysData;
    return motoboysData.filter((m) => removeAccents(m.nome.toLowerCase()).includes(q));
  }, [motoboysData, motoboyQuery]);

  // Garante que o índice destacado nunca fique fora da lista filtrada
  useEffect(() => {
    if (highlightedIndex >= filteredMotoboys.length) {
      setHighlightedIndex(0);
    }
  }, [filteredMotoboys, highlightedIndex]);

  // ✅ Fix: sempre que o modal abre, o input de motoboy recebe foco e o
  // texto já vem selecionado, pronto pra digitar por cima. Antes isso só
  // funcionava "de fábrica" na primeira vez (autofocus do navegador/do
  // ModalBase), e se perdia depois de qualquer interação — reabrir o modal
  // (ex: via "+ Adicionar pedidos" → "Concluir Viagem") deixava o campo sem
  // foco algum. Como o efeito depende só de isModalOpen (não de modalStep),
  // ele dispara exatamente uma vez por abertura e não rouba o foco de volta
  // depois que o usuário já escolheu o motoboy e está digitando o nº da
  // maquininha.
  useEffect(() => {
    if (!isModalOpen) return;
    const frame = requestAnimationFrame(() => {
      motoboyInputRef.current?.focus();
      motoboyInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [isModalOpen]);

  // Fecha as sugestões ao clicar fora do combobox
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (motoboyBoxRef.current && !motoboyBoxRef.current.contains(e.target as Node)) {
        setShowMotoboySuggestions(false);
      }
    };
    if (showMotoboySuggestions) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMotoboySuggestions]);

  // ------------------------------------
  // Filtering & sorting
  // ------------------------------------
  const filteredOrders = useMemo(() => {
    const selectedISO = dateToISOString(selectedDate);

    const matchesSearch = (p: Pedido) => pedidoCorrespondeBusca(p, searchTerm);

    if (statusFilter === "search") {
      return filtrarPedidosDaBuscaPorDia(data, selectedDate, searchTerm);
    }

    if (statusFilter === "selection-search") {
      return data
        .filter((pedido) => pedido.status === PedidoStatus.Aceito)
        .filter(matchesSearch)
        .sort(
          (a, b) =>
            parseISODateTime(b.data_venda).getTime() -
            parseISODateTime(a.data_venda).getTime()
        );
    }

    if (statusFilter === PedidoStatus.Recebido) {
      return data
        .filter((pedido) => pedido.status === PedidoStatus.Recebido)
        .filter((pedido) => isPixPayment(pedido.forma_pagamento))
        .filter((pedido) => {
          const agendDate = parseAgendamentoDate(pedido.agendamento);
          const orderISO = pedido.data_operacional || pedido.data_venda?.split(" ")[0] || "";

          if (agendDate) {
            if (isSameDay(agendDate, selectedDate)) return true;
            return (
              isSameDay(selectedDate, new Date()) &&
              pedido.data_venda?.split(" ")[0] === selectedISO &&
              isScheduledAfterSelectedDate(pedido, selectedDate)
            );
          }
          return orderISO === selectedISO;
        })
        .filter(matchesSearch)
        .sort(
          (a, b) =>
            parseISODateTime(b.data_venda).getTime() - parseISODateTime(a.data_venda).getTime()
        );
    }

    if (statusFilter === 2) {
      return data
        .filter((p) => p.status === 2)
        .filter((p) => {
          const agendDate = parseAgendamentoDate(p.agendamento);
          const orderISO = p.data_venda?.split(" ")[0] ?? "";

          if (agendDate) {
            if (isSameDay(agendDate, selectedDate)) return true;

            // O agendamento continua aparecendo no dia previsto, mas um
            // pedido criado hoje para o futuro também precisa ficar visível
            // hoje, identificado pela faixa de agendamento no card.
            return (
              isSameDay(selectedDate, new Date()) &&
              orderISO === selectedISO &&
              isScheduledAfterSelectedDate(p, selectedDate)
            );
          }
          if (agendado) return false;
          return orderISO === selectedISO;
        })
        .filter(matchesSearch)
        .sort(
          (a, b) =>
            parseISODateTime(b.data_venda).getTime() - parseISODateTime(a.data_venda).getTime()
        );
    }

    if (statusFilter === PedidoStatus.Pronto) {
      return data
        .filter((p) => p.status === PedidoStatus.Pronto && ehRetiradaDoAppCliente(p))
        .filter((p) => {
          const agendDate = parseAgendamentoDate(p.agendamento);
          if (agendDate) return isSameDay(agendDate, selectedDate);
          const orderISO = p.data_venda?.split(" ")[0] ?? "";
          return orderISO === selectedISO;
        })
        .filter(matchesSearch)
        .sort(
          (a, b) =>
            parseISODateTime(b.data_venda).getTime() - parseISODateTime(a.data_venda).getTime()
        );
    }

    // statusFilter === 5
    return data
      .filter((p) => p.status === 5)
      .filter((p) => !p.avulso)
      .filter((p) => {
        if (!p.data_saida) return false;
        const rawDate = p.data_saida.split(" às")[0].trim();
        return brDateToISO(rawDate) === selectedISO;
      })
      .filter(matchesSearch)
      .sort((a, b) => parseBRDateTime(b.data_saida).getTime() - parseBRDateTime(a.data_saida).getTime());
  }, [data, searchTerm, selectedDate, statusFilter, agendado]);

  // ------------------------------------
  // Motoboy autocomplete helpers
  // ------------------------------------
  const selectMotoboy = useCallback(
    (m: Motoboy) => {
      setSelectedMotoboy(m);
      setMotoboyQuery(m.nome);
      setShowMotoboySuggestions(false);

      // ✅ Ao confirmar o motoboy (Enter ou clique), o campo de maquininha
      // já recebe o foco pronto pra digitar — se a maquininha já estiver
      // marcada (porque algum pedido da viagem já tinha), vai direto pro
      // número; senão, foca o próprio switch pra ligar com espaço/enter.
      requestAnimationFrame(() => {
        if (machinePendency.haveMachine) {
          machineNumberRef.current?.focus();
          machineNumberRef.current?.select();
        } else {
          machineSwitchRef.current?.focus();
        }
      });
    },
    [machinePendency.haveMachine]
  );

  const handleMotoboyInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMotoboyQuery(e.target.value);
    setSelectedMotoboy(null);
    setShowMotoboySuggestions(true);
    setHighlightedIndex(0);
  };

  const handleMotoboyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showMotoboySuggestions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setShowMotoboySuggestions(true);
      return;
    }
    if (filteredMotoboys.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev + 1) % filteredMotoboys.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev - 1 + filteredMotoboys.length) % filteredMotoboys.length);
        break;
      case "Enter": {
        if (!showMotoboySuggestions) break;
        e.preventDefault();
        const chosen = filteredMotoboys[highlightedIndex] ?? filteredMotoboys[0];
        if (chosen) selectMotoboy(chosen);
        break;
      }
      case "Escape":
        setShowMotoboySuggestions(false);
        break;
      default:
        break;
    }
  };

  // ------------------------------------
  // Modal helpers
  // ------------------------------------
  const openModalForOrder = useCallback(
    (order: Pedido) => {
      // Retirada não escolhe motoboy: só confirma que o pedido está pronto.
      if (!ehPedidoDelivery(order)) {
        setPickupOrder(order);
        setIsPickupModalOpen(true);
        return;
      }

      const motoboyAtual = motoboysData.find(
        (m) =>
          m.id === order.motoboy_id ||
          normalizeName(m.nome) === normalizeName(order.motoboy_id ?? "")
      ) ?? null;

      isSavingRef.current = false;
      setSelectedOrders([order]);
      setSelectedMotoboy(motoboyAtual);
      setMotoboyQuery(motoboyAtual?.nome ?? "");
      setShowMotoboySuggestions(false);
      setIsEditing(Boolean(order.motoboy_id));
      setDeliveryDate(new Date());
      setMachinePendency(EMPTY_MACHINE_PENDENCY);
      setModalStep("selection");
      setIsCreatingTrip(false);
      setIsTripDraft(false);
      setIsModalOpen(true);
    },
    [motoboysData]
  );

  const resetDispatchState = useCallback(() => {
    isSavingRef.current = false;
    setIsModalOpen(false);
    setSelectedOrders([]);
    setSelectedMotoboy(null);
    setMotoboyQuery("");
    setShowMotoboySuggestions(false);
    setMachinePendency(EMPTY_MACHINE_PENDENCY);
    setDeliveryDate(null);
    setIsEditing(false);
    setModalStep("selection");
    setIsCreatingTrip(false);
    setIsTripDraft(false);
  }, []);

  const dismissDispatchModal = useCallback(() => {
    if (modalStep === "saving" || isSavingRef.current) return;

    // Fechar o modal de uma viagem não significa descartá-la. Esc, X e clique
    // no fundo voltam à lista com todos os pedidos e escolhas preservados.
    if (isTripDraft) {
      setIsModalOpen(false);
      setShowMotoboySuggestions(false);
      setModalStep("selection");
      setIsCreatingTrip(true);
      return;
    }

    resetDispatchState();
  }, [isTripDraft, modalStep, resetDispatchState]);

  const closePickupModal = useCallback(() => {
    if (isMarkingPickupReady) return;
    setIsPickupModalOpen(false);
    setPickupOrder(null);
  }, [isMarkingPickupReady]);

  // Só marca status: 3 — o gatilho do backend (notificarStatusPedido) é quem
  // detecta a mudança e manda a mensagem "pronto_para_retirada" ao cliente.
  const confirmPickupReady = useCallback(async () => {
    if (!pickupOrder) return;
    setIsMarkingPickupReady(true);
    try {
      await updateDoc(doc(db, "pedidos", String(pickupOrder.order_id)), {
        status: PedidoStatus.Pronto,
      });
      addToast(`Pedido ${pickupOrder.order_id} marcado como pronto para retirada.`, "success");
      setIsPickupModalOpen(false);
      setPickupOrder(null);
    } catch (err) {
      console.error("Erro ao marcar pedido como pronto:", err);
      addToast("Erro ao marcar pedido como pronto. Tente novamente.", "error");
    } finally {
      setIsMarkingPickupReady(false);
    }
  }, [pickupOrder, addToast]);

  const concludeTrip = useCallback(() => {
    if (selectedOrders.length === 0) return;
    setIsCreatingTrip(false);
    setIsTripDraft(true);
    setDeliveryDate(new Date());
    setModalStep("selection");
    setIsModalOpen(true);
  }, [selectedOrders.length]);

  const beginTripSelectionWithOrder = useCallback((order: Pedido) => {
    if (tripSelectionBlocked && !isTripDraft) return;
    if (order.status !== PedidoStatus.Aceito || !ehPedidoDelivery(order)) return;

    isSavingRef.current = false;
    setSelectedOrders([order]);
    setSelectedMotoboy(null);
    setMotoboyQuery("");
    setShowMotoboySuggestions(false);
    setMachinePendency(EMPTY_MACHINE_PENDENCY);
    setDeliveryDate(null);
    setIsEditing(false);
    setModalStep("selection");
    setIsModalOpen(false);
    setIsTripDraft(true);
    setIsCreatingTrip(true);
  }, [isTripDraft, tripSelectionBlocked]);

  const beginEmptyTripSelection = useCallback(() => {
    if (tripSelectionBlocked && !isTripDraft) return;

    isSavingRef.current = false;
    setSelectedOrders([]);
    setSelectedMotoboy(null);
    setMotoboyQuery("");
    setShowMotoboySuggestions(false);
    setMachinePendency(EMPTY_MACHINE_PENDENCY);
    setDeliveryDate(null);
    setIsEditing(false);
    setModalStep("selection");
    setIsModalOpen(false);
    setIsTripDraft(true);
    setIsCreatingTrip(true);
  }, [isTripDraft, tripSelectionBlocked]);

  const cancelTripSelection = useCallback(() => {
    if (
      selectedOrders.length > 0 &&
      !window.confirm(
        `Descartar esta viagem com ${selectedOrders.length} pedido${selectedOrders.length === 1 ? "" : "s"} selecionado${selectedOrders.length === 1 ? "" : "s"}?`
      )
    ) {
      return;
    }

    resetDispatchState();
  }, [resetDispatchState, selectedOrders.length]);

  // ✅ Reabre a lista de pedidos em modo de seleção SEM perder nada do que
  // já foi escolhido (pedidos, motoboy, maquininha). É essa função que
  // resolve o travamento: agora ela fica disponível mesmo com uma viagem
  // de vários pedidos já montada.
  const startTripSelection = useCallback(() => {
    setIsTripDraft(true);
    setIsCreatingTrip(true);
    setIsModalOpen(false);
  }, []);

  const toggleOrderSelection = useCallback((order: Pedido) => {
    const id = orderKey(order.order_id);
    setSelectedOrders((prev) =>
      prev.some((p) => orderKey(p.order_id) === id)
        ? prev.filter((p) => orderKey(p.order_id) !== id)
        : [...prev, order]
    );
  }, []);

  const removeOrderFromTrip = useCallback((orderId: string | number) => {
    const id = orderKey(orderId);
    setSelectedOrders((prev) => prev.filter((p) => orderKey(p.order_id) !== id));
  }, []);

  // Mantém os dados dos selecionados atualizados sem derrubar a viagem quando
  // chega um snapshot novo. Se outro operador já tirou um pedido do status
  // Aceito, removemos somente aquele item e avisamos — o restante permanece.
  useEffect(() => {
    if (!isTripDraft || selectedOrders.length === 0) return;

    const sourceData = tripSourceData ?? data;
    const latestById = new Map(
      sourceData.map((order) => [orderKey(order.order_id), order])
    );
    const unavailableIds = selectedOrders
      .filter((order) => {
        const latest = latestById.get(orderKey(order.order_id));
        return (
          !latest ||
          latest.status !== PedidoStatus.Aceito ||
          !ehPedidoDelivery(latest)
        );
      })
      .map((order) => orderKey(order.order_id));

    if (unavailableIds.length > 0) {
      const unavailable = new Set(unavailableIds);
      setSelectedOrders((current) =>
        current.filter((order) => !unavailable.has(orderKey(order.order_id)))
      );
      if (!isSavingRef.current) {
        setModalStep("selection");
      }
      addToast(
        unavailableIds.length === 1
          ? `O pedido ${unavailableIds[0]} não está mais disponível e foi removido da viagem.`
          : `${unavailableIds.length} pedidos não estão mais disponíveis e foram removidos da viagem.`,
        "info"
      );
      return;
    }

    setSelectedOrders((current) => {
      let changed = false;
      const next = current.map((order) => {
        const latest = latestById.get(orderKey(order.order_id));
        if (latest && latest !== order) {
          changed = true;
          return latest;
        }
        return order;
      });
      return changed ? next : current;
    });
  }, [addToast, data, isTripDraft, selectedOrders, tripSourceData]);

  useEffect(() => {
    if (!isCreatingTrip) return;

    const isTypingTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return (
        element?.tagName === "INPUT" ||
        element?.tagName === "TEXTAREA" ||
        element?.tagName === "SELECT" ||
        element?.isContentEditable === true
      );
    };

    const handleTripShortcut = (event: KeyboardEvent) => {
      if (isModalOpen || isPickupModalOpen) return;

      if (event.key === "Escape") {
        event.preventDefault();
        cancelTripSelection();
        return;
      }

      if (isTypingTarget(event.target)) return;

      if (
        (event.ctrlKey || event.metaKey) &&
        event.code === "KeyX"
      ) {
        event.preventDefault();
        if (selectedOrders.length === 0) {
          addToast("Selecione pelo menos um pedido para fechar a viagem.", "info");
          return;
        }
        concludeTrip();
      }
    };

    document.addEventListener("keydown", handleTripShortcut);
    return () => document.removeEventListener("keydown", handleTripShortcut);
  }, [
    addToast,
    cancelTripSelection,
    concludeTrip,
    isCreatingTrip,
    isModalOpen,
    isPickupModalOpen,
    selectedOrders.length,
  ]);

  // ------------------------------------
  // Validation
  // ------------------------------------
  const machineIsRequired = machinePendency.haveMachine === true;
  const machineNumberIsValid =
    !machineIsRequired ||
    (machinePendency.machineNumber !== "" && Number(machinePendency.machineNumber) > 0);

  const canContinue =
    selectedMotoboy !== null &&
    selectedOrders.length > 0 &&
    machineNumberIsValid &&
    modalStep !== "saving";

  // ✅ Se algum pedido da viagem foi pago no cartão, isso vira só um aviso
  // gentil pra lembrar de levar a maquininha — nunca bloqueia o "Continuar".
  const hasCardOrder = useMemo(
    () => selectedOrders.some((p) => isCartaoPayment(p.forma_pagamento)),
    [selectedOrders]
  );

  // PIX ainda não confirmado pelo Asaas: aviso forte na hora de despachar —
  // mandar o pedido pra rua sem o pagamento cair é prejuízo direto.
  const pixNaoPagos = useMemo(
    () => selectedOrders.filter((p) => {
      if (!isPixPayment(p.forma_pagamento)) return false;
      const status = String(p.pix_status || (p.pix_confirmado ? "RECEIVED" : "PENDING")).toUpperCase();
      return p.pix_confirmado !== true || status !== "RECEIVED";
    }),
    [selectedOrders]
  );

  // ------------------------------------
  // Firebase batch update
  // ------------------------------------
  const updateOrderStatus = async () => {
    if (
      isSavingRef.current ||
      modalStep === "saving" ||
      !deliveryDate ||
      !selectedMotoboy ||
      selectedOrders.length === 0
    ) {
      return;
    }

    isSavingRef.current = true;
    setModalStep("saving");

    const newMotoboyId   = selectedMotoboy.id;
    const newMotoboyNorm = normalizeName(selectedMotoboy.nome);
    const formattedDate  = formatDate(deliveryDate);
    const ordersParaEnviar = selectedOrders;
    const machinePendencyParaEnviar = machinePendency;
    const nomeMotoboy = selectedMotoboy.nome;

    try {
      // Transação em vez de writeBatch: precisamos LER o status atual de cada
      // pedido antes de decidir se ainda é seguro despachar. Sem isso, dois
      // operadores despachando o mesmo pedido pra motoboys diferentes quase
      // ao mesmo tempo terminavam em last-write-wins silencioso — e o
      // motoboy "perdedor" ainda ficava com taxa/entrega contabilizada por
      // engano, porque o increment() do lado dele já tinha sido aplicado.
      await runTransaction(db, async (tx) => {
        const pedidoRefs = ordersParaEnviar.map((order) => doc(db, "pedidos", String(order.order_id)));
        const pedidoSnaps = await Promise.all(pedidoRefs.map((ref) => tx.get(ref)));

        const resolvePrevMotoboyId = (field?: string | null): string | undefined => {
          if (!field) return undefined;
          if (motoboysData.some((m) => m.id === field)) return field;
          return nameToIdMap[normalizeName(field)];
        };

        // Editar um pedido já despachado (status 5) pra TROCAR o motoboy é uso
        // legítimo — é exatamente pra isso que o botão "Editar" existe, e
        // nesse caso o motoboy escolhido é sempre diferente do que já está
        // gravado. O que precisa ser barrado é outra coisa: ALGUÉM MAIS
        // (outro operador) ter mudado o motoboy entre a tela carregar e agora
        // — por isso a comparação é contra o motoboy que a TELA mostrava
        // quando o modal abriu (ordersParaEnviar[i].motoboy_id), não contra o
        // motoboy novo que o operador está escolhendo agora.
        for (let i = 0; i < pedidoSnaps.length; i++) {
          const dadosAtuais = pedidoSnaps[i].data();
          const statusAtual = Number(dadosAtuais?.status);
          const motoboyAtualId = resolvePrevMotoboyId(dadosAtuais?.motoboy_id as string | undefined);
          const motoboyEsperadoId = resolvePrevMotoboyId(ordersParaEnviar[i].motoboy_id);
          if (
            ordersParaEnviar[i].status === PedidoStatus.Aceito &&
            statusAtual !== PedidoStatus.Aceito
          ) {
            throw new Error(
              `O pedido ${ordersParaEnviar[i].order_id} não está mais disponível para esta viagem.`
            );
          }
          if (statusAtual === 5 && motoboyAtualId && motoboyEsperadoId && motoboyAtualId !== motoboyEsperadoId) {
            throw new Error(
              `O pedido ${ordersParaEnviar[i].order_id} já foi despachado para outro motoboy por alguém mais. Recarregue a lista.`
            );
          }
        }

        type AggEntry = {
          entregasDelta: number;
          taxasDelta: number;
          lastDelivery?: string;
          extras?: Record<string, unknown>;
        };

        const agg: Record<string, AggEntry> = {};

        const addAgg = (
          motId: string,
          entregasDelta: number,
          taxasDelta: number,
          extras?: Record<string, unknown>,
          lastDelivery?: string
        ) => {
          const prev = agg[motId] ?? { entregasDelta: 0, taxasDelta: 0 };
          agg[motId] = {
            entregasDelta: prev.entregasDelta + entregasDelta,
            taxasDelta:    prev.taxasDelta + taxasDelta,
            extras:        extras ? { ...(prev.extras ?? {}), ...extras } : prev.extras,
            lastDelivery:  lastDelivery ?? prev.lastDelivery,
          };
        };

        ordersParaEnviar.forEach((order, idx) => {
          tx.update(pedidoRefs[idx], {
            status:       5,
            motoboy_id:   newMotoboyId,
            motoboy_nome: newMotoboyNorm,
            data_saida:   formattedDate,
            data_operacional: dateToISOString(deliveryDate),
            data_saida_timestamp: serverTimestamp(),
          });

          // Usa o motoboy anterior lido AGORA (pedidoSnaps), não o que veio na
          // prop `data` quando a tela carregou — evita contabilizar troca pro
          // motoboy errado se o pedido mudou de mãos entre um render e outro.
          const dadosAtuais  = pedidoSnaps[idx].data();
          const taxa         = Number(order.valor_taxa) || 0;
          const prevMotId    = resolvePrevMotoboyId((dadosAtuais?.motoboy_id as string) ?? order.motoboy_id);
          const isSameMotoboy       = prevMotId === newMotoboyId;
          const isTransfer          = Boolean(prevMotId) && !isSameMotoboy;
          const isFirstAssignment   = !prevMotId;

          // Maquininha é gravada uma única vez, no primeiro pedido da viagem
          const extras = idx === 0 ? { [`extras.${order.order_id}`]: machinePendencyParaEnviar } : undefined;

          if (isTransfer) {
            addAgg(prevMotId!, -1, -taxa);
          }

          if (isTransfer || isFirstAssignment) {
            addAgg(newMotoboyId, 1, taxa, extras, formattedDate);
          } else if (isSameMotoboy) {
            addAgg(newMotoboyId, 0, 0, extras, formattedDate);
          }
        });

        for (const [motId, entry] of Object.entries(agg)) {
          const payload: Partial<DocumentData> = {};
          if (entry.entregasDelta !== 0) payload.entregas    = increment(entry.entregasDelta);
          if (entry.taxasDelta    !== 0) payload.taxas       = increment(entry.taxasDelta);
          if (entry.lastDelivery)        payload.lastDelivery = entry.lastDelivery;
          if (entry.extras)              Object.assign(payload, entry.extras);
          if (Object.keys(payload).length > 0) {
            tx.update(doc(db, "motoboys", motId), payload);
          }
        }
      });

      const qtd = ordersParaEnviar.length;
      addToast(
        `${qtd} pedido${qtd > 1 ? "s" : ""} enviado${qtd > 1 ? "s" : ""} para ${nomeMotoboy}.`,
        "success"
      );
      resetDispatchState();
    } catch (err) {
      console.error("Erro ao salvar pedidos:", err);
      const mensagem = err instanceof Error && (
        err.message.includes("já foi despachado") ||
        err.message.includes("não está mais disponível")
      )
        ? err.message
        : "Erro ao salvar. Tente novamente.";
      addToast(mensagem, "error");
      isSavingRef.current = false;
      setModalStep("confirm");
    }
  };

  // ------------------------------------
  // Pendency handlers (agora únicos, não mais por order_id)
  // ------------------------------------
  const handleMachineToggle = () => {
    setMachinePendency((prev) => {
      const next = !prev.haveMachine;
      if (next) {
        requestAnimationFrame(() => machineNumberRef.current?.focus());
      }
      return { haveMachine: next, machineNumber: next ? prev.machineNumber : "" };
    });
  };

  const handleMachineNumberChange = (value: string) => {
    setMachinePendency((prev) => ({ ...prev, machineNumber: value }));
  };

  // ------------------------------------
  // Modal title
  // ------------------------------------
  const modalTitle =
    modalStep === "saving"
      ? "Salvando..."
      : modalStep === "confirm"
      ? "Confirmar envio"
      : isEditing
      ? "Alterar motoboy"
      : "Selecionar motoboy";

  const hasSelectableOrder = filteredOrders.some(
    (order) =>
      order.status === PedidoStatus.Aceito &&
      ehPedidoDelivery(order) &&
      !isScheduledAfterSelectedDate(order, selectedDate)
  );
  const isTripInteractionLocked =
    isCreatingTrip || isTripDraft || tripSelectionBlocked;

  // ------------------------------------
  // Render
  // ------------------------------------
  return (
    <div className={isCreatingTrip ? "order-column batch" : "order-column"}>
      <header className={`order-column-header order-column-header--${tone}`}>
        <div className="order-column-heading">
          <span className="order-column-status" aria-hidden="true" />
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        </div>
        <div className="order-column-header-actions">
          {!agendado && hasSelectableOrder && !isCreatingTrip && (
            <button
              type="button"
              className="btn-start-trip"
              onClick={beginEmptyTripSelection}
              disabled={tripSelectionBlocked}
              title={
                tripSelectionBlocked
                  ? "Finalize ou descarte a viagem em andamento"
                  : "Selecionar pedidos para uma viagem"
              }
            >
              Montar viagem
            </button>
          )}
          <span
            className="order-column-count"
            aria-label={`${filteredOrders.length} pedido${filteredOrders.length === 1 ? "" : "s"}`}
            aria-live="polite"
          >
            {filteredOrders.length}
          </span>
        </div>
      </header>

      {filteredOrders.length === 0 && (
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            <MdInbox />
          </span>
          <strong>{searchTerm ? "Nenhum cliente encontrado" : "Tudo certo por aqui"}</strong>
          <p>
            {searchTerm
              ? `Não encontramos pedidos para “${searchTerm}”.`
              : "Nenhum pedido para exibir neste período."}
          </p>
          {searchTerm && (
            <button type="button" onClick={onClearSearch} disabled={tripSelectionBlocked}>
              Limpar busca
            </button>
          )}
        </div>
      )}

      {filteredOrders.map((pedido) => {
        const scheduledForLater = isScheduledAfterSelectedDate(pedido, selectedDate);

        return (
          <OrderCard
            key={pedido.order_id}
            openModal={openModalForOrder}
            orderData={pedido}
            toggleOrderSelection={toggleOrderSelection}
            startTripSelectionWithOrder={beginTripSelectionWithOrder}
            canStartTripSelection={!agendado && !tripSelectionBlocked && !scheduledForLater}
            isScheduledForFuture={scheduledForLater}
            isTripInteractionLocked={isTripInteractionLocked}
            selectedDate={selectedDate}
            hasPixConflict={pixConflictOrderIds?.has(String(pedido.order_id)) ?? false}
            pixConflictAlerts={
              pixConflictAlertsByOrderId?.get(String(pedido.order_id)) ?? []
            }
            onLinkPixToOrder={onLinkPixToOrder}
            linkingPixKey={linkingPixKey}
            isCreatingTrip={isCreatingTrip}
            isThisOrderSelectedForTrip={selectedOrders.some(
              (p) => orderKey(p.order_id) === orderKey(pedido.order_id)
            )}
          />
        );
      })}

      {/* Barra de despacho da viagem */}
      {isCreatingTrip && (
        <div className="fab-bar">
          <div className="trip-selection-summary" aria-live="polite">
            <strong>Modo seleção</strong>
            <span>
              {selectedOrders.length} pedido{selectedOrders.length === 1 ? "" : "s"} selecionado{selectedOrders.length === 1 ? "" : "s"}
            </span>
          </div>
          <button
            className="fab-cancel"
            onClick={cancelTripSelection}
            aria-keyshortcuts="Escape"
          >
            Cancelar
          </button>
          <button
            className="fab-conclude"
            onClick={concludeTrip}
            disabled={selectedOrders.length === 0}
            aria-keyshortcuts="Control+X"
          >
            Fechar viagem
            <kbd>Ctrl + X</kbd>
          </button>
        </div>
      )}

      <ModalBase
        isOpen={isModalOpen}
        title={modalTitle}
        onClose={dismissDispatchModal}
        closeDisabled={modalStep === "saving"}
      >
        <div className="delivery-modal">

          {/* Step: saving */}
          {modalStep === "saving" && (
            <div className="modal-saving">
              <div className="spinner" aria-label="Salvando..." />
              <p>Salvando pedido{selectedOrders.length > 1 ? "s" : ""}...</p>
            </div>
          )}

          {/* Step: confirm */}
          {modalStep === "confirm" && (
            <div className="modal-form confirm-summary">
              <p className="confirm-lead">
                Confirma o envio de{" "}
                <strong>
                  {selectedOrders.length} pedido{selectedOrders.length > 1 ? "s" : ""}
                </strong>{" "}
                para <strong>{selectedMotoboy?.nome}</strong>?
              </p>
              {deliveryDate && (
                <p className="sub-info confirm-time">
                  Saída às <strong>{formatDateHour(deliveryDate)}</strong>
                </p>
              )}
              {machinePendency.haveMachine && (
                <p className="sub-info confirm-time">
                  Maquininha nº <strong>{machinePendency.machineNumber}</strong>
                </p>
              )}
              {pixNaoPagos.length > 0 && (
                <p className="pix-unpaid-hint" role="alert">
                  <MdWarningAmber aria-hidden="true" /> {pixNaoPagos.length === 1 ? "1 pedido PIX não está liberado como pago" : `${pixNaoPagos.length} pedidos PIX não estão liberados como pagos`}: <strong>{pixNaoPagos.map((p) => `#${p.order_id}`).join(", ")}</strong>
                </p>
              )}
              <ol className="order-trip-list">
                {selectedOrders.map((p) => (
                  <li key={p.order_id}>
                    <strong>{p.order_id}</strong> — {p.nome_destinatario}
                    {p.bairro_destinatario ? ` (${p.bairro_destinatario})` : ""}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Step: selection */}
          {modalStep === "selection" && (
            <div className="modal-form">
              {/* Date/time summary */}
              {deliveryDate && (
                <div className="modal-datetime">
                  <span className="sub-info">
                    <MdDateRange aria-hidden="true" /> {formatDateDay(deliveryDate)}
                  </span>
                  <span className="sub-info">
                    <MdAccessTime aria-hidden="true" /> {formatDateHour(deliveryDate)}
                  </span>
                </div>
              )}

              {/* Motoboy autocomplete (estilo Google) */}
              <label htmlFor="motoboy-input" className="field-label">
                Motoboy
              </label>
              <div className="motoboy-autocomplete" ref={motoboyBoxRef}>
                <input
                  id="motoboy-input"
                  ref={motoboyInputRef}
                  type="text"
                  role="combobox"
                  aria-expanded={showMotoboySuggestions}
                  aria-autocomplete="list"
                  aria-controls="motoboy-listbox"
                  autoComplete="off"
                  placeholder="Digite o nome do motoboy"
                  value={motoboyQuery}
                  onChange={handleMotoboyInputChange}
                  onFocus={(e) => {
                    setShowMotoboySuggestions(true);
                    e.target.select();
                  }}
                  onKeyDown={handleMotoboyKeyDown}
                />
                {showMotoboySuggestions && (
                  <ul className="motoboy-suggestions" id="motoboy-listbox" role="listbox">
                    {filteredMotoboys.length === 0 && (
                      <li className="motoboy-suggestion-empty" aria-disabled="true">
                        Nenhum motoboy encontrado
                      </li>
                    )}
                    {filteredMotoboys.map((m, i) => (
                      <li
                        key={m.id}
                        role="option"
                        aria-selected={i === highlightedIndex}
                        className={i === highlightedIndex ? "highlighted" : ""}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectMotoboy(m);
                        }}
                        onMouseEnter={() => setHighlightedIndex(i)}
                      >
                        {m.nome}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Machine toggle — vale para a viagem toda */}
              {selectedOrders.length > 0 && (
                <div className="switch-group">
                  <label className="switch-label" htmlFor="machine-toggle">
                    Maquininha
                  </label>
                  <label className="switch">
                    <input
                      id="machine-toggle"
                      ref={machineSwitchRef}
                      type="checkbox"
                      checked={machinePendency.haveMachine}
                      onChange={handleMachineToggle}
                    />
                    <span className="slider" />
                  </label>
                  {machinePendency.haveMachine && (
                    <input
                      ref={machineNumberRef}
                      className="machine-number"
                      type="number"
                      min="1"
                      placeholder="Nº"
                      value={machinePendency.machineNumber}
                      onChange={(e) => handleMachineNumberChange(e.target.value)}
                      aria-label="Número da maquininha"
                    />
                  )}
                </div>
              )}

              {/* Lembrete gentil: não bloqueia nada, só avisa */}
              {hasCardOrder && !machinePendency.haveMachine && (
                <p className="card-payment-hint">
                  <MdOutlinePayments aria-hidden="true" /> Um dos pedidos dessa viagem foi pago no cartão — não esqueça a maquininha.
                </p>
              )}

              {pixNaoPagos.length > 0 && (
                <p className="pix-unpaid-hint" role="alert">
                  <MdWarningAmber aria-hidden="true" /> PIX pendente ou com estorno:{" "}
                  <strong>{pixNaoPagos.map((p) => `#${p.order_id}`).join(", ")}</strong>.
                  Confira o pagamento antes de enviar.
                </p>
              )}

              {/* Trip order list (when multiple selected) */}
              {selectedOrders.length > 1 && (
                <div className="order-trip-list">
                  <p className="trip-list-title">
                    Viagem — {selectedOrders.length} pedidos
                  </p>
                  {selectedOrders.map((p) => (
                    <div key={p.order_id} className="trip-list-item">
                      <span>
                        <strong>{p.order_id}</strong> — {p.nome_destinatario}
                      </span>
                      <button
                        className="btn-remove"
                        onClick={() => removeOrderFromTrip(p.order_id)}
                        aria-label={`Remover pedido ${p.order_id} da viagem`}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal footer buttons */}
        <div className="modal-buttons">
          {modalStep === "confirm" && (
            <>
              <button
                className="btn-secondary"
                onClick={() => setModalStep("selection")}
              >
                Voltar
              </button>
              <button
                className="btn-primary"
                onClick={updateOrderStatus}
                disabled={selectedOrders.length === 0}
              >
                Confirmar
              </button>
            </>
          )}

          {modalStep === "selection" && (
            <>
              {/* ✅ Fix: agora aparece pra QUALQUER quantidade de pedidos já
                  selecionados (não só quando tem exatamente 1), então dá pra
                  voltar e adicionar/remover pedidos da viagem mesmo depois
                  de ter clicado em "Concluir Viagem" e faltar algo. */}
              {!isCreatingTrip && selectedOrders.length >= 1 && (
                <button className="btn-secondary" onClick={startTripSelection}>
                  {selectedOrders.length > 1 ? "+ Adicionar pedidos" : "+ Pedidos"}
                </button>
              )}
              <button
                className="btn-primary"
                disabled={!canContinue}
                onClick={() => setModalStep("confirm")}
              >
                Continuar
              </button>
            </>
          )}
        </div>
      </ModalBase>

      {/* Modal de retirada: só confirma "pronto", sem motoboy nem roteirização */}
      <ModalBase
        isOpen={isPickupModalOpen}
        title="Marcar pedido como pronto"
        onClose={closePickupModal}
      >
        <div className="delivery-modal">
          {pickupOrder && (
            <div className="modal-form confirm-summary">
              <p className="confirm-lead">
                Confirma que o pedido{" "}
                <strong>#{pickupOrder.order_id}</strong> de{" "}
                <strong>{pickupOrder.nome_destinatario}</strong> está pronto para retirada?
              </p>
              <p className="sub-info">
                O cliente recebe a mensagem de aviso automaticamente.
              </p>
            </div>
          )}
        </div>
        <div className="modal-buttons">
          <button
            className="btn-secondary"
            onClick={closePickupModal}
            disabled={isMarkingPickupReady}
          >
            Cancelar
          </button>
          <button
            className="btn-primary"
            onClick={confirmPickupReady}
            disabled={isMarkingPickupReady}
          >
            {isMarkingPickupReady ? "Salvando..." : "Confirmar"}
          </button>
        </div>
      </ModalBase>
    </div>
  );
}
