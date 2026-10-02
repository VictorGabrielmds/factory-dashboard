// ============================================================================
// AVATAR DO MOTOBOY
// Mesmo estilo dos avatares de cliente no chat: DiceBear "lorelei" via URL
// (ver src/utils/chatHelpers.tsx). Estilo é FIXO de propósito — motoboy e
// cliente têm que ter a mesma cara no sistema inteiro.
//
// A diferença é que aqui o desenho é MONTADO: cada traço e cor fica salvo no
// próprio doc do motoboy, então a equipe desenha a carinha em vez de depender
// do hash do nome.
//
// Sem nada salvo, cai no nome (comportamento idêntico ao do chat), o que
// mantém todos os motoboys já cadastrados com um avatar imediatamente, sem
// precisar de migração de dados.
//
// O catálogo de traços está em avatarOpcoes.ts (gerado do schema oficial).
// ============================================================================

import { TRACOS } from "./avatarOpcoes";

/** O mesmo do chat. Não vire isto em opção de tela. */
export const ESTILO_AVATAR = "lorelei";

// Mesma paleta de fundo usada no chat, pra equipe/cliente terem a mesma cara.
export const FUNDOS = ["bfdbfe", "bbf7d0", "fde68a", "fecaca", "e9d5ff", "fed7aa"];

/** Traço marcado como "Nenhum" — o DiceBear omite via <traço>Probability=0. */
export const SEM_TRACO = "";

export type ConfigAvatar = {
  nome: string;
  avatarSeed?: string;
  /** { hair: "variant05", hairColor: "6b4423", glasses: "" } */
  avatarOpcoes?: Record<string, string>;
  avatarFundo?: string;
};

function hashDe(texto: string): number {
  let hash = 0;
  for (let i = 0; i < texto.length; i++) {
    hash = texto.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

export function urlAvatarMotoboy(
  { nome, avatarSeed, avatarOpcoes, avatarFundo }: ConfigAvatar,
  size = 44
): string {
  const semente = (avatarSeed || "").trim() || nome;
  const fundo = avatarFundo || FUNDOS[hashDe(semente) % FUNDOS.length];

  const params = new URLSearchParams({
    seed: semente,
    size: String(size),
    radius: "50",
    backgroundColor: fundo,
  });

  // Passar UM valor numa opção que aceita lista força aquele desenho; o que
  // não for escolhido fica de fora e o DiceBear sorteia a partir da semente.
  for (const traco of TRACOS) {
    const escolhido = avatarOpcoes?.[traco.chave];
    if (escolhido === undefined) continue;

    if (escolhido === SEM_TRACO) {
      // Só faz sentido em traço opcional — nos demais, ignorar é o certo,
      // senão a URL sairia com um parâmetro vazio que o DiceBear rejeita.
      if (traco.opcional) params.set(`${traco.chave}Probability`, "0");
      continue;
    }

    params.set(traco.chave, escolhido);
    if (traco.opcional) params.set(`${traco.chave}Probability`, "100");
  }

  return `https://api.dicebear.com/9.x/${ESTILO_AVATAR}/svg?${params.toString()}`;
}

// Semente nova — o que o desenho não define explicitamente sai daqui.
export function sortearSementeAvatar(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Sorteia um valor para cada traço — o "surpreenda-me" do editor. */
export function sortearTracos(): Record<string, string> {
  const escolha: Record<string, string> = {};
  for (const traco of TRACOS) {
    // Traço opcional entra em ~metade dos sorteios, senão todo mundo sai
    // de óculos, barba e brinco ao mesmo tempo.
    if (traco.opcional && Math.random() < 0.5) {
      escolha[traco.chave] = SEM_TRACO;
      continue;
    }
    escolha[traco.chave] = traco.valores[Math.floor(Math.random() * traco.valores.length)];
  }
  return escolha;
}

/**
 * Descarta o que o catálogo não reconhece. A API devolve 400 (imagem quebrada)
 * pra valor inválido, então isto protege contra doc editado à mão no Console e
 * contra catálogo regerado com traço que sumiu numa versão nova da API.
 */
export function limparTracos(
  opcoes: Record<string, string> | undefined
): Record<string, string> {
  if (!opcoes) return {};
  const limpo: Record<string, string> = {};
  for (const traco of TRACOS) {
    const valor = opcoes[traco.chave];
    if (valor === undefined) continue;
    if (valor === SEM_TRACO) {
      if (traco.opcional) limpo[traco.chave] = SEM_TRACO;
      continue;
    }
    if (traco.valores.includes(valor)) limpo[traco.chave] = valor;
  }
  return limpo;
}
