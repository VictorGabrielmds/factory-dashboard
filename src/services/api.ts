// ============================================================================
// src/services/api.ts
// Camada única de comunicação com as Cloud Functions.
//
// O que ela garante:
//   - Autenticação: toda chamada leva o Firebase ID token da sessão da equipe
//   - Timeout de 20s: internet lenta não deixa a tela "pendurada" para sempre
//   - Retry automático (até 3 tentativas) com backoff para falha de rede e
//     erros 5xx/429. É seguro porque o envio de mensagem manda a MESMA
//     idempotencyKey nas retentativas — o servidor descarta duplicatas.
//   - Erros 4xx NÃO são repetidos (são erros de dados, ex.: prazo de edição
//     expirado) e voltam para o chamador tratar normalmente.
// ============================================================================

import { auth } from "./firebase";

export const BASE_URL = "https://southamerica-east1-entregas-781a8.cloudfunctions.net";

const TIMEOUT_MS = 20000;
const MAX_TENTATIVAS = 3;

function ehTransitorio(status?: number): boolean {
  // Sem status = falha de rede/timeout. 5xx/429 = servidor sobrecarregado.
  return !status || status >= 500 || status === 429;
}

const dormir = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Substituto direto do fetch() para chamadas às Cloud Functions.
 * Mesma assinatura, mesmos retornos — só que autenticado, com timeout e retry.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const usuario = auth.currentUser;
  if (!usuario) throw new Error("Sua sessão expirou. Entre novamente para continuar.");

  const token = await usuario.getIdToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);

  let ultimoErro: unknown;

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const resp = await fetch(input, {
        cache: "no-store",
        ...init,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Sucesso, ou erro permanente (4xx) que o chamador deve tratar: retorna já.
      if (resp.ok || !ehTransitorio(resp.status)) return resp;

      ultimoErro = new Error(`HTTP ${resp.status}`);
    } catch (erro) {
      clearTimeout(timer);
      ultimoErro = erro; // rede caiu ou timeout
    }

    if (tentativa < MAX_TENTATIVAS - 1) {
      // Backoff exponencial + jitter: 600ms, ~1.2s...
      await dormir(600 * 2 ** tentativa + Math.random() * 300);
    }
  }

  throw ultimoErro;
}
