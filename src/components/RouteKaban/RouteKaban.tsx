// src/components/RouteKaban/RouteKaban.tsx
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import type { DropResult } from '@hello-pangea/dnd';
import { v4 as uuidv4 } from 'uuid';
import './RouteKaban.css';
import type { Route, Neighborhood } from '../../types/Robo';
import type { Pedido } from '../../types/Pedido';
import {
  buildNeighborhoodMap,
  findBestRouteForOrder,
  getMinutesFromOrder,
  normalizeToId,
  isRouteFull,
  findMergeSuggestions,
  findCrossSectorOpportunities,
  MAX_ORDERS_PER_ROUTE,
} from '../../utils/routeRobot';
import type { MergeSuggestion, CrossSectorOpportunity } from '../../utils/routeRobot';
import bairrosData from './bairrosGeo.json';
import { db, doc, getDoc, setDoc } from '../../services/firebase';
import { useToast } from '../../contexts/ToastContext';
import {
  BsLightningChargeFill as LightningChargeFill,
  BsCalendarEvent as CalendarEvent,
  BsExclamationTriangleFill as ExclamationTriangleFill,
  BsQuestionCircleFill as QuestionCircleFill,
  BsSignpostSplit as SignpostSplit,
  BsGeoAltFill as GeoAltFill,
  BsXLg as XLg,
} from 'react-icons/bs';

interface RouteKabanProps {
  orders: Pedido[];
  selectedDate: Date;
}

// ✅ PALETA PREMIUM (Cores coesas, elegantes e legíveis com texto branco)
const ROUTE_COLORS = [
  '#32378E', // Deep Blue Brand (Original)
  '#047857', // Forest Green (Esmeralda ajustado para legibilidade)
  '#C2410C', // Burnt Orange (Coral ajustado)
  '#B45309', // Dark Amber
  '#9B287B', // Plum/Magenta (Original)
  '#0369A1', // Cobalt Blue
  '#593C8F', // Violet (Original)
  '#0F766E', // Deep Teal
  '#BE123C', // Rose/Crimson
  '#0F172A', // Slate Dark
  '#4338CA', // Deep Indigo
  '#15803D', // Olive Green
  '#6D28D9', // Royal Purple
  '#9F1239', // Burgundy
  '#1D4ED8', // Classic Royal Blue
  '#854D0E', // Golden Brown
  '#A21CAF', // Amethyst
  '#334155', // Charcoal Slate
  '#4C1D95', // Eggplant
  '#0E7490', // Ocean Cerulean
  '#86198F', // Dark Fuchsia
  '#3F6212', // Dark Lime
  '#BE185D', // Raspberry
  '#1E3A8A'  // Navy Blue
];

const stringToColor = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ROUTE_COLORS[Math.abs(hash) % ROUTE_COLORS.length];
};

// --- UTILITÁRIOS GERAIS ---
// normalizeToId agora vive em utils/routeRobot.ts (fonte única de verdade)

const minutesToTime = (totalMinutes: number): string => {
  const hours   = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
};

const isSameDay = (dateString: string, targetDate: Date): boolean => {
  try {
    let orderDate: Date;
    if (dateString && dateString.trim().startsWith("Dia")) {
      const matches = dateString.match(/Dia (\d{2})\/(\d{2})/);
      if (!matches) return false;
      const day   = parseInt(matches[1], 10);
      const month = parseInt(matches[2], 10) - 1;
      orderDate   = new Date(targetDate.getFullYear(), month, day);
    } else {
      orderDate = new Date(dateString);
    }
    if (isNaN(orderDate.getTime())) return false;
    return (
      orderDate.getDate()     === targetDate.getDate()     &&
      orderDate.getMonth()    === targetDate.getMonth()    &&
      orderDate.getFullYear() === targetDate.getFullYear()
    );
  } catch { return false; }
};

function nameRoute(name: string): string {
  return name.includes("RENASCENCA")
    ? name.replace("RENASCENCA", "RENAS.")
    : name.includes("COHATRAC")
    ? name.replace("COHATRAC", "COHAT.")
    : name;
}

const getStorageKey = (date: Date) => {
  const d = date.getDate().toString().padStart(2, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const y = date.getFullYear();
  return `${y}-${m}-${d}`;
};

const sanitize = (obj: unknown): unknown => {
  if (obj === undefined || obj === null) return null;
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, sanitize(v)])
    );
  }
  return obj;
};

