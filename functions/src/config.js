// ============================================================================
// CONFIGURAÇÃO CENTRAL
// Nenhum segredo fica no código. Tudo vem do Secret Manager.
// Para cadastrar: firebase functions:secrets:set NOME_DO_SEGREDO
// ============================================================================

const { defineSecret } = require("firebase-functions/params");

// ── Segredos (Secret Manager) ────────────────────────────────────────────────
const TOKEN_META            = defineSecret("TOKEN_META");             // Token permanente da Meta (System User)
const META_APP_SECRET       = defineSecret("META_APP_SECRET");        // App Secret p/ validar assinatura do webhook
const META_VERIFY_TOKEN     = defineSecret("META_VERIFY_TOKEN");      // Token de verificação (hub.verify_token)
const ASAAS_WEBHOOK_TOKEN   = defineSecret("ASAAS_WEBHOOK_TOKEN");    // asaas-access-token
const ASAAS_API_KEY         = defineSecret("ASAAS_API_KEY");          // chave só-leitura (PAYMENT, FINANCIAL_TRANSACTION) p/ consultar pagador do PIX
const ASAAS_API_KEY_ESCRITA = defineSecret("ASAAS_API_KEY_ESCRITA");  // chave com permissão de criar cliente/cobrança — só pro checkout do app cliente
const PEDIDOS_WEBHOOK_TOKEN = defineSecret("PEDIDOS_WEBHOOK_TOKEN");  // ?token= do webhook do InstaDelivery
const PEDIDOS_WEBHOOK_BACKUP_TOKEN = defineSecret("PEDIDOS_WEBHOOK_BACKUP_TOKEN"); // token exclusivo do webhook 2
const OTP_HMAC_SECRET       = defineSecret("OTP_HMAC_SECRET");        // chave do HMAC do código de login do app cliente
const EFICIENCIA_FISCAL_TOKEN = defineSecret("EFICIENCIA_FISCAL_TOKEN"); // somente no backend fiscal

// Lista pronta para passar em { secrets: [...] } nas functions
const SEGREDOS_META   = [TOKEN_META, META_APP_SECRET, META_VERIFY_TOKEN];
const SEGREDOS_CHAT   = [TOKEN_META];
const SEGREDOS_LOGIN_CLIENTE = [TOKEN_META, OTP_HMAC_SECRET];

// ── Constantes não sensíveis ─────────────────────────────────────────────────
const PHONE_ID = "1107840569088265";
const WABA_ID  = "1372030254823398";
const GRAPH    = "https://graph.facebook.com/v19.0";
const ASAAS_API_BASE = "https://api.asaas.com/v3"; // produção (não sandbox)

// ⚠️ Troque pelos domínios reais do seu painel (CORS restrito = mais seguro)
// Um domínio que serve o painel mas NÃO está aqui não recebe o header
// Access-Control-Allow-Origin, e o navegador derruba TODA chamada de api.ts
// (chat, clientes, conversas, pendências, configurações) com um genérico
// "Failed to fetch" — a tela abre normalmente e só os dados não chegam, o
// que faz parecer erro de backend quando é só origem não liberada.
const ORIGENS_PAINEL = [
  "https://victorgabrielmds.github.io",   // GitHub Pages (deploy histórico)
  "https://entregas-781a8-painel.web.app", // Firebase Hosting (alvo de `deploy --only hosting:painel`)
  "https://entregas-781a8-painel.firebaseapp.com", // domínio irmão que o Hosting também serve
  "http://localhost:5173",                 // Vite padrão
  "http://localhost:5188",                 // porta fixada em .claude/launch.json
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

const DICIONARIO_PAGAMENTO = {
  "01": "Dinheiro",
  "03": "Cartão de crédito",
  "04": "Cartão de débito",
  "10": "Vale Refeição / Alimentação",
  "17": "PIX",
  "42": "Cartão de crédito online",
  "43": "iFood pago",
  "47": "Fiado",
  "48": "Ticket Online",
  "99": "Outras",
};

module.exports = {
  TOKEN_META, META_APP_SECRET, META_VERIFY_TOKEN,
  ASAAS_WEBHOOK_TOKEN, ASAAS_API_KEY, ASAAS_API_KEY_ESCRITA,
  PEDIDOS_WEBHOOK_TOKEN, PEDIDOS_WEBHOOK_BACKUP_TOKEN,
  OTP_HMAC_SECRET, EFICIENCIA_FISCAL_TOKEN,
  SEGREDOS_META, SEGREDOS_CHAT, SEGREDOS_LOGIN_CLIENTE,
  PHONE_ID, WABA_ID, GRAPH, ASAAS_API_BASE, ORIGENS_PAINEL, DICIONARIO_PAGAMENTO,
};
