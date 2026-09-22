import type { Pedido } from "../types/Pedido";
import type { Neighborhood, Route } from "../types/Robo";
// ✅ Importando a ferramenta de segurança de datas
import { parseISODateTime } from "./dateUtils";

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO (ajuste esses números conforme a operação real)
// ─────────────────────────────────────────────────────────────

// Quantos pedidos uma rota aguenta antes de ser considerada "cheia".
// Passe um valor diferente nos parâmetros das funções se precisar
// variar por setor no futuro.
export const MAX_ORDERS_PER_ROUTE = 8;

// Pedido com horário EXPLÍCITO (agendamento tipo "Dia 05/07 14:30") é um
// compromisso real com o cliente — a tolerância pra encaixar numa rota
// existente precisa ser mais apertada, senão ele pode ir pra uma rota
// que vai passar no bairro cedo/tarde demais.
const TIME_TOLERANCE_SCHEDULED_MINUTES = 15;

// Pedido sem horário explícito (só data_venda, hora estimada) tem mais
// margem, porque o horário dele já é uma aproximação.
const TIME_TOLERANCE_ESTIMATED_MINUTES = 25;

// Duas rotas do mesmo setor só devem ser sugeridas pra fusão se a
// diferença de horário médio entre elas for pequena o suficiente pra
// não atrasar quem já estava na rota mais adiantada.
const MERGE_TIME_TOLERANCE_MINUTES = 20;

// Raio "confortável" em km: dentro disso, a distância não penaliza o
// score de uma rota. Além disso, cada km extra pesa contra a rota.
// Setores grandes (tipo GRANDE_TURU, com bairros espalhados) se
// beneficiam mais desse critério do que setores compactos.
const GEO_SOFT_RADIUS_KM = 3;

// Duas rotas só são sugeridas pra fusão geograficamente se os centros
// delas estiverem a até essa distância — evita fundir duas pontas
// opostas de um setor grande só porque o horário bateu.
const MERGE_GEO_RADIUS_KM = 4;

// Pra sugerir uma "oportunidade cross-setor" (pedido mais perto de uma
// rota de OUTRO setor do que da rota certa), a rota vizinha precisa
// estar pelo menos isso mais perto.
const CROSS_SECTOR_PROXIMITY_KM = 1.5;

// ─────────────────────────────────────────────────────────────
// HORÁRIO DO PEDIDO
// ─────────────────────────────────────────────────────────────

export const getMinutesFromOrder = (order: Pedido): number => {
  const dataStr = order.agendamento || order.data_venda;

  if (dataStr && dataStr.trim().startsWith("Dia")) {
    const timeMatch = dataStr.match(/(\d{2}):(\d{2})/);
    if (timeMatch) {
      return parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
    }
    return 720; // 12:00 fallback
  }

  // ✅ Usando a função nativa que previne o bug do Safari
  const date = parseISODateTime(dataStr);

  if (isNaN(date.getTime())) return 720;

  return date.getHours() * 60 + date.getMinutes();
};

// Um pedido é "agendado de verdade" quando tem data no formato "Dia DD/MM"
// E um horário explícito dentro dela. Isso é diferente de simplesmente
// cair no fallback de 12:00 — aquele é uma estimativa, não um compromisso.
export const isScheduledOrder = (order: Pedido): boolean => {
  const dataStr = order.agendamento || order.data_venda;
  if (!dataStr) return false;
  return dataStr.trim().startsWith("Dia") && /\d{2}:\d{2}/.test(dataStr);
};

export const buildNeighborhoodMap = (list: Neighborhood[]): Record<string, Neighborhood> => {
  return list.reduce((acc, item) => {
    acc[item.id] = item;
    return acc;
  }, {} as Record<string, Neighborhood>);
};

// Normalização de string — fonte única de verdade (antes estava duplicada
// também no RouteKaban.tsx; agora o componente importa daqui).
export const normalizeToId = (text?: string | null): string => {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_");
};

// ─────────────────────────────────────────────────────────────
// GEOGRAFIA — DISTÂNCIA REAL ENTRE BAIRROS
// ─────────────────────────────────────────────────────────────
//
// Nem todo bairro tem lat/lng ainda (depende do geocoding ter sido
// rodado). Toda função aqui trata coordenada ausente com segurança:
// quando falta dado, o critério geográfico simplesmente não pesa,
// em vez de quebrar ou dar falso positivo.