// --- PERSISTÊNCIA LOCAL DE SUGESTÕES DESCARTADAS (por dia) ---
const loadDismissedSet = (storageKey: string): Set<string> => {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
};

const saveDismissedSet = (storageKey: string, set: Set<string>) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(Array.from(set)));
  } catch {
    /* localStorage indisponível — ignora silenciosamente */
  }
};

// Tempo (ms) da animação de saída antes de remover de fato do estado "dismissed"
const DISMISS_ANIMATION_MS = 220;

// Sugestões de fusão/cross-sector descartadas: chave GLOBAL, sem data.
// Antes a chave incluía o dia (dismissedMerges_${dateKey}), então uma
// sugestão fechada hoje "renascia" amanhã. Uma vez fechada, não volta
// mais nesse computador — ver useEffects de carregamento abaixo.
const DISMISSED_MERGES_KEY = 'dismissedMerges_global';
const DISMISSED_CROSS_SECTOR_KEY = 'dismissedCrossSector_global';

// --- PERSISTÊNCIA LOCAL DE PEDIDOS JÁ "VISTOS" PELO ROBÔ (por dia) ---
// Sem isso, toda vez que a tela é reaberta o efeito de montagem roda de
// novo, "acha" que os pedidos que o robô já tinha roteirizado em visitas
// anteriores são novidade, e reacende o ponto de notificação (!) nas
// rotas — mesmo que nada tenha realmente mudado desde a última vez que
// o usuário olhou a mesa. Persistindo quais order_ids já passaram pelo
// robô ao menos uma vez, só pedidos genuinamente novos notificam.
const getSeenOrdersKey = (dateKey: string) => `seenRobotOrders_${dateKey}`;

