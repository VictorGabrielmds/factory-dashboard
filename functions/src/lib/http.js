// ============================================================================
// CLIENTE HTTP RESILIENTE
// - Timeout em toda chamada (nada fica pendurado travando a function)
// - Retry automático com backoff exponencial + jitter para erros transitórios
//   (rede caiu, 429 rate-limit, 5xx da Meta). Erros 4xx NÃO são repetidos:
//   são erros permanentes (payload errado, template reprovado etc.)
// ============================================================================

const axios = require("axios");

const TIMEOUT_PADRAO_MS = 15000;

function eTransitorio(erro) {
  if (!erro.response) return true; // erro de rede/timeout — vale repetir
  const s = erro.response.status;
  return s === 429 || s >= 500;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Circuit breaker por serviço externo (Meta, Asaas, ...) ──────────────────
// O retry acima já lida com UMA chamada falhando de forma transitória. Isto
// aqui olha para o histórico do serviço como um todo: depois de falhas
// consecutivas, para de tentar por um tempo em vez de gastar segundos de
// execução (e dinheiro) repetindo uma chamada que já sabemos que vai falhar.
// A instância da function é efêmera (cold start reseta este Map), então a
// proteção vale só durante a vida de uma instância "quente" — ainda assim
// evita desperdício real durante uma queda sustentada da API externa.
const LIMITE_FALHAS_CIRCUITO = 3;
const JANELA_ABERTO_MS = 20000;
const estadoCircuitos = new Map(); // nome do circuito -> { falhas, abertoAte }

function circuitoEstaAberto(circuito) {
  const estado = estadoCircuitos.get(circuito);
  return !!estado?.abertoAte && Date.now() < estado.abertoAte;
}

function registrarSucessoCircuito(circuito) {
  estadoCircuitos.set(circuito, { falhas: 0, abertoAte: null });
}

function registrarFalhaCircuito(circuito) {
  const estado = estadoCircuitos.get(circuito) || { falhas: 0, abertoAte: null };
  estado.falhas += 1;
  if (estado.falhas >= LIMITE_FALHAS_CIRCUITO) {
    estado.abertoAte = Date.now() + JANELA_ABERTO_MS;
  }
  estadoCircuitos.set(circuito, estado);
}

class CircuitoAbertoError extends Error {
  constructor(circuito) {
    super(`Circuito "${circuito}" aberto — falhas recentes demais, pulando chamada.`);
    this.name = "CircuitoAbertoError";
    this.circuito = circuito;
  }
}

/**
 * Executa uma chamada axios com retentativas.
 * @param {Function} fazerChamada - () => Promise (a chamada axios)
 * @param {Object}   opts - { tentativas = 3, baseMs = 500, rotulo = "", circuito = null }
 *   circuito: nome do serviço externo (ex.: "meta", "asaas") para agrupar o
 *   circuit breaker. Sem isso, roda só com retry, sem circuit breaker.
 */
async function comRetentativa(fazerChamada, { tentativas = 3, baseMs = 500, rotulo = "", circuito = null } = {}) {
  if (circuito && circuitoEstaAberto(circuito)) {
    console.warn(`[circuito:${circuito}] aberto — pulando chamada "${rotulo}" sem tentar a rede.`);
    throw new CircuitoAbertoError(circuito);
  }

  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const resultado = await fazerChamada();
      if (circuito) registrarSucessoCircuito(circuito);
      return resultado;
    } catch (erro) {
      ultimoErro = erro;
      if (!eTransitorio(erro) || i === tentativas - 1) break;
      const espera = baseMs * 2 ** i + Math.floor(Math.random() * 250);
      console.warn(`[retry:${rotulo}] tentativa ${i + 1} falhou (${erro.response?.status ?? erro.code ?? erro.message}). Repetindo em ${espera}ms`);
      await dormir(espera);
    }
  }
  if (circuito) registrarFalhaCircuito(circuito);
  throw ultimoErro;
}

function clienteHttp(extra = {}) {
  return axios.create({ timeout: TIMEOUT_PADRAO_MS, ...extra });
}

const http = clienteHttp();

module.exports = { http, clienteHttp, comRetentativa, CircuitoAbertoError };
