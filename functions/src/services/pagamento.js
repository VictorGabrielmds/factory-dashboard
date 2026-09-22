// ============================================================================
// CONFIGURAÇÕES GERAIS — taxa de cartão, tempo de preparo padrão e WhatsApp
// Doc único configuracoes/geral, staff-only nas regras (mesma coleção de
// horário/entrega/categorias) — o app cliente lê através de uma Cloud
// Function em vez de acessar o Firestore direto.
// ============================================================================

const admin = require("firebase-admin");

const db = () => admin.firestore();

async function buscarConfiguracaoGeral() {
  const snap = await db().collection("configuracoes").doc("geral").get();
  const dados = snap.data() || {};
  return {
    taxaDebitoPercentual: Number(dados.taxaDebitoPercentual) || 0,
    taxaCreditoPercentual: Number(dados.taxaCreditoPercentual) || 0,
    whatsappLoja: String(dados.whatsappLoja || ""),
    tempoPreparoPadraoMinutos: Number(dados.tempoPreparoPadraoMinutos) || 0,
    valorMinimoEntrega: Number(dados.valorMinimoEntrega) || 0,
    enderecoLojaTexto: String(dados.enderecoLojaTexto || ""),
    enderecoLojaLink: String(dados.enderecoLojaLink || ""),
  };
}

module.exports = { buscarConfiguracaoGeral };
