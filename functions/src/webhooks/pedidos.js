// ============================================================================
// WEBHOOK INSTADELIVERY + GATILHO DE NOTIFICAÇÃO
//
// ANTES: o webhook salvava o pedido E enviava WhatsApp na mesma requisição
//        (lento, e webhook reenviado = mensagem duplicada). Havia ainda um
//        segundo gatilho (status 5) competindo com o webhook.
//
// AGORA:
//   1. webhookPedidos: exige ?token=, valida, salva o pedido e responde.
//      Rápido — o InstaDelivery nunca dá timeout.
//   2. notificarStatusPedido (onDocumentWritten): TODA notificação sai daqui.
//      Uma transação marca `notificados.{status}` ANTES de enviar; se o mesmo
//      status chegar de novo (webhook reenviado, edição manual, etc.),
//      NENHUMA mensagem duplicada é enviada ao cliente.
// ============================================================================

const { onRequest }         = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin                 = require("firebase-admin");

const {
  PEDIDOS_WEBHOOK_TOKEN,
  PEDIDOS_WEBHOOK_BACKUP_TOKEN,
  TOKEN_META,
} = require("../config");
const { comparaSegura }        = require("../lib/seguranca");
const { calcularJanelas, dataHoraAtualSP, normalizarDataVenda } = require("../lib/util");
const { processarNotificacaoWhatsApp } = require("../services/pedidos");
const { devePreservarCancelamento } = require("../services/comandosPedidos");
const {
  COLECAO_NOTIFICACOES_PEDIDO,
  dadosNotificacaoCancelamento,
  idNotificacaoCancelamento,
} = require("../services/notificacoesPedido");

const db = () => admin.firestore();