export const haversineDistanceKm = (
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number => {
  const R = 6371; // raio médio da Terra em km
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const getOrderCoords = (
  order: Pedido,
  neighborhoodsMap: Record<string, Neighborhood>
): { lat: number; lng: number } | null => {
  const info = neighborhoodsMap[normalizeToId(order.bairro_destinatario)];
  if (!info || info.lat == null || info.lng == null) return null;
  return { lat: info.lat, lng: info.lng };
};

// Centro geográfico (média simples) dos bairros já presentes numa rota.
// Ignora pedidos cujo bairro não tem coordenada — só retorna null se
// NENHUM pedido da rota tiver coordenada.
export const getRouteCentroid = (
  route: Route,
  neighborhoodsMap: Record<string, Neighborhood>
): { lat: number; lng: number } | null => {
  const coords = route.orders
    .map(o => getOrderCoords(o, neighborhoodsMap))
    .filter((c): c is { lat: number; lng: number } => c !== null);

  if (coords.length === 0) return null;

  const lat = coords.reduce((sum, c) => sum + c.lat, 0) / coords.length;
  const lng = coords.reduce((sum, c) => sum + c.lng, 0) / coords.length;
  return { lat, lng };
};


//
// Antes: pegava a PRIMEIRA rota do mesmo setor dentro da tolerância —
// mesmo que existisse uma rota com horário muito mais parecido logo
// depois no array. Isso gerava rotas com horários "esticados" sem
// necessidade.
//
// Agora: avalia TODAS as rotas candidatas do setor, ignora as que já
// estão cheias, e escolhe a de MELHOR SCORE — uma combinação de
// proximidade de horário E distância geográfica real até o centro da
// rota (quando há coordenadas disponíveis). Pedidos agendados usam
// tolerância de horário mais apertada que pedidos estimados.
//
// A distância só refina a escolha ENTRE candidatas já válidas — o
// filtro de tolerância de horário continua sendo obrigatório, então
// isso nunca deixa o sistema "menos correto" que antes, só mais
// preciso quando há empate ou quase-empate de horário.

export const findBestRouteForOrder = (
  pedido: Pedido,
  openRoutes: Route[],
  neighborhoodsMap: Record<string, Neighborhood>,
  maxOrdersPerRoute: number = MAX_ORDERS_PER_ROUTE
): string | null => {
  const normalizedId = normalizeToId(pedido.bairro_destinatario);
  const targetBairro = neighborhoodsMap[normalizedId];

  if (!targetBairro) return null;

  const orderMinutes = getMinutesFromOrder(pedido);
  const tolerance = isScheduledOrder(pedido)
    ? TIME_TOLERANCE_SCHEDULED_MINUTES
    : TIME_TOLERANCE_ESTIMATED_MINUTES;

  const orderCoords = getOrderCoords(pedido, neighborhoodsMap);

  let bestRouteId: string | null = null;
  let bestScore = Infinity;

  for (const route of openRoutes) {
    if (route.sectorId !== targetBairro.setor_id) continue;
    if (route.orders.length >= maxOrdersPerRoute) continue; // rota cheia, pula

    const timeDiff = Math.abs(route.averageTimeMinutes - orderMinutes);
    if (timeDiff > tolerance) continue;

    // Score de tempo: 0 (horário idêntico) a 1 (no limite da tolerância).
    const timeScore = timeDiff / tolerance;

    // Score geográfico: só entra se AMBOS os lados tiverem coordenada.
    // Sem coordenada, geoScore fica neutro (0) — não penaliza nem
    // beneficia, só o horário decide, exatamente como antes.
    let geoScore = 0;
    if (orderCoords) {
      const centroid = getRouteCentroid(route, neighborhoodsMap);
      if (centroid) {
        const distKm = haversineDistanceKm(orderCoords.lat, orderCoords.lng, centroid.lat, centroid.lng);
        geoScore = distKm / GEO_SOFT_RADIUS_KM;
      }
    }

    const score = timeScore + geoScore;

    if (score < bestScore) {
      bestScore = score;
      bestRouteId = route.id;
    }
  }

  return bestRouteId;
};

// Diz se uma rota específica ainda tem espaço para receber pedidos.
export const isRouteFull = (
  route: Route,
  maxOrdersPerRoute: number = MAX_ORDERS_PER_ROUTE
): boolean => route.orders.length >= maxOrdersPerRoute;

// ─────────────────────────────────────────────────────────────
// DETECÇÃO DE OPORTUNIDADES — SUGESTÃO DE FUSÃO DE ROTAS
// ─────────────────────────────────────────────────────────────
//
// Duas rotas "gêmeas" (mesmo setor, horário médio parecido, ambas
// pequenas) custam um motoboy a mais do que precisam. Esta função
// varre as rotas abertas e sugere pares que podem ser fundidos sem
// estourar a capacidade nem bagunçar o horário de ninguém.

export interface MergeSuggestion {
  routeAId: string;
  routeBId: string;
  sectorId: string;
  timeDiffMinutes: number;
  combinedOrders: number;
  distanceKm: number | null; // null quando faltam coordenadas
}

export const findMergeSuggestions = (
  openRoutes: Route[],
  neighborhoodsMap: Record<string, Neighborhood>,
  maxOrdersPerRoute: number = MAX_ORDERS_PER_ROUTE,
  maxTimeDiffMinutes: number = MERGE_TIME_TOLERANCE_MINUTES,
  maxGeoDistanceKm: number = MERGE_GEO_RADIUS_KM
): MergeSuggestion[] => {
  const suggestions: MergeSuggestion[] = [];

  for (let i = 0; i < openRoutes.length; i++) {
    for (let j = i + 1; j < openRoutes.length; j++) {
      const routeA = openRoutes[i];
      const routeB = openRoutes[j];

      if (routeA.sectorId !== routeB.sectorId) continue;

      const combinedOrders = routeA.orders.length + routeB.orders.length;
      if (combinedOrders > maxOrdersPerRoute) continue;

      const timeDiffMinutes = Math.abs(routeA.averageTimeMinutes - routeB.averageTimeMinutes);
      if (timeDiffMinutes > maxTimeDiffMinutes) continue;

      // Se ambas as rotas têm coordenada, a distância real vira um
      // segundo filtro — evita fundir duas pontas de um setor grande
      // só porque o horário médio coincidiu por acaso.
      const centroidA = getRouteCentroid(routeA, neighborhoodsMap);
      const centroidB = getRouteCentroid(routeB, neighborhoodsMap);
      let distanceKm: number | null = null;
      if (centroidA && centroidB) {
        distanceKm = haversineDistanceKm(centroidA.lat, centroidA.lng, centroidB.lat, centroidB.lng);
        if (distanceKm > maxGeoDistanceKm) continue;
      }

      suggestions.push({
        routeAId: routeA.id,
        routeBId: routeB.id,
        sectorId: routeA.sectorId,
        timeDiffMinutes,
        combinedOrders,
        distanceKm,
      });
    }
  }

  // Melhores sugestões primeiro: menor diferença de horário = fusão mais segura.
  return suggestions.sort((a, b) => a.timeDiffMinutes - b.timeDiffMinutes);
};

// ─────────────────────────────────────────────────────────────
// DETECÇÃO DE OPORTUNIDADES — PROXIMIDADE ENTRE SETORES
// ─────────────────────────────────────────────────────────────
//
// Setores são uma divisão administrativa, não geográfica perfeita —
// um bairro na fronteira pode estar fisicamente mais perto de uma
// rota "do setor vizinho" do que de qualquer rota do seu próprio
// setor. Esta função NUNCA reatribui nada sozinha (mudar de setor é
// uma decisão de negócio, não só geográfica) — ela só sinaliza pro
// despachante avaliar.

export interface CrossSectorOpportunity {
  orderId: string;
  orderBairroNome: string;
  assignedSectorId: string;
  nearbyRouteId: string;
  nearbyRouteSectorId: string;
  distanceKm: number;
}

export const findCrossSectorOpportunities = (
  pendingOrders: Pedido[],
  openRoutes: Route[],
  neighborhoodsMap: Record<string, Neighborhood>,
  proximityThresholdKm: number = CROSS_SECTOR_PROXIMITY_KM,
  maxOrdersPerRoute: number = MAX_ORDERS_PER_ROUTE
): CrossSectorOpportunity[] => {
  const opportunities: CrossSectorOpportunity[] = [];

  for (const order of pendingOrders) {
    const info = neighborhoodsMap[normalizeToId(order.bairro_destinatario)];
    if (!info || info.lat == null || info.lng == null) continue;

    const orderMinutes = getMinutesFromOrder(order);
    const tolerance = isScheduledOrder(order)
      ? TIME_TOLERANCE_SCHEDULED_MINUTES
      : TIME_TOLERANCE_ESTIMATED_MINUTES;

    let closest: { route: Route; distanceKm: number } | null = null;

    for (const route of openRoutes) {
      if (route.sectorId === info.setor_id) continue; // só nos interessa OUTRO setor
      if (route.orders.length >= maxOrdersPerRoute) continue;

      const timeDiff = Math.abs(route.averageTimeMinutes - orderMinutes);
      if (timeDiff > tolerance) continue;

      const centroid = getRouteCentroid(route, neighborhoodsMap);
      if (!centroid) continue;

      const distanceKm = haversineDistanceKm(info.lat, info.lng, centroid.lat, centroid.lng);
      if (distanceKm > proximityThresholdKm) continue;

      if (!closest || distanceKm < closest.distanceKm) {
        closest = { route, distanceKm };
      }
    }

    if (closest) {
      opportunities.push({
        orderId: String(order.order_id),
        orderBairroNome: order.bairro_destinatario || info.nome,
        assignedSectorId: info.setor_id,
        nearbyRouteId: closest.route.id,
        nearbyRouteSectorId: closest.route.sectorId,
        distanceKm: closest.distanceKm,
      });
    }
  }

  return opportunities.sort((a, b) => a.distanceKm - b.distanceKm);
};