const loadSeenOrders = (dateKey: string): Set<string> => {
  try {
    const raw = localStorage.getItem(getSeenOrdersKey(dateKey));
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
};

const saveSeenOrders = (dateKey: string, set: Set<string>) => {
  try {
    localStorage.setItem(getSeenOrdersKey(dateKey), JSON.stringify(Array.from(set)));
  } catch {
    /* localStorage indisponível — ignora silenciosamente */
  }
};

// --- COMPONENTE PRINCIPAL ---
export const RouteKaban: React.FC<RouteKabanProps> = ({ orders: allOrders, selectedDate }) => {
  const { addToast }        = useToast();
  const neighborhoodMap     = useMemo(() => buildNeighborhoodMap(bairrosData as Neighborhood[]), []);

  const [queue,           setQueue]           = useState<Pedido[]>([]);
  const [routes,          setRoutes]          = useState<Route[]>([]);
  const [expandedRouteId, setExpandedRouteId] = useState<string | null>(null);
  const [notifications,   setNotifications]   = useState<Set<string>>(new Set());
  const [manualOverrides, setManualOverrides] = useState<Set<string>>(new Set());
  const [isLoadingFromDB, setIsLoadingFromDB] = useState(false);
  const [dismissedMerges,  setDismissedMerges]  = useState<Set<string>>(new Set());
  const [dismissedCrossSector, setDismissedCrossSector] = useState<Set<string>>(new Set());

  // Cards em processo de "saída animada" (ainda visíveis, mas com classe .removing)
  const [removingMerges, setRemovingMerges] = useState<Set<string>>(new Set());
  const [removingCrossSector, setRemovingCrossSector] = useState<Set<string>>(new Set());

  const savedDataRef     = useRef<{ routes: Route[]; overrides: Set<string> }>({ routes: [], overrides: new Set() });
  const isDataLoadedRef  = useRef(false);
  const loadedDateKeyRef = useRef<string>("");
  const saveDebounceRef  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const routesRef          = useRef<Route[]>([]);
  const manualOverridesRef = useRef<Set<string>>(new Set());

  // Pedidos que o robô já processou (em qualquer visita anterior à tela,
  // nesse dia). Carregado do localStorage antes do efeito de montagem
  // rodar, então ele não confunde "pedido antigo, tela reaberta" com
  // "pedido novo" — ver loadSeenOrders/saveSeenOrders acima.
  const seenOrdersRef = useRef<Set<string>>(new Set());

  // Trava de verdade contra a corrida entre os dois efeitos abaixo. Precisa
  // ser uma REF (não estado): setIsLoadingFromDB(true) só fica visível na
  // PRÓXIMA renderização, então o efeito de montagem de rotas — que roda no
  // mesmo instante — ainda enxergava o valor antigo (false) e executava com
  // os dados do Firestore ainda vazios, remontando tudo do zero a cada vez
  // que a tela era aberta.
  const carregandoRef = useRef(true);

  useEffect(() => { routesRef.current = routes; },                    [routes]);
  useEffect(() => { manualOverridesRef.current = manualOverrides; },  [manualOverrides]);

  const dailyOrders = useMemo(() => {
    return allOrders.filter(order => {
      if (order.status !== 2) return false; 
      const dataConsiderada = order.agendamento || order.data_venda;
      return isSameDay(dataConsiderada, selectedDate);
    });
  }, [allOrders, selectedDate]);

  const dailyOrdersHash = JSON.stringify(dailyOrders);

  // --- Carrega sugestões descartadas salvas localmente (GLOBAL, uma
  // vez por computador — não depende do dia, então roda só na
  // montagem do componente). ---
  useEffect(() => {
    setDismissedMerges(loadDismissedSet(DISMISSED_MERGES_KEY));
    setDismissedCrossSector(loadDismissedSet(DISMISSED_CROSS_SECTOR_KEY));
  }, []);

  // --- Pedidos já "vistos" pelo robô continuam controlados por dia
  // (isso é o que evita reacender o ponto "!" nas rotas ao reabrir a
  // tela — não tem relação com as sugestões de fusão/cross-sector). ---
  useEffect(() => {
    const dateKey = getStorageKey(selectedDate);
    seenOrdersRef.current = loadSeenOrders(dateKey);
    // Limpa também qualquer animação de saída pendente ao trocar de dia
    setRemovingMerges(new Set());
    setRemovingCrossSector(new Set());
  }, [selectedDate]);

  useEffect(() => {
    saveDismissedSet(DISMISSED_MERGES_KEY, dismissedMerges);
  }, [dismissedMerges]);

  useEffect(() => {
    saveDismissedSet(DISMISSED_CROSS_SECTOR_KEY, dismissedCrossSector);
  }, [dismissedCrossSector]);

  useEffect(() => {
    const dateKey = getStorageKey(selectedDate);
    if (loadedDateKeyRef.current === dateKey) return; 

    isDataLoadedRef.current = false;
    carregandoRef.current = true;
    setIsLoadingFromDB(true);
    setRoutes([]);
    setQueue([]);
    setNotifications(new Set());

    const docRef = doc(db, "rotas", dateKey);

    getDoc(docRef)
      .then((snap) => {
        if (snap.exists()) {
          const data = snap.data();
          savedDataRef.current = {
            routes:    data.routes    || [],
            overrides: new Set(data.manualOverrides || []),
          };
        } else {
          savedDataRef.current = { routes: [], overrides: new Set() };
        }
      })
      .catch((err) => {
        console.error("Erro ao carregar rotas:", err);
        addToast("Erro ao carregar rotas salvas.", "error");
        savedDataRef.current = { routes: [], overrides: new Set() };
      })
      .finally(() => {
        loadedDateKeyRef.current = dateKey;
        carregandoRef.current = false;
        setIsLoadingFromDB(false);
      });
  }, [selectedDate, addToast]);

  useEffect(() => {
    if (carregandoRef.current) return;

    const alreadyLoaded  = isDataLoadedRef.current;
    const savedRoutes    = alreadyLoaded ? routesRef.current          : savedDataRef.current.routes;
    const savedOverrides = alreadyLoaded ? manualOverridesRef.current : savedDataRef.current.overrides;

    const validIds       = new Set(dailyOrders.map(o => String(o.order_id)));
    const dailyOrdersMap = new Map(dailyOrders.map(o => [String(o.order_id), o]));

    let mergedRoutes: Route[] = savedRoutes.map(route => {
      const activeOrders = route.orders
        .filter(o => validIds.has(String(o.order_id)))
        .map(o => dailyOrdersMap.get(String(o.order_id)) || o);

      let avg = route.averageTimeMinutes;
      if (activeOrders.length > 0) {
        const total = activeOrders.reduce((acc, obj) => acc + getMinutesFromOrder(obj), 0);
        avg = total / activeOrders.length;
      }
      return { ...route, orders: activeOrders, averageTimeMinutes: avg };
    }).filter(r => r.orders.length > 0);

    const routedIds     = new Set(mergedRoutes.flatMap(r => r.orders.map(o => String(o.order_id))));
    const pendingOrders = dailyOrders.filter(o => !routedIds.has(String(o.order_id)));
    const finalQueue: Pedido[] = pendingOrders.filter(o => savedOverrides.has(String(o.order_id)));
    const ordersForRobot = pendingOrders.filter(o => !savedOverrides.has(String(o.order_id)));
    const newNotifications = new Set<string>();

    // Só notifica por pedidos que o robô nunca tinha processado antes
    // (nem nesta sessão, nem em visitas anteriores à tela — daí a
    // consulta a seenOrdersRef, que é persistida no localStorage).
    const seenOrders = seenOrdersRef.current;

    ordersForRobot.forEach(order => {
      const orderId = String(order.order_id);
      const isNewOrder = alreadyLoaded && !seenOrders.has(orderId);
      const suggestedRouteId = findBestRouteForOrder(order, mergedRoutes, neighborhoodMap);

      if (suggestedRouteId) {
        mergedRoutes = mergedRoutes.map(r => {
          if (r.id === suggestedRouteId) {
            if (isNewOrder) newNotifications.add(r.id);
            const updatedOrders = [...r.orders, order];
            const total = updatedOrders.reduce((acc, obj) => acc + getMinutesFromOrder(obj), 0);
            return {
              ...r,
              orders: updatedOrders,
              averageTimeMinutes: total / updatedOrders.length,
              title: `${r.sectorId.replace(/_/g, ' ')} (~${minutesToTime(total / updatedOrders.length)})`,
            };
          }
          return r;
        });
      } else {
        const normalizedId = normalizeToId(order.bairro_destinatario);
        const info = neighborhoodMap[normalizedId];
        if (info) {
          const minutes = getMinutesFromOrder(order);
          const newId = uuidv4();
          if (isNewOrder) newNotifications.add(newId);
          mergedRoutes.push({
            id: newId,
            title: `${info.setor_id.replace(/_/g, ' ')} (~${minutesToTime(minutes)})`,
            sectorId: info.setor_id,
            orders: [order],
            status: 'open',
            averageTimeMinutes: minutes,
          });
        } else {
          finalQueue.push(order);
        }
      }
      seenOrders.add(orderId);
    });

    isDataLoadedRef.current = true;
    seenOrdersRef.current = seenOrders;
    saveSeenOrders(getStorageKey(selectedDate), seenOrders);

    setRoutes(mergedRoutes);
    setQueue(finalQueue);
    setManualOverrides(savedOverrides);
    if (newNotifications.size > 0) {
      setNotifications(prev => new Set([...prev, ...newNotifications]));
    }
  }, [dailyOrders, dailyOrdersHash, isLoadingFromDB, neighborhoodMap, selectedDate]);

  useEffect(() => {
    if (!isDataLoadedRef.current) return;
    if (dailyOrders.length === 0 && routes.length === 0 && queue.length === 0) return;

    clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(async () => {
      const dateKey = getStorageKey(selectedDate);
      const docRef  = doc(db, "rotas", dateKey);
      try {
        await setDoc(docRef, sanitize({
          routes,
          manualOverrides: Array.from(manualOverrides),
          updatedAt: new Date().toISOString(),
        }) as object);
      } catch (err) {
        console.error("Erro ao salvar rotas:", err);
      }
    }, 1500);

    return () => clearTimeout(saveDebounceRef.current);
  }, [routes, manualOverrides, selectedDate, dailyOrders.length, queue.length, addToast]);

  const handleDragEnd = (result: DropResult) => {
    const { source, destination, draggableId } = result;
    if (!destination) return;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    setManualOverrides(prev => { const next = new Set(prev); next.add(draggableId); return next; });

    const sourceList = source.droppableId === 'QUEUE'
      ? [...queue]
      : [...routes.find(r => r.id === source.droppableId)?.orders || []];

    const destList = destination.droppableId === 'QUEUE'
      ? [...queue]
      : (source.droppableId === destination.droppableId
          ? sourceList
          : [...routes.find(r => r.id === destination.droppableId)?.orders || []]);

    const [movedItem] = sourceList.splice(source.index, 1);
    destList.splice(destination.index, 0, movedItem);

    let newQueue = queue;
    const newRoutes = routes.map(r => ({ ...r }));

    if (source.droppableId === 'QUEUE') {
      newQueue = sourceList;
    } else {
      const rIndex = newRoutes.findIndex(r => r.id === source.droppableId);
      if (rIndex !== -1) {
        newRoutes[rIndex].orders = sourceList;
        if (sourceList.length === 0) newRoutes.splice(rIndex, 1);
      }
    }

    if (destination.droppableId === 'QUEUE') {
      newQueue = destList;
    } else if (source.droppableId !== destination.droppableId) {
      const rIndex = newRoutes.findIndex(r => r.id === destination.droppableId);
      if (rIndex !== -1) {
        if (destList.length > MAX_ORDERS_PER_ROUTE) {
          addToast(`Atenção: rota passou de ${MAX_ORDERS_PER_ROUTE} pedidos (movido manualmente).`, "warning");
        }
        newRoutes[rIndex].orders = destList;
        const total = destList.reduce((acc, o) => acc + getMinutesFromOrder(o), 0);
        const avg = total / destList.length;
        newRoutes[rIndex].averageTimeMinutes = avg;
        newRoutes[rIndex].title = `${newRoutes[rIndex].sectorId.replace(/_/g, ' ')} (~${minutesToTime(avg)})`;
        setNotifications(prev => new Set(prev).add(newRoutes[rIndex].id));
      }
    }

    setQueue(newQueue);
    setRoutes(newRoutes);
  };

  const handleAutoAssign = useCallback((orderId: string) => {
    const sOrderId   = String(orderId);
    const orderIndex = queue.findIndex(o => String(o.order_id) === sOrderId);
    if (orderIndex === -1) return;

    const order    = queue[orderIndex];
    const newQueue = [...queue];
    newQueue.splice(orderIndex, 1);

    setManualOverrides(prev => { const next = new Set(prev); next.delete(sOrderId); return next; });

    let routeFound = false;
    let newRoutes  = routes.map(r => ({ ...r }));

    const suggestedId = findBestRouteForOrder(order, newRoutes, neighborhoodMap);
    if (suggestedId) {
      newRoutes = newRoutes.map(r => {
        if (r.id === suggestedId) {
          routeFound = true;
          const updatedOrders = [...r.orders, order];
          const total = updatedOrders.reduce((acc, o) => acc + getMinutesFromOrder(o), 0);
          setNotifications(prev => new Set(prev).add(r.id));
          return {
            ...r,
            orders: updatedOrders,
            averageTimeMinutes: total / updatedOrders.length,
            title: `${r.sectorId.replace(/_/g, ' ')} (~${minutesToTime(total / updatedOrders.length)})`,
          };
        }
        return r;
      });
    }

    if (!routeFound) {
      const normalizedId = normalizeToId(order.bairro_destinatario);
      const info = neighborhoodMap[normalizedId];
      if (info) {
        const minutes = getMinutesFromOrder(order);
        const newId   = uuidv4();
        setNotifications(prev => new Set(prev).add(newId));
        newRoutes.push({
          id: newId,
          title: `${info.setor_id.replace(/_/g, ' ')} (~${minutesToTime(minutes)})`,
          sectorId: info.setor_id,
          orders: [order],
          status: 'open',
          averageTimeMinutes: minutes,
        });
      } else {
        addToast("Bairro não mapeado — pedido ficou na fila.", "warning");
        newQueue.push(order);
      }
    }

    setQueue(newQueue);
    setRoutes(newRoutes);
  }, [queue, routes, neighborhoodMap, addToast]);

  // --- OPORTUNIDADES: SUGESTÃO DE FUSÃO DE ROTAS ---
  // A chave de "descartado" precisa ser estável entre recargas da tela.
  // route.id é um uuid gerado de novo toda vez que uma rota é recriada
  // do zero (ex.: esvaziou e voltou a receber pedido), então usá-lo na
  // chave fazia a sugestão "esquecer" que já tinha sido descartada.
  // Usar só o sectorId também não serve: como só se sugere fusão DENTRO do
  // mesmo setor, todo par de rotas do mesmo setor gera a MESMA chave —
  // descartar uma sugestão bloquearia TODAS as sugestões futuras daquele
  // setor (mascarando pares genuinamente novos). A chave estável de
  // verdade é o conjunto de pedidos envolvidos: não muda quando a rota é
  // recriada do zero, e é única por combinação real de pedidos.
  const routeSectorId = useCallback(
    (routeId: string) => routes.find(r => r.id === routeId)?.sectorId ?? routeId,
    [routes]
  );
  const mergeKey = useCallback((routeAId: string, routeBId: string) => {
    const routeA = routes.find(r => r.id === routeAId);
    const routeB = routes.find(r => r.id === routeBId);
    const orderIds = [
      ...(routeA?.orders.map(o => String(o.order_id)) ?? []),
      ...(routeB?.orders.map(o => String(o.order_id)) ?? []),
    ].sort();
    return orderIds.join(',');
  }, [routes]);

  const mergeSuggestions = useMemo(() => {
    return findMergeSuggestions(routes, neighborhoodMap).filter(s => !dismissedMerges.has(mergeKey(s.routeAId, s.routeBId)));
  }, [routes, neighborhoodMap, dismissedMerges, mergeKey]);

  // --- OPORTUNIDADES: PEDIDO MAIS PERTO DE ROTA DE OUTRO SETOR ---
  const allPendingOrders = useMemo(() => [...queue, ...routes.flatMap(r => r.orders)], [queue, routes]);

  const crossSectorKey = useCallback(
    (o: CrossSectorOpportunity) => `${o.orderId}::${routeSectorId(o.nearbyRouteId)}`,
    [routeSectorId]
  );

  const crossSectorOpportunities = useMemo(() => {
    return findCrossSectorOpportunities(allPendingOrders, routes, neighborhoodMap)
      .filter(o => !dismissedCrossSector.has(crossSectorKey(o)));
  }, [allPendingOrders, routes, neighborhoodMap, dismissedCrossSector, crossSectorKey]);

  const handleMergeRoutes = useCallback((routeAId: string, routeBId: string) => {
    // Descarta a sugestão já aqui (não só pelo botão "x"): a fusão das rotas
    // só é persistida no Firestore depois de 1.5s de debounce — se a tela for
    // trocada antes disso, o efeito de salvar é cancelado (clearTimeout no
    // cleanup), a rota volta dividida ao recarregar e a MESMA sugestão
    // reaparece. Marcar como descartada garante que ela não volte mesmo
    // que a fusão em si não tenha chegado a ser salva a tempo.
    setDismissedMerges(prev => new Set(prev).add(mergeKey(routeAId, routeBId)));

    setRoutes(prev => {
      const routeA = prev.find(r => r.id === routeAId);
      const routeB = prev.find(r => r.id === routeBId);
      if (!routeA || !routeB) return prev;

      const mergedOrders = [...routeA.orders, ...routeB.orders];
      const total = mergedOrders.reduce((acc, o) => acc + getMinutesFromOrder(o), 0);
      const avg   = total / mergedOrders.length;

      const mergedRoute: Route = {
        ...routeA,
        orders: mergedOrders,
        averageTimeMinutes: avg,
        title: `${routeA.sectorId.replace(/_/g, ' ')} (~${minutesToTime(avg)})`,
      };

      setNotifications(prevN => new Set(prevN).add(mergedRoute.id));
      return prev.filter(r => r.id !== routeAId && r.id !== routeBId).concat(mergedRoute);
    });
    if (expandedRouteId === routeAId || expandedRouteId === routeBId) {
      setExpandedRouteId(null);
    }
    addToast("Rotas fundidas com sucesso.", "success");
  }, [expandedRouteId, addToast, mergeKey]);

  // Descarta a sugestão de fusão com animação de saída antes de remover de vez
  const handleDismissMerge = useCallback((suggestion: MergeSuggestion) => {
    const key = mergeKey(suggestion.routeAId, suggestion.routeBId);
    setRemovingMerges(prev => new Set(prev).add(key));
    setTimeout(() => {
      setDismissedMerges(prev => new Set(prev).add(key));
      setRemovingMerges(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, DISMISS_ANIMATION_MS);
  }, [mergeKey]);

  // Descarta a oportunidade cross-sector com animação de saída antes de remover de vez
  const handleDismissCrossSector = useCallback((opportunity: CrossSectorOpportunity) => {
    const key = crossSectorKey(opportunity);
    setRemovingCrossSector(prev => new Set(prev).add(key));
    setTimeout(() => {
      setDismissedCrossSector(prev => new Set(prev).add(key));
      setRemovingCrossSector(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, DISMISS_ANIMATION_MS);
  }, [crossSectorKey]);

  const handleRouteClick = (id: string) => {
    setNotifications(prev => { const next = new Set(prev); next.delete(id); return next; });
    setExpandedRouteId(prev => prev === id ? null : id);
  };

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      {(mergeSuggestions.length > 0 || crossSectorOpportunities.length > 0) && (
        <div className="merge-suggestions">
          {mergeSuggestions.map(s => {
            const routeA = routes.find(r => r.id === s.routeAId);
            const routeB = routes.find(r => r.id === s.routeBId);
            if (!routeA || !routeB) return null;
            const key = mergeKey(s.routeAId, s.routeBId);
            return (
              <div
                className={`merge-suggestion-card ${removingMerges.has(key) ? 'removing' : ''}`}
                key={key}
              >
                <button
                  className="merge-dismiss-btn"
                  onClick={() => handleDismissMerge(s)}
                  title="Ignorar sugestão"
                >
                  <XLg size={10} />
                </button>
                <div className="merge-suggestion-icon"><SignpostSplit size={16} /></div>
                <div className="merge-suggestion-text">
                  <strong>{nameRoute(routeA.title)}</strong> e <strong>{nameRoute(routeB.title)}</strong>
                  <br />
                  podem virar uma rota só ({s.combinedOrders} pedidos, ~{Math.round(s.timeDiffMinutes)} min de diferença
                  {s.distanceKm != null ? `, ${s.distanceKm.toFixed(1)} km entre os centros` : ''})
                </div>
                <button className="merge-confirm-btn" onClick={() => handleMergeRoutes(s.routeAId, s.routeBId)}>
                  Fundir rotas
                </button>
              </div>
            );
          })}

          {crossSectorOpportunities.map(o => {
            const nearbyRoute = routes.find(r => r.id === o.nearbyRouteId);
            if (!nearbyRoute) return null;
            const key = crossSectorKey(o);
            return (
              <div
                className={`merge-suggestion-card cross-sector ${removingCrossSector.has(key) ? 'removing' : ''}`}
                key={key}
              >
                <button
                  className="merge-dismiss-btn"
                  onClick={() => handleDismissCrossSector(o)}
                  title="Ignorar sugestão"
                >
                  <XLg size={10} />
                </button>
                <div className="merge-suggestion-icon"><GeoAltFill size={16} /></div>
                <div className="merge-suggestion-text">
                  <strong>{o.orderBairroNome}</strong> está a só {o.distanceKm.toFixed(1)} km de{' '}
                  <strong>{nameRoute(nearbyRoute.title)}</strong>
                  <br />
                  (rota de outro setor — vale conferir se não compensa mais colocar esse pedido lá)
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="kaban-container">
        <Droppable droppableId="QUEUE">
          {(provided, snapshot) => (
            <div
              className={queue.length === 0 && !snapshot.isDraggingOver ? "queue-circle-empty" : "queue-column active"}
              ref={provided.innerRef}
              {...provided.droppableProps}
            >
              {queue.length === 0 && !snapshot.isDraggingOver ? (
                <>Fila Vazia</>
              ) : (
                <>
                  <h2 className="queue-title">Fila de Roteirização ({queue.length})</h2>
                  <div className="queue-area">
                    {queue.map((order, index) => (
                      <DraggableCard
                        key={order.order_id}
                        order={order}
                        index={index}
                        map={neighborhoodMap}
                        isInQueue={true}
                        onAutoAssign={() => handleAutoAssign(String(order.order_id))}
                      />
                    ))}
                    {provided.placeholder}
                  </div>
                </>
              )}
              <div style={{ display: 'none' }}>{provided.placeholder}</div>
            </div>
          )}
        </Droppable>

        <div className="routes-wrapper">
          {routes
            .sort((a, b) => a.averageTimeMinutes - b.averageTimeMinutes)
            .map((route) => (
              <RouteColumn
                key={route.id}
                route={route}
                map={neighborhoodMap}
                isExpanded={expandedRouteId === route.id}
                hasNotification={notifications.has(route.id)}
                onToggle={() => handleRouteClick(route.id)}
              />
            ))}
        </div>
      </div>
    </DragDropContext>
  );
};

// --- COMPONENTES AUXILIARES ---

interface RouteColumnProps {
  route: Route;
  map: Record<string, Neighborhood>;
  isExpanded: boolean;
  hasNotification: boolean;
  onToggle: () => void;
}

const RouteColumn = ({ route, map, isExpanded, hasNotification, onToggle }: RouteColumnProps) => {
  const routeColor = stringToColor(route.sectorId);
  const isFull = isRouteFull(route);
  return (
    <Droppable droppableId={route.id}>
      {(provided, snapshot) => {
        const showList = isExpanded || snapshot.isDraggingOver;
        return (
          <div className="route-container" ref={provided.innerRef} {...provided.droppableProps}>
            {showList ? (
              <div className="route-expanded-container" style={{ borderColor: routeColor }}>
                <div className="route-header-expanded" style={{ backgroundColor: routeColor }} onClick={onToggle}>
                  <span>{route.title}</span>
                  <span className="route-count">
                    {route.orders.length}/{MAX_ORDERS_PER_ROUTE}
                    {isFull && ' · Cheia'}
                  </span>
                </div>
                <div className={`route-list-area ${snapshot.isDraggingOver ? 'dragging-over' : ''}`}>
                  {route.orders.map((order, index) => (
                    <DraggableCard key={order.order_id} order={order} index={index} map={map} parentRouteSector={route.sectorId} />
                  ))}
                  {provided.placeholder}
                </div>
              </div>
            ) : (
              <div className={`route-circle ${isFull ? 'route-full' : ''}`} onClick={onToggle} style={{ backgroundColor: routeColor }}>
                {hasNotification && <div className="notification-dot">!</div>}
                <span className="route-title-small">{nameRoute(route.title)}</span>
                <span className="route-count">{route.orders.length}/{MAX_ORDERS_PER_ROUTE}</span>
                <div style={{ display: 'none' }}>{provided.placeholder}</div>
              </div>
            )}
          </div>
        );
      }}
    </Droppable>
  );
};

interface DraggableCardProps {
  order: Pedido;
  index: number;
  map: Record<string, Neighborhood>;
  parentRouteSector?: string;
  onAutoAssign?: () => void;
  isInQueue?: boolean;
}

const DraggableCard = ({ order, index, map, parentRouteSector, onAutoAssign, isInQueue }: DraggableCardProps) => {
  const bairroId  = normalizeToId(order.bairro_destinatario);
  const info      = map[bairroId];
  const minutes   = getMinutesFromOrder(order);
  const isMisplaced = parentRouteSector && info && parentRouteSector !== info.setor_id;

  return (
    <Draggable draggableId={String(order.order_id)} index={index}>
      {(provided, snapshot) => (
        <div
          className={`route-order-card ${snapshot.isDragging ? 'dragging' : ''}`}
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          style={{ ...provided.draggableProps.style }}
        >
          {isInQueue && onAutoAssign && (
            <button className="auto-assign-btn" onClick={(e) => { e.stopPropagation(); onAutoAssign(); }} title="Designar Rota Automaticamente">
              <LightningChargeFill size={14} />
            </button>
          )}
          <div className="route-order-header">
            <span className="route-client-name">{order.nome_destinatario}</span>
            <span className="route-order-time">{minutesToTime(minutes)}</span>
          </div>
          <div className="route-order-bairro">{order.bairro_destinatario}</div>
          
          <div className="route-order-badges">
            {isMisplaced && (
              <span className="route-badge route-badge--error">
                <ExclamationTriangleFill size={10} /> Erro Setor
              </span>
            )}
            {!info && (
              <span className="route-badge route-badge--warning">
                <QuestionCircleFill size={10} /> Ñ Mapeado
              </span>
            )}
            {order.agendamento && (
              <span className="route-badge route-badge--info">
                <CalendarEvent size={10} /> Agendado
              </span>
            )}
          </div>
        </div>
      )}
    </Draggable>
  );
};
