# Nova arquitetura — WhatsApp Business + Pedidos + PIX

## O que mudou e por quê

| Problema no código antigo | Solução na nova arquitetura |
|---|---|
| Token da Meta, verify token e senha do Asaas **hardcoded** no código | Tudo no **Secret Manager** (`defineSecret`) |
| Webhook da Meta **sem validação de assinatura** — qualquer um podia injetar mensagens falsas | Validação **HMAC X-Hub-Signature-256** obrigatória |
| Endpoints do painel (`chat`, `conversas`, `configuracoes`, `pendencias`) **abertos para o mundo** — qualquer pessoa podia enviar WhatsApp em nome da loja e apagar conversas | **Autenticação obrigatória**: sessão Firebase revogável e documento `staff/{uid}` ativo. CORS restrito aos domínios do painel |
| Webhook processava tudo (mídia, push, templates) **antes de responder** → Meta dava timeout e **reenviava** → mensagens duplicadas | **ACK rápido + fila**: o webhook só grava o evento e responde em milissegundos. Um trigger processa depois, com **retry automático** |
| Webhook do InstaDelivery reenviado = **recibo enviado 2x ao cliente** | Notificação sai de um **gatilho único** com **dedup por transação** (`notificados.{status}`) — impossível notificar o mesmo status duas vezes |
| Idempotência do chat com `get → set` (race condition em clique duplo rápido) | `create()` **atômico**: a segunda gravação da mesma chave falha nativamente |
| Internet ruim no computador do operador → mensagem perdida ou duplicada | **Outbox**: o painel grava no Firestore (SDK tem fila offline nativa); a function entrega com retry |
| Chamadas à Meta **sem timeout nem retry** | Cliente HTTP com timeout de 15s e **backoff exponencial + jitter** para 429/5xx/rede |
| PIX dependia do payload do webhook e podia cair em heurística por valor | Evento persistido antes do ACK, consulta direta da cobrança no Asaas, validação estrita de `paymentId + externalReference + PIX + RECEIVED + valor`, transação única e reconciliação programada |
| Comparação de tokens com `===` (vulnerável a timing attack) | `crypto.timingSafeEqual` em todas as comparações de segredo |

## Passo a passo de migração

### 1. Cadastrar os segredos (uma vez)

```bash
firebase functions:secrets:set TOKEN_META             # token permanente (System User) da Meta
firebase functions:secrets:set META_APP_SECRET        # Meta App → Configurações → Básico → App Secret
firebase functions:secrets:set META_VERIFY_TOKEN      # invente uma senha forte (ex.: openssl rand -hex 24)
firebase functions:secrets:set ASAAS_WEBHOOK_TOKEN    # a mesma senha cadastrada no webhook do Asaas
firebase functions:secrets:set ASAAS_API_KEY          # chave somente leitura: PAYMENT:READ
firebase functions:secrets:set ASAAS_API_KEY_ESCRITA  # chave restrita usada pelo checkout para criar cliente/cobrança PIX
firebase functions:secrets:set PEDIDOS_WEBHOOK_TOKEN  # senha forte para a URL do InstaDelivery
```

> ⚠️ **O token da Meta que estava no código antigo vazou junto com o arquivo. Revogue-o no painel da Meta e gere um novo** antes de cadastrar.

### 2. Ajustar `src/config.js`

- Troque `ORIGENS_PAINEL` pelos domínios reais do seu painel.

### 3. Atualizar as URLs nos serviços externos

- **InstaDelivery**: `https://southamerica-east1-entregas-781a8.cloudfunctions.net/webhookPedidos?token=SEU_PEDIDOS_WEBHOOK_TOKEN`
- **Meta**: reverifique o webhook usando o novo `META_VERIFY_TOKEN`.
- **Asaas**: confirme que o `asaas-access-token` cadastrado lá é igual ao segredo e habilite os eventos
  `PAYMENT_RECEIVED`, `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED` e
  `PAYMENT_REFUND_IN_PROGRESS`.

### 4. Deploy

```bash
cd functions
npm install
firebase deploy --only functions,firestore:rules
```

O antigo `gatilhoStatusPedido` deixa de existir — o deploy pedirá confirmação para removê-lo (**confirme**; o novo `notificarStatusPedido` o substitui e cobre todos os status).

