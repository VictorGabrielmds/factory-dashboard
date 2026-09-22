// ============================================================================
// ESTIMATIVA DE TEMPO DE ENTREGA POR DISTÂNCIA
// A loja fica no bairro São Francisco — calcula a distância real (linha reta
// com um fator de correção pra ruas) até o bairro do cliente e estima quanto
// tempo uma moto leva pra fazer o trajeto com segurança. Usado como
// tempoEntregaMinutos padrão em buscarInfoZona (services/entrega.js) quando
// o bairro não tem um valor manual cadastrado — substitui o "tempo padrão"
// fixo (igual pra qualquer bairro) por uma estimativa que considera a
// distância de verdade.
// ============================================================================

const { BAIRROS } = require("../data/bairrosGeo");

const NOME_BAIRRO_LOJA = "SÃO FRANCISCO";
const VELOCIDADE_MEDIA_KMH = 25; // moto em trânsito urbano, com paradas/sinais
const FATOR_ROTA = 1.3; // ruas não são linha reta — corrige a distância "de pássaro"
const MARGEM_SEGURANCA_MINUTOS = 5;

// Mesma normalização de services/entrega.js — duplicada de propósito (é
// pouca lógica, cada peça deste sistema fica independente).
function normalizarBairro(bairro) {
  return bairro
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

const COORDENADAS_POR_BAIRRO = new Map(
  BAIRROS.map((b) => [normalizarBairro(b.nome), { lat: b.lat, lng: b.lng }])
);

const COORDENADAS_LOJA = COORDENADAS_POR_BAIRRO.get(normalizarBairro(NOME_BAIRRO_LOJA));

function distanciaKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Retorna null se o bairro (ou a loja) não tem coordenada conhecida — quem
// chama cai pro tempo padrão configurado no painel nesse caso.
function calcularTempoEntregaGeoMinutos(bairro) {
  if (!COORDENADAS_LOJA) return null;
  const destino = COORDENADAS_POR_BAIRRO.get(normalizarBairro(bairro));
  if (!destino) return null;

  const km = distanciaKm(COORDENADAS_LOJA.lat, COORDENADAS_LOJA.lng, destino.lat, destino.lng);
  const minutos = (km * FATOR_ROTA * 60) / VELOCIDADE_MEDIA_KMH + MARGEM_SEGURANCA_MINUTOS;
  return Math.ceil(minutos / 5) * 5; // arredonda pra múltiplo de 5 (UX mais limpa)
}

module.exports = { calcularTempoEntregaGeoMinutos };
