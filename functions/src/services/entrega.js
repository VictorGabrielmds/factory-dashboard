// ============================================================================
// SERVIÇO DE TAXA DE ENTREGA
// Compartilhado entre criarPedido (cobra de verdade) e consultarTaxaEntrega
// (só mostra uma prévia no carrinho antes de finalizar) — a mesma lógica de
// busca em zonas_entrega/{bairroNormalizado} com fallback pra taxa padrão.
// ============================================================================

const admin = require("firebase-admin");
const { calcularTempoEntregaGeoMinutos } = require("./geoEntrega");

const db = () => admin.firestore();

// Mesma normalização usada em ZonasEntregaDashboard.tsx (painel) — o ID do
// documento em zonas_entrega é o bairro normalizado, pra bater com o texto
// livre que vem do endereço do cliente (ViaCEP ou digitado à mão).
function normalizarBairro(bairro) {
  return bairro
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// Busca taxa E tempo estimado de entrega pro bairro num único par de leituras
// (zona + config) — usa a zona cadastrada (se ativa) ou cai nos padrões,
// nunca trava o checkout por falta de cadastro. Preço/tempo do cliente nunca
// são confiados: quem decide de verdade é sempre esta função (criarPedido
// recalcula do zero, consultarTaxaEntrega só mostra uma prévia).
// tempoEntregaMinutos alimenta a antecedência mínima de agendamento: um
// bairro a 40min de moto não pode ficar disponível pra daqui 10min.
async function buscarInfoZona(bairro) {
  const [zonaSnap, configSnap] = await Promise.all([
    db().collection("zonas_entrega").doc(normalizarBairro(bairro)).get(),
    db().collection("configuracoes").doc("entrega").get(),
  ]);
  const configDados = configSnap.data() || {};
  const tempoPadrao = Number(configDados.tempoEntregaPadraoMinutos) || 0;
  // Estimativa por distância real da loja (bairro São Francisco) até o
  // bairro do cliente — só cai pro tempo padrão fixo do painel se o bairro
  // não tiver coordenada conhecida (ver services/geoEntrega.js).
  const tempoInteligente = calcularTempoEntregaGeoMinutos(bairro) ?? tempoPadrao;

  if (zonaSnap.exists && zonaSnap.data().ativo) {
    const zona = zonaSnap.data();
    return {
      taxa: zona.taxa,
      tempoEntregaMinutos: zona.tempoEntregaMinutos != null ? Number(zona.tempoEntregaMinutos) : tempoInteligente,
    };
  }
  return { taxa: configDados.taxaPadrao || 0, tempoEntregaMinutos: tempoInteligente };
}

// Só os NOMES dos bairros ativos, pra alimentar o autocomplete do endereço
// no app cliente — não expõe taxa nem nenhum outro dado da zona.
async function listarBairrosAtivos() {
  const snap = await db().collection("zonas_entrega").where("ativo", "==", true).get();
  return snap.docs.map((d) => d.data().bairro).sort((a, b) => a.localeCompare(b));
}

module.exports = { normalizarBairro, buscarInfoZona, listarBairrosAtivos };