### 5. Limpeza automática (TTL do Firestore)

No console → Firestore → *TTL policies*, crie:

| Coleção | Campo |
|---|---|
| `_idempotency` | `expiraEm` |
| `eventos_meta` | `recebidoEm` (opcional; ou mantenha para auditoria) |
| `eventos_asaas` | `expiraEm` |

### 6. Mudanças no painel (frontend)

**a) Autenticação nas chamadas HTTP** — envie o ID token da sessão Firebase de um membro ativo em `staff/{uid}`:

```js
headers: { "Content-Type": "application/json", Authorization: `Bearer ${await auth.currentUser.getIdToken()}` }
```

**b) Envio de mensagens offline-first (recomendado)** — em vez de chamar `/chat`, grave direto no Firestore:

```js
import { doc, setDoc } from "firebase/firestore";
import { v4 as uuid } from "uuid";

// O SDK enfileira localmente se a internet cair e sincroniza sozinho depois.
// O mesmo id nunca gera duas mensagens.
await setDoc(doc(db, "outbox", uuid()), {
  telefone, texto, mediaUrl: null, mediaType: null, replyToMsgId: null,
});
```

E ative a persistência offline uma vez na inicialização:

```js
import { initializeFirestore, persistentLocalCache } from "firebase/firestore";
const db = initializeFirestore(app, { localCache: persistentLocalCache() });
```

Com isso: internet caiu → a mensagem fica na fila local e sai quando voltar; computador lento → a UI responde na hora (gravação local); clique duplo → mesmo id, mesma mensagem. O endpoint `/chat` continua funcionando para compatibilidade enquanto você migra.

**c) Login** — crie um usuário no Firebase Authentication para a loja; as regras do Firestore agora exigem login para ler conversas e escrever no outbox.

## Coleções novas

- `eventos_meta/` — fila de eventos do webhook da Meta (dedup por id da mensagem)
- `eventos_asaas/` — fila/auditoria de eventos financeiros (dedup pelo id oficial do evento)
- `outbox/` — fila de envio do painel
- `pagamentos_asaas/` — dedup de pagamentos já casados
- Campo novo em `pedidos/`: `notificados: {2: true, 3: true, ...}` (controle antiduplicação)

## Fluxos

```
Meta ──POST──▶ webhookWhatsApp ──create()──▶ eventos_meta/ ──trigger──▶ processarEventoMeta
              (valida HMAC, 200 em ms)       (id = msg.id,               (mídia, push, status;
                                              duplicata = ignorada)       retry automático)

InstaDelivery ──POST?token──▶ webhookPedidos ──set──▶ pedidos/ ──trigger──▶ notificarStatusPedido
                              (salva, 200 em ms)                             (transação antiduplicação,
                                                                              recibo/templates, ficha)

Painel ──setDoc (offline-first)──▶ outbox/ ──trigger──▶ processarOutbox ──▶ Meta
Asaas ──POST──▶ webhookAsaas ──create(eventoId)──▶ eventos_asaas
                 (token + ACK rápido)               │
                                                    ▼
                                           processarEventoAsaas
                                           (GET /payments/{id}
                                            + validação estrita
                                            + transação única)

reconciliarPixAsaas ──a cada 5 min──▶ GET /payments/{id}
                     (segunda via independente; pendentes e auditorias pós-pagamento)
```

## Garantias da conciliação PIX

- O webhook nunca confirma diretamente: ele persiste o evento e só então responde `200`.
- Reentrega do mesmo evento usa o mesmo documento e não duplica processamento.
- A decisão usa a cobrança relida na API, não apenas o JSON recebido.
- Cobranças do app exigem coincidência exata de `paymentId`, `externalReference`,
  `billingType`, `status` e valor em centavos.
- Pedido, pagamento e evento são gravados na mesma transação.
- Um `paymentId` já associado a um pedido não pode ser reutilizado em outro.
- Pagamentos legados sem identificador inequívoco nunca confirmam por valor/nome;
  viram pendência para decisão humana.
- A reconciliação programada cobre webhook atrasado/perdido e continua auditando
  pagamentos recebidos em intervalos progressivos.
- Estorno total, parcial e em andamento atualiza o pedido e abre alerta no painel.
