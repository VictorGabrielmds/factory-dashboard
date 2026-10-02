// ============================================================================
// CATÁLOGO DE TRAÇOS DO AVATAR
// GERADO do schema oficial do DiceBear 9.x
// (https://api.dicebear.com/9.x/lorelei/schema.json).
//
// Cada traço vira um parâmetro na URL da imagem. Passar UM valor numa opção
// que aceita lista força aquele desenho — é assim que "montar o avatar"
// funciona sem biblioteca nenhuma instalada, só URL.
//
// NÃO EDITE À MÃO — rode: node scripts/gerar-avatar-opcoes.cjs
// ============================================================================

export type Traco = {
  chave: string;
  rotulo: string;
  cor: boolean;
  /** Traço que o DiceBear sabe omitir — ganha a opção "Nenhum". */
  opcional: boolean;
  valores: string[];
};

// variant01..variantNN — a maioria dos traços segue essa sequência.
const v = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `variant${String(i + 1).padStart(2, "0")}`);

export const TRACOS: Traco[] = [
  { chave: "beard", rotulo: "Barba", cor: false, opcional: true, valores: v(2) },
  { chave: "earrings", rotulo: "Brinco", cor: false, opcional: true, valores: v(3) },
  { chave: "earringsColor", rotulo: "Cor do brinco", cor: true, opcional: false, valores: ["0e0e0e","c9863f","b0b0b0"] },
  { chave: "eyebrows", rotulo: "Sobrancelha", cor: false, opcional: false, valores: v(13) },
  { chave: "eyebrowsColor", rotulo: "Cor da sobrancelha", cor: true, opcional: false, valores: ["0e0e0e","3a2317","6b4423","a55728","b0b0b0"] },
  { chave: "eyes", rotulo: "Olhos", cor: false, opcional: false, valores: v(24) },
  { chave: "eyesColor", rotulo: "Cor dos olhos", cor: true, opcional: false, valores: ["0e0e0e","3a2317","1f5c8b","3d7a4a"] },
  { chave: "freckles", rotulo: "Sardas", cor: false, opcional: true, valores: v(1) },
  { chave: "frecklesColor", rotulo: "Cor das sardas", cor: true, opcional: false, valores: ["0e0e0e","a55728"] },
  { chave: "glasses", rotulo: "Óculos", cor: false, opcional: true, valores: v(5) },
  { chave: "glassesColor", rotulo: "Cor do óculos", cor: true, opcional: false, valores: ["0e0e0e","6b4423","1f5c8b","b4494b"] },
  { chave: "hair", rotulo: "Cabelo", cor: false, opcional: false, valores: v(48) },
  { chave: "hairColor", rotulo: "Cor do cabelo", cor: true, opcional: false, valores: ["0e0e0e","3a2317","6b4423","a55728","c9863f","e5d7a3","b0b0b0"] },
  { chave: "hairAccessories", rotulo: "Enfeite no cabelo", cor: false, opcional: true, valores: ["flowers"] },
  { chave: "hairAccessoriesColor", rotulo: "Cor do enfeite", cor: true, opcional: false, valores: ["0e0e0e","b4494b","1f5c8b","c9863f"] },
  { chave: "head", rotulo: "Rosto", cor: false, opcional: false, valores: v(4) },
  { chave: "mouth", rotulo: "Boca", cor: false, opcional: false, valores: ["happy01","happy02","happy03","happy04","happy05","happy06","happy07","happy08","happy09","happy10","happy11","happy12","happy13","happy14","happy15","happy16","happy17","happy18","sad01","sad02","sad03","sad04","sad05","sad06","sad07","sad08","sad09"] },
  { chave: "mouthColor", rotulo: "Cor da boca", cor: true, opcional: false, valores: ["0e0e0e","b4494b","d05f61"] },
  { chave: "nose", rotulo: "Nariz", cor: false, opcional: false, valores: v(6) },
  { chave: "noseColor", rotulo: "Cor do nariz", cor: true, opcional: false, valores: ["0e0e0e","6b4423"] },
  { chave: "skinColor", rotulo: "Tom de pele", cor: true, opcional: false, valores: ["ffffff","f2d3b1","ecad80","d08b5b","9e5622","763900"] },
];
