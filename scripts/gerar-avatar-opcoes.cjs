// Gera src/components/MotoboyDashboard/avatarOpcoes.ts baixando o schema
// oficial do DiceBear na hora.
//
//   node scripts/gerar-avatar-opcoes.cjs
//
// Um estilo só, "lorelei" — o mesmo dos avatares de cliente no chat (ver
// src/utils/chatHelpers.tsx). Motoboy e cliente têm que ter a mesma cara no
// sistema inteiro; por isso aqui não tem escolha de estilo.
//
// Rode quando o DiceBear soltar traços novos numa versão nova da API.
// Precisa de internet.
const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
const ESTILO = "lorelei";

// Só ruído de layout / coisas que a gente controla por fora.
const IGNORAR = new Set([
  "seed", "flip", "rotate", "scale", "radius", "size", "clip", "randomizeIds",
  "translateX", "translateY", "backgroundColor", "backgroundType", "backgroundRotation",
  "style",
]);

const ROTULOS = {
  hair: "Cabelo", hairColor: "Cor do cabelo", hairAccessories: "Enfeite no cabelo",
  hairAccessoriesColor: "Cor do enfeite",
  eyes: "Olhos", eyesColor: "Cor dos olhos", eyeShadowColor: "Sombra",
  eyebrows: "Sobrancelha", eyebrowsColor: "Cor da sobrancelha", brows: "Sobrancelha",
  mouth: "Boca", mouthColor: "Cor da boca", lips: "Boca",
  nose: "Nariz", noseColor: "Cor do nariz",
  head: "Rosto", face: "Rosto", ears: "Orelhas",
  skinColor: "Tom de pele", baseColor: "Cor base", base: "Base",
  beard: "Barba", facialHair: "Barba", facialHairColor: "Cor da barba",
  glasses: "Óculos", glassesColor: "Cor do óculos", accessories: "Acessório",
  accessoriesColor: "Cor do acessório",
  earrings: "Brinco", earringsColor: "Cor do brinco", earringColor: "Cor do brinco",
  freckles: "Sardas", frecklesColor: "Cor das sardas", features: "Detalhe",
  clothing: "Roupa", clothesColor: "Cor da roupa", clothingGraphic: "Estampa",
  shirt: "Camisa", shirtColor: "Cor da camisa", top: "Topo", hatColor: "Cor do chapéu",
  sides: "Laterais", texture: "Textura", body: "Corpo", bodyIcon: "Ícone do corpo",
  gesture: "Gesto",
};

// O schema não traz paleta para estes (são traços vetoriais pretos por padrão).
// Paleta nossa, pensada pra dar variedade sem ficar berrante.
const PALETAS_EXTRA = {
  hairColor: ["0e0e0e", "3a2317", "6b4423", "a55728", "c9863f", "e5d7a3", "b0b0b0"],
  skinColor: ["ffffff", "f2d3b1", "ecad80", "d08b5b", "9e5622", "763900"],
  eyesColor: ["0e0e0e", "3a2317", "1f5c8b", "3d7a4a"],
  eyebrowsColor: ["0e0e0e", "3a2317", "6b4423", "a55728", "b0b0b0"],
  mouthColor: ["0e0e0e", "b4494b", "d05f61"],
  noseColor: ["0e0e0e", "6b4423"],
  glassesColor: ["0e0e0e", "6b4423", "1f5c8b", "b4494b"],
  earringsColor: ["0e0e0e", "c9863f", "b0b0b0"],
  frecklesColor: ["0e0e0e", "a55728"],
  hairAccessoriesColor: ["0e0e0e", "b4494b", "1f5c8b", "c9863f"],
};

const ehCor = (k) => /Color$/.test(k);

// O schema devolve as listas em ordem meio aleatória (variant63 primeiro,
// happy18 no meio dos happy0x). Agrupa por prefixo e ordena pelo número —
// o que não seguir "prefixo+número" fica no fim, na ordem original.
function ordenarNatural(lista) {
  const casa = [], resto = [];
  for (const x of lista) (/^([A-Za-z]+)(\d+)$/.test(x) ? casa : resto).push(x);
  casa.sort((a, b) => {
    const [, pa, na] = a.match(/^([A-Za-z]+)(\d+)$/);
    const [, pb, nb] = b.match(/^([A-Za-z]+)(\d+)$/);
    return pa === pb ? Number(na) - Number(nb) : pa.localeCompare(pb);
  });
  return [...casa, ...resto];
}

function comprimirVariantes(lista) {
  // "variant01..variantNN" contíguo vira uma chamada v(NN) no arquivo final.
  const n = lista.length;
  const esperado = new Set();
  for (let i = 1; i <= n; i++) esperado.add("variant" + String(i).padStart(2, "0"));
  if (lista.length === esperado.size && lista.every((x) => esperado.has(x))) return { v: n };
  return null;
}

