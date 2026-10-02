// ============================================================================
// PONTO DE ENTRADA
//
// Arquitetura:
//   src/config.js          → segredos (Secret Manager) e constantes
//   src/lib/               → http resiliente, segurança, utilitários puros
//   src/services/          → Meta API e regras de pedido/recibo/ficha
//   src/webhooks/          → receptores (ACK rápido) — Meta, InstaDelivery, Asaas
//   src/triggers/          → processadores assíncronos (fila de eventos, outbox)
//   src/api/               → endpoints do painel (autenticados)
//   src/cliente/           → endpoints PÚBLICOS do app cliente (sem sessão
//                             prévia — só App Check como defesa de origem)
//
// Fluxos:
//   Meta → webhookWhatsApp (valida assinatura, enfileira, 200 em ms)
//        → processarEventoMeta (mídia, push, status — com retry)
//   InstaDelivery → webhookPedidos (inbox durável, 200 em ms)
//                 → processarEventoPedidoInsta (salva/atualiza pedido)
//                 → notificarStatusPedido (dedup por transação, envia templates)
//   Painel → grava em outbox/ (Firestore SDK = funciona offline)
//          → processarOutbox (entrega com retry)
//   Asaas → webhookAsaas (persiste e responde) → processarEventoAsaas
//         → reconciliarPixAsaas (segunda via programada independente)
//   App cliente → solicitarLoginWhatsApp / validarLoginWhatsApp (login por
//                 código WhatsApp, ver src/cliente/authWhatsApp.js)
//   App cliente → solicitarAlteracao (injeta a solicitação direto em
//                 conversas/ como se fosse uma mensagem recebida — ver
//                 src/cliente/solicitarAlteracao.js)
// ============================================================================

const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp({
  storageBucket: "entregas-781a8.firebasestorage.app", // sem o prefixo gs://
});

// Padrões econômicos; funções críticas sobrescrevem memória/CPU localmente.
setGlobalOptions({
  region: "southamerica-east1",
  memory: "256MiB",
  maxInstances: 10,
  timeoutSeconds: 60,
});

// ── Webhooks (receptores) ────────────────────────────────────────────────────
const { webhookWhatsApp, processarEventoMeta } = require("./src/webhooks/whatsapp");
const {
  webhookPedidos,
  webhookPedidosBackup,
  processarEventoPedidoInsta,
  reconciliarInboxPedidos,
  notificarStatusPedido,
} = require("./src/webhooks/pedidos");
const {
  webhookAsaas,
  processarEventoAsaas,
  reconciliarPixAsaas,
} = require("./src/webhooks/asaas");

// ── Triggers assíncronos ─────────────────────────────────────────────────────
const { processarOutbox } = require("./src/triggers/outbox");
const {
  processarNotificacaoCancelamentoCriada: processarNotificacaoCancelamentoFila,
  reconciliarNotificacoesPedido,
} = require("./src/triggers/notificacoesPedido");
const { checarSaudeRobo } = require("./src/triggers/roboSaude");
const { filaMortaAlertas } = require("./src/triggers/filaMortaAlertas");

// ── APIs do painel ───────────────────────────────────────────────────────────
const { chat } = require("./src/api/chat");
const { conversas } = require("./src/api/conversas");
const { configuracoes, pendencias } = require("./src/api/configuracoes");
const { clientes } = require("./src/api/clientes");
const { pedidos } = require("./src/api/pedidos");
const { fiscal } = require("./src/api/fiscal");
const { impressao, resgatarPareamentoImpressao, confirmarPareamentoImpressao } = require("./src/impressao/pareamento");

// ── App cliente (público) ────────────────────────────────────────────────────
const { solicitarLoginWhatsApp, validarLoginWhatsApp } = require("./src/cliente/authWhatsApp");
const { validarCupom } = require("./src/cliente/cupons");
const {
  criarPedido,
  consultarCheckoutPedido,
  reconciliarCheckoutsPix,
} = require("./src/cliente/pedidos");
const { solicitarAlteracao } = require("./src/cliente/solicitarAlteracao");
const { solicitarAgendamentoFritura } = require("./src/cliente/agendamentoFritura");
const { consultarTaxaEntrega, listarBairrosEntrega } = require("./src/cliente/entrega");
const { consultarHorarioFuncionamento } = require("./src/cliente/horario");
const { consultarOrdemCategorias } = require("./src/cliente/categorias");
const { salvarEnderecoCliente, salvarEndereco, removerEndereco } = require("./src/cliente/endereco");
const { consultarConfiguracoesGerais } = require("./src/cliente/configuracoesGerais");

module.exports = {
  // Webhooks
  webhookWhatsApp,
  webhookPedidos,
  webhookPedidosBackup,
  webhookAsaas,
  // Processadores
  processarEventoAsaas,
  reconciliarPixAsaas,
  processarEventoPedidoInsta,
  reconciliarInboxPedidos,
  processarEventoMeta,
  notificarStatusPedido, // substitui o antigo gatilhoStatusPedido
  processarOutbox,
  processarNotificacaoCancelamentoFila,
  reconciliarNotificacoesPedido,
  checarSaudeRobo,
  filaMortaAlertas,
  // Painel
  chat,
  conversas,
  configuracoes,
  pendencias,
  clientes,
  pedidos,
  fiscal,
  // Só entra em produção com deploy explícito e teste operacional coordenado.
  impressao,
  resgatarPareamentoImpressao,
  confirmarPareamentoImpressao,
  // App cliente
  solicitarLoginWhatsApp,
  validarLoginWhatsApp,
  validarCupom,
  criarPedido,
  consultarCheckoutPedido,
  reconciliarCheckoutsPix,
  solicitarAlteracao,
  solicitarAgendamentoFritura,
  consultarTaxaEntrega,
  listarBairrosEntrega,
  consultarHorarioFuncionamento,
  consultarOrdemCategorias,
  salvarEnderecoCliente,
  salvarEndereco,
  removerEndereco,
  consultarConfiguracoesGerais,
};