// Nenhum outro pedido com esse telefone (fora este mesmo order_id, caso o
// webhook seja reentregue) = é o primeiro pedido dessa pessoa. Calculado
// aqui, na entrada, pra ficar gravado no próprio documento — nem o robô nem
// o painel precisam adivinhar isso depois (antes o robô fazia essa mesma
// consulta a cada impressão; agora só lê o campo).
async function ehPrimeiroPedidoDoCliente(telefone, orderId) {
  if (!telefone) return false;
  try {
    const snap = await db().collection("pedidos")
      .where("telefone_destinatario", "==", telefone)
      .limit(2)
      .get();
    return !snap.docs.some((d) => d.id !== String(orderId));
  } catch (erro) {
    console.error("[webhookPedidos] Falha ao verificar primeiro pedido do cliente:", erro.message);
    return false; // na dúvida, não estampa "primeiro pedido" num cliente antigo
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) RECEPTOR — salva e responde
//    URL a cadastrar no InstaDelivery:
//    https://.../webhookPedidos?token=<token-configurado-no-provedor>
// ─────────────────────────────────────────────────────────────────────────────
async function processarWebhookPedidos(req, res, tokenEsperado, canal) {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // 🔒 Sem o token correto na URL, ninguém injeta pedidos falsos
    if (!comparaSegura(req.query.token, tokenEsperado)) {
      return res.status(401).send("Não autorizado");
    }

    const pedido = { ...req.body };
    if (!pedido.order_id) {
      console.error(`[${canal}] Payload inválido: sem order_id.`);
      return res.status(400).send("order_id inválido");
    }

    // Primeira linha do processamento, antes de qualquer acesso ao Firestore.
    // Assim distinguimos claramente "o Insta não chamou" de "chamou e falhou".
    console.log(`[${canal}] Recebido pedido ${pedido.order_id}, status ${pedido.status ?? "ausente"}.`);

    // O InstaDelivery já alternou entre datas ISO e BR. O painel e a
    // conciliação PIX consultam por intervalo lexicográfico, portanto uma
    // data fora de "AAAA-MM-DD HH:mm:ss" fazia o pedido simplesmente sumir
    // das duas telas. Conservamos o valor recebido para auditoria e sempre
    // gravamos uma data canônica utilizável.
    const dataVendaRecebida = pedido.data_venda;
    const dataVendaNormalizada = normalizarDataVenda(dataVendaRecebida);
    if (dataVendaNormalizada) {
      pedido.data_venda = dataVendaNormalizada;
      if (String(dataVendaRecebida).trim() !== dataVendaNormalizada) {
        pedido.data_venda_origem = String(dataVendaRecebida).slice(0, 200);
      }
    } else {
      if (dataVendaRecebida != null && String(dataVendaRecebida).trim()) {
        pedido.data_venda_origem = String(dataVendaRecebida).slice(0, 200);
        console.warn(
          `[${canal}] Pedido ${pedido.order_id} veio com data_venda inválida: ${pedido.data_venda_origem}`
        );
      }
      pedido.data_venda = dataHoraAtualSP();
    }

    // Esta função recebe exclusivamente webhooks do InstaDelivery. Marcar a
    // origem ausente permite a conciliação PIX reconhecer pedidos legítimos
    // mesmo quando o provedor omite esse campo no payload.
    if (pedido.origem == null || String(pedido.origem).trim() === "") {
      pedido.origem = "instadelivery";
    }

    if (pedido.data_venda && pedido.agendamento) {
      const janelas = calcularJanelas(pedido.data_venda, pedido.agendamento);
      if (janelas) {
        pedido.janela_inicio = janelas.janela_inicio;
        pedido.janela_fim    = janelas.janela_fim;
      }
    }
    if (!pedido.status_interno) pedido.status_interno = "recebido";

    try {
      const ref = db().collection("pedidos").doc(String(pedido.order_id));

      // primeiro_pedido_cliente só é calculado UMA VEZ, na criação — se já
      // existe (reentrega do webhook, ou uma atualização de status meses
      // depois), preserva o valor gravado antes. Recalcular numa atualização
      // tardia daria resposta errada: um pedido novo do MESMO telefone já
      // faria esse cálculo "achar" outro pedido e concluir (errado) que este
      // aqui deixou de ser o primeiro.
      const existente = await ref.get();
      const dadosAntigos = existente.exists ? existente.data() : null;

      const jaTemFlag = existente.exists && typeof dadosAntigos.primeiro_pedido_cliente === "boolean";
      if (!jaTemFlag) {
        pedido.primeiro_pedido_cliente = await ehPrimeiroPedidoDoCliente(pedido.telefone_destinatario, pedido.order_id);
      }

      // Edição feita no InstaDelivery (ex.: mudar o horário do agendamento)
      // nunca avisava o robô pra reimprimir — só o painel fazia isso
      // (EditarPedidoAppModal, gravando impresso:false explicitamente). Se
      // o pedido já tinha sido impresso e algo que o InstaDelivery mandou
      // agora é diferente do que já estava salvo, força a reimpressão —
      // o robô escuta esse campo e reimprime sozinho.
      if (dadosAntigos?.impresso === true) {
        const mudouAlgo = Object.entries(req.body).some(
          ([chave, valor]) => JSON.stringify(dadosAntigos[chave]) !== JSON.stringify(valor)
        );
        if (mudouAlgo) pedido.impresso = false;
      }

      // Diagnóstico: não há nenhuma tradução de status do InstaDelivery pra
      // status interno — o campo `status` do payload é gravado como veio,
      // sem checagem nenhuma. Se um cancelamento feito lá nunca aparecer
      // aqui como status:4 (relatado — "cancelamos no Insta mas continua
      // no dash"), esse log mostra se o InstaDelivery: (a) nunca chama esse
      // webhook pra cancelamento, ou (b) chama mandando um status diferente
      // do 4 que a gente não está reconhecendo.
      if (dadosAntigos && dadosAntigos.status !== pedido.status) {
        console.log(`[${canal}] Pedido ${pedido.order_id}: status mudou de ${dadosAntigos.status} para ${pedido.status}.`);
      }

      // A transação também protege o cancelamento local de um webhook legado
      // atrasado. Sem essa guarda, uma atualização antiga com status 2 poderia
      // "ressuscitar" um pedido já cancelado pelo painel.
      const resultadoPersistencia = await db().runTransaction(async (tx) => {
        const notificacaoRef = db().collection(COLECAO_NOTIFICACOES_PEDIDO)
          .doc(idNotificacaoCancelamento(pedido.order_id));
        const [pedidoAtualSnap, notificacaoSnap] = await Promise.all([
          tx.get(ref),
          tx.get(notificacaoRef),
        ]);
        const pedidoAtual = pedidoAtualSnap.exists ? pedidoAtualSnap.data() || {} : {};
        const statusAtual = Number(pedidoAtual.status);
        const statusRecebido = Number(pedido.status);

        if (devePreservarCancelamento(statusAtual, statusRecebido)) {
          tx.set(ref, {
            ultimoStatusWebhookIgnorado: {
              statusRecebido: pedido.status ?? null,
              canal,
              recebidoEm: admin.firestore.FieldValue.serverTimestamp(),
            },
          }, { merge: true });
          return { cancelamentoPreservado: true, notificacaoCriada: false };
        }

        tx.set(ref, pedido, { merge: true });

        // Cancelamento externo também usa o mesmo job durável do painel. A
        // transição é conferida na transação (não no snapshot lido antes), e
        // cancelamentos antigos não recebem backfill automático para não
        // duplicar um aviso que já possa ter sido enviado na versão anterior.
        const virouCancelado = statusRecebido === 4 && statusAtual !== 4;
        if (virouCancelado && !notificacaoSnap.exists) {
          const pedidoParaNotificacao = {
            ...pedidoAtual,
            ...pedido,
            telefone_destinatario: pedido.telefone_destinatario || pedidoAtual.telefone_destinatario,
            nome_destinatario: pedido.nome_destinatario || pedidoAtual.nome_destinatario,
            order_id: pedido.order_id || pedidoAtual.order_id,
          };
          tx.create(notificacaoRef, dadosNotificacaoCancelamento({
            pedidoId: String(pedido.order_id),
            pedido: pedidoParaNotificacao,
            origem: "cancelamento_webhook_instadelivery",
            agora: admin.firestore.FieldValue.serverTimestamp(),
          }));
        }
        return { cancelamentoPreservado: false, notificacaoCriada: virouCancelado && !notificacaoSnap.exists };
      });

      if (resultadoPersistencia.cancelamentoPreservado) {
        console.warn(`[${canal}] Pedido ${pedido.order_id}: status ${pedido.status} ignorado; cancelamento local preservado.`);
      }

      console.log(`[${canal}] Pedido ${pedido.order_id} salvo/atualizado.`);
      // A notificação sai pelo gatilho abaixo — resposta imediata aqui.
      return res.status(200).send("Pedido processado");
    } catch (error) {
      console.error(`[${canal}] Erro ao processar pedido:`, error);
      return res.status(500).send("Erro interno");
    }
}

const opcoesWebhookPedidos = { memory: "256MiB", cpu: 1 };

const webhookPedidos = onRequest(
  { ...opcoesWebhookPedidos, secrets: [PEDIDOS_WEBHOOK_TOKEN] },
  (req, res) => processarWebhookPedidos(
    req,
    res,
    PEDIDOS_WEBHOOK_TOKEN.value(),
    "webhookPedidos"
  )
);

// Endpoint independente para o campo "Webhook 2" do InstaDelivery. Os dois
// escrevem no mesmo documento pelo order_id; uma entrega duplicada é segura e
// não duplica pedido nem mensagem ao cliente.
const webhookPedidosBackup = onRequest(
  { ...opcoesWebhookPedidos, secrets: [PEDIDOS_WEBHOOK_BACKUP_TOKEN] },
  (req, res) => processarWebhookPedidos(
    req,
    res,
    PEDIDOS_WEBHOOK_BACKUP_TOKEN.value(),
    "webhookPedidosBackup"
  )
);

// ─────────────────────────────────────────────────────────────────────────────
// 2) GATILHO ÚNICO DE NOTIFICAÇÃO
//    Dispara em criação E atualização. Substitui o antigo gatilhoStatusPedido.
// ─────────────────────────────────────────────────────────────────────────────
// O status 4 segue a fila durável `notificacoes_pedido`: o job é criado na
// mesma transação de cancelamento (painel ou webhook) e não pode ser enviado
// pelo fluxo legado abaixo, que marca "notificado" antes da Meta confirmar.
const STATUS_NOTIFICAVEIS = new Set([2, 3, 5]);

const notificarStatusPedido = onDocumentWritten(
  {
    document: "pedidos/{pedidoId}",
    secrets: [TOKEN_META],
    memory: "512MiB",
    cpu: 1,
    retry: true,
  },
  async (event) => {
    const depois = event.data?.after?.exists ? event.data.after.data() : null;
    if (!depois) return; // documento excluído

    const antes        = event.data?.before?.exists ? event.data.before.data() : null;
    const statusDepois = Number(depois.status);
    const statusAntes  = antes ? Number(antes.status) : null;

    if (!STATUS_NOTIFICAVEIS.has(statusDepois)) return;
    if (statusAntes === statusDepois && antes?.notificados?.[statusDepois]) return;

    // 🔐 Transação: só UMA execução consegue marcar o status como notificado.
    // Webhook duplicado, retry do gatilho, edição manual — nada gera 2ª mensagem.
    const ref = event.data.after.ref;
    const deveEnviar = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const dados = snap.data() || {};
      if (dados.notificados?.[statusDepois]) return false;
      tx.set(ref, {
        notificados: { ...(dados.notificados || {}), [statusDepois]: true },
      }, { merge: true });
      return true;
    });

    if (!deveEnviar) {
      console.log(`[notificarStatusPedido] Pedido ${depois.order_id} status ${statusDepois} já notificado. Ignorando.`);
      return;
    }

    console.log(`[notificarStatusPedido] Pedido ${depois.order_id} → status ${statusDepois}. Notificando.`);
    try {
      await processarNotificacaoWhatsApp(TOKEN_META.value(), depois);
    } catch (erro) {
      // Erro transitório (rede/5xx): desmarca e relança para o retry da GCP reenviar
      const transitorio = !erro.response || erro.response.status >= 500 || erro.response.status === 429;
      if (transitorio) {
        await ref.set({ notificados: { [statusDepois]: false } }, { merge: true });
        throw erro; // retry: true reprocessa
      }
      // Erro permanente (template reprovado, número inválido): loga e não repete
      console.error(`[notificarStatusPedido] Erro permanente pedido ${depois.order_id}:`,
        JSON.stringify(erro.response?.data ?? erro.message));
    }
  }
);

module.exports = { webhookPedidos, webhookPedidosBackup, notificarStatusPedido };