async function main() {
  const resp = await fetch(`https://api.dicebear.com/9.x/${ESTILO}/schema.json`);
  if (!resp.ok) throw new Error(`schema de ${ESTILO}: HTTP ${resp.status}`);
  const schema = await resp.json();
  const props = schema.properties || {};
  const tracos = [];

  for (const [chave, def] of Object.entries(props)) {
    if (IGNORAR.has(chave)) continue;
    if (/Probability$/.test(chave)) continue;
    if (def.type !== "array") continue;

    let valores = Array.isArray(def.default) ? def.default.slice() : [];
    if (ehCor(chave) && PALETAS_EXTRA[chave]) valores = PALETAS_EXTRA[chave];
    if (!ehCor(chave)) valores = ordenarNatural(valores);

    const opcional = Object.prototype.hasOwnProperty.call(props, chave + "Probability");
    // Traço opcional de valor único ainda vale: vira liga/desliga (ex.: sardas).
    // Sem isso a cor dele ficava órfã na tela, sem o traço pra pintar.
    if (valores.length < 2 && !(opcional && valores.length === 1)) continue;

    tracos.push({
      chave,
      rotulo: ROTULOS[chave] || chave,
      cor: ehCor(chave),
      // "Nenhum" só faz sentido pra traço que o DiceBear trata como opcional.
      opcional,
      valores,
    });
  }

  // Cor logo depois do traço a que ela pertence, pra leitura ficar natural.
  const ordem = [];
  const usados = new Set();
  for (const t of tracos) {
    if (t.cor || usados.has(t.chave)) continue;
    ordem.push(t); usados.add(t.chave);
    const irma = tracos.find((o) => o.cor && o.chave === t.chave + "Color");
    if (irma && !usados.has(irma.chave)) {
      // Só interessa registrar o pai quando ele pode ser desligado: aí a tela
      // esconde a cor. Pai obrigatório está sempre presente, não tem o que
      // esconder.
      if (t.opcional) irma.pai = t.chave;
      ordem.push(irma); usados.add(irma.chave);
    }
  }
  for (const t of tracos) if (!usados.has(t.chave)) { ordem.push(t); usados.add(t.chave); }

  // ─── emite o TS ───
  const linhas = [];
  linhas.push(`// ============================================================================`);
  linhas.push(`// CATÁLOGO DE TRAÇOS DO AVATAR`);
  linhas.push(`// GERADO do schema oficial do DiceBear 9.x`);
  linhas.push(`// (https://api.dicebear.com/9.x/${ESTILO}/schema.json).`);
  linhas.push(`//`);
  linhas.push(`// Cada traço vira um parâmetro na URL da imagem. Passar UM valor numa opção`);
  linhas.push(`// que aceita lista força aquele desenho — é assim que "montar o avatar"`);
  linhas.push(`// funciona sem biblioteca nenhuma instalada, só URL.`);
  linhas.push(`//`);
  linhas.push(`// NÃO EDITE À MÃO — rode: node scripts/gerar-avatar-opcoes.cjs`);
  linhas.push(`// ============================================================================`);
  linhas.push(``);
  linhas.push(`export type Traco = {`);
  linhas.push(`  chave: string;`);
  linhas.push(`  rotulo: string;`);
  linhas.push(`  cor: boolean;`);
  linhas.push(`  /** Traço que o DiceBear sabe omitir — ganha a opção "Nenhum". */`);
  linhas.push(`  opcional: boolean;`);
  linhas.push(`  valores: string[];`);
  linhas.push(`};`);
  linhas.push(``);
  linhas.push(`// variant01..variantNN — a maioria dos traços segue essa sequência.`);
  linhas.push(`const v = (n: number): string[] =>`);
  linhas.push(`  Array.from({ length: n }, (_, i) => \`variant\${String(i + 1).padStart(2, "0")}\`);`);
  linhas.push(``);
  linhas.push(`export const TRACOS: Traco[] = [`);
  for (const t of ordem) {
    const comp = comprimirVariantes(t.valores);
    const vals = comp ? `v(${comp.v})` : JSON.stringify(t.valores);
    linhas.push(
      `  { chave: ${JSON.stringify(t.chave)}, rotulo: ${JSON.stringify(t.rotulo)}, cor: ${t.cor}, opcional: ${t.opcional}, valores: ${vals} },`
    );
  }
  linhas.push(`];`);
  linhas.push(``);

  const destino = path.join(RAIZ, "src", "components", "MotoboyDashboard", "avatarOpcoes.ts");
  fs.writeFileSync(destino, linhas.join("\n"), "utf8");

  console.log(`gerado: ${path.relative(RAIZ, destino)}`);
  console.log(`  ${ESTILO}: ${ordem.length} traços, ${ordem.reduce((a, t) => a + t.valores.length, 0)} valores`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
