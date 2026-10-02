// ============================================================================
// SERVIÇO DE PEDIDOS
// Recibo completo, ficha do cliente e despacho de notificação por status.
// A DEDUPLICAÇÃO por status agora vive no gatilho (triggers/pedidos.js),
// então este módulo só executa — nunca decide "se já enviou".
// ============================================================================

const admin = require("firebase-admin");
const { DICIONARIO_PAGAMENTO, PHONE_ID, GRAPH } = require("../config");
const { enviarTemplate, graphPost, registrarSaida } = require("./meta");
const {
  variantesNumero, normalizarTelefone, formatarReal, agendamentoAindaNoFuturo,
} = require("../lib/util");
const { resolverConversaRef } = require("../lib/conversas");

const db = () => admin.firestore();

// Template aprovado no Meta Business Manager pra avisar "saiu da fábrica,
// chega no horário agendado" — {{1}} = nome, {{2}} = horário (ver case 5 de
// processarNotificacaoWhatsApp). Texto aprovado: "Olá, {{1}}! O seu pedido já
// saiu da Fábrica! 🛵 Ele está numa rota e chegará no horário agendado: {{2}}."
const TEMPLATE_AGENDADO_APROVADO = "pedido_em_rota";

// Pedidos criados pelo app cliente (criarPedido) já vêm com tipo_entrega
// explícito — só cai na heurística de bairro/cep/taxa pra pedidos legados
// do InstaDelivery, que nunca tiveram esse campo.
const ehDelivery = (p) => {
  if (p.tipo_entrega === "delivery") return true;
  if (p.tipo_entrega === "retirada") return false;
  return !!p.cep_destinatario || !!p.bairro_destinatario || parseFloat(p.valor_taxa || 0) > 0;
};

// ── Normalizadores de payload (o InstaDelivery varia array/objeto/string) ────
function paraArray(bruto) {
  if (Array.isArray(bruto)) return bruto;
  if (bruto && typeof bruto === "object") return Object.values(bruto);
  return [];
}

function extrairCodigosPagamento(bruto) {
  if (bruto == null) return [];
  const lista = Array.isArray(bruto) ? bruto : [bruto];
  const codigos = [];
  lista.forEach((item) => {
    if (item == null) return;
    if (typeof item === "object") {
      const valor = item.codigo ?? item.forma ?? item.tipo ?? item.value;
      if (valor != null) codigos.push(String(valor).trim());
      return;
    }
    String(item).split(",").forEach((parte) => {
      const limpo = parte.trim();
      if (limpo) codigos.push(limpo);
    });
  });
  return codigos;
}

// ── RECIBO COMPLETO ──────────────────────────────────────────────────────────
async function enviarReciboCompleto(token, telefone, pedido) {
  const isDelivery   = ehDelivery(pedido);
  const tipoEntrega  = isDelivery ? "DELIVERY" : "RETIRADA";
  const nomeCompleto = pedido.nome_destinatario || "Cliente";
  const primeiroNome = nomeCompleto.split(" ")[0];
  const telFormatado = (pedido.telefone_destinatario || "").replace(/\D/g, "") || "Não informado";

  // Complemento e referência só entram na linha se o pedido realmente tiver
  // esse dado — sem isso, a mensagem ficava com ", - CEP:" vazio no meio.
  const textoComplemento = pedido.complemento_destinatario ? `, ${pedido.complemento_destinatario}` : "";
  const textoReferencia  = pedido.referencia ? ` (Ref: ${pedido.referencia})` : "";
  const var5_endereco = isDelivery
    ? `${pedido.logradouro_destinatario || "N/A"}, ${pedido.numero_destinatario || "S/N"}${textoComplemento}${textoReferencia} - CEP: ${pedido.cep_destinatario || "N/A"}`
    : "Retirada no balcão";

  const itensArray = paraArray(pedido.descricao_item);
  const qtdArray   = paraArray(pedido.quantidade_item);
  const valorArray = paraArray(pedido.valor_total_item);

  // 🛡️ Trava: template da Meta estoura com body > 1024 chars
  let itensFormatados = "";
  let itensOmitidos = 0;
  const MAX_CARACTERES_ITENS = 550;

  if (itensArray.length > 0) {
    for (let i = 0; i < itensArray.length; i++) {
      const qtd = qtdArray[i] ?? 1;
      const valor = parseFloat(valorArray[i] ?? 0);
      const textoItem = `${qtd}x ${itensArray[i]} R$${formatarReal(valor)}`;
      if (itensFormatados.length + textoItem.length > MAX_CARACTERES_ITENS) {
        itensOmitidos = itensArray.length - i;
        break;
      }
      itensFormatados += (itensFormatados.length > 0 ? "  |  " : "") + textoItem;
    }
    if (itensOmitidos > 0) itensFormatados += `  |  ... e mais ${itensOmitidos} item(ns)`;
  } else {
    itensFormatados = "Sem itens";
  }

  // As observações do cliente entram junto no MESMO parâmetro dos itens —
  // o template já aprovado na Meta não tem um slot próprio pra um 14º
  // parâmetro, e pedir reaprovação de template leva dias. Isso é o único
  // "espaço livre" que já chega pro cliente e fica visível pra equipe no
  // WhatsApp; o texto salvo no Firestore (abaixo) ganha uma seção própria,
  // sem essa limitação.
  let itens = itensFormatados;
  if (pedido.observacoes && String(pedido.observacoes).trim()) {
    itens = `${itens}  |  Obs: ${String(pedido.observacoes).trim()}`.slice(0, 900);
  }

  const vItens    = parseFloat(pedido.valor_itens    || pedido.valor_venda || 0);
  const vDesconto = parseFloat(pedido.valor_desconto || 0);
  const vEntrega  = parseFloat(pedido.valor_taxa     || 0);
  const vTotal    = parseFloat(pedido.valor_venda    || 0);

  const pagamentosArray = extrairCodigosPagamento(pedido.forma_pagamento);
  const codPagamento    = pagamentosArray[0] ?? null;
  const var11_pagamento = codPagamento ? (DICIONARIO_PAGAMENTO[codPagamento] || codPagamento) : "Não informado";

  const temPix    = pagamentosArray.includes("17");
  const temCartao = pagamentosArray.some((c) => ["03", "04", "42"].includes(c));

  let nomeTemplate = "alerta_novo_pedido";
  if (temPix)         nomeTemplate = "alerta_novo_pedido_pix";
  else if (temCartao) nomeTemplate = "alerta_novo_pedido_card";

  const var13_agendamento = pedido.agendamento ? String(pedido.agendamento) : "Não agendado (Imediato)";

  // Texto salvo no Firestore (o painel exibe isto; a Meta recebe só os parâmetros)
  const textoReciboDB = [
    `Olá! ${primeiroNome}, aqui estão os detalhes do seu pedido:\n`,
    `ID Pedido: ${pedido.order_id}`,
    `Horario: ${pedido.data_venda || "—"}`,
    `Tipo: ${tipoEntrega}`,
    `AGENDAMENTO: ${var13_agendamento}\n`,
    `CLIENTE`, `------------------------------`,
    `Fone: ${telFormatado}`,
    `Bairro: ${pedido.bairro_destinatario}`,
    `Endereço: ${var5_endereco}\n`,
    `ITENS`, `------------------------------`,
    itensFormatados,
    ...(pedido.observacoes && String(pedido.observacoes).trim()
      ? [`\nOBSERVAÇÕES`, `------------------------------`, String(pedido.observacoes).trim()]
      : []),
    `\nVALOR`, `------------------------------`,
    `Itens: R$ ${formatarReal(vItens)}`,
    `Desconto: R$ ${formatarReal(vDesconto)}`,
    `Entrega: R$ ${formatarReal(vEntrega)}`,
    `\nTOTAL: R$ ${formatarReal(vTotal)}`,
    `------------------------------`,
    `Pagamento: ${var11_pagamento}`,
    temPix
      ? `\nAguardando confirmação de pagamento PIX para iniciarmos o preparo!`
      : `\nVocê confirma esse pedido?`,
  ].join("\n");

  const parameters = [
    { type: "text", parameter_name: "order_id",    text: String(pedido.order_id) },
    { type: "text", parameter_name: "horario",     text: pedido.data_venda || "—" },
    { type: "text", parameter_name: "tipo",        text: tipoEntrega },
    { type: "text", parameter_name: "fone",        text: telFormatado },
    { type: "text", parameter_name: "endereco",    text: var5_endereco },
    { type: "text", parameter_name: "itens",       text: itens },
    { type: "text", parameter_name: "valor_itens", text: formatarReal(vItens) },
    { type: "text", parameter_name: "desconto",    text: formatarReal(vDesconto) },
    { type: "text", parameter_name: "entrega",     text: formatarReal(vEntrega) },
    { type: "text", parameter_name: "total",       text: formatarReal(vTotal) },
    { type: "text", parameter_name: "pagamento",   text: var11_pagamento },
    { type: "text", parameter_name: "nome",        text: nomeCompleto },
    { type: "text", parameter_name: "agendamento", text: var13_agendamento },
  ];

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: telefone,
    type: "template",
    template: { name: nomeTemplate, language: { code: "pt_BR" }, components: [{ type: "body", parameters }] },
  };

  const response = await graphPost(token, `${PHONE_ID}/messages`, payload);
  const msgId = response.data?.messages?.[0]?.id || `msg_auto_${Date.now()}`;
  await registrarSaida(telefone, msgId, textoReciboDB, { nomeCliente: nomeCompleto });
  console.log(`[enviarReciboCompleto] Template [${nomeTemplate}] enviado para ${telefone}`);
}

// ── FICHA DO CLIENTE ─────────────────────────────────────────────────────────
async function atualizarFichaCliente(telefoneNormalizado, pedido, statusNum) {
  try {
    // Mesma busca por variante que webhooks/whatsapp.js e services/meta.js já
    // usam — centralizada, pra não ter três implementações do mesmo problema.
    const docRef = await resolverConversaRef(telefoneNormalizado);
    if (!docRef) {
      console.log(`[atualizarFichaCliente] Telefone inválido, ficha não atualizada: "${telefoneNormalizado}"`);
      return;
    }

    const isDelivery  = ehDelivery(pedido);
    const valorPedido = parseFloat(String(pedido.valor_venda || "0").replace(",", ".")) || 0;

    const STATUS_LABELS = {
      2: "Em preparo",
      3: isDelivery ? "Saiu para entrega" : "Pronto para retirada",
      4: "Cancelado",
      5: "Em rota de entrega",
    };
    const ativo = statusNum in STATUS_LABELS;
    const statusLabel = STATUS_LABELS[statusNum] ?? null;

    await db().runTransaction(async (tx) => {
      // Regra do Firestore: TODAS as leituras antes de qualquer escrita.
      const snap = await tx.get(docRef);
      // Fonte da verdade do PIX: o documento do pedido AGORA (o snapshot que
      // o gatilho recebeu pode ser anterior à confirmação do Asaas).
      const pedidoFrescoSnap = await tx.get(db().collection("pedidos").doc(String(pedido.order_id)));

      const dataAtual = snap.exists ? snap.data() : {};
      const update = {};
      const orderIdStr = String(pedido.order_id);
      const pedidoFresco = pedidoFrescoSnap.data() || {};
      const pixConfirmadoAgora = pedidoFresco.pix_confirmado === true;
      const pixStatusAgora =
        pedidoFresco.pix_status ||
        pedido.pix_status ||
        (pixConfirmadoAgora ? "RECEIVED" : "PENDING");

      const fichaPedido = dataAtual.pedidoHoje;

      // O card deve refletir sempre o pedido MAIS RECENTE: atualização
      // tardia de um pedido antigo não sobrescreve o card do novo.
      const fichaEhMaisRecente =
        !!fichaPedido &&
        fichaPedido.id !== orderIdStr &&
        String(fichaPedido.dataVenda || "") > String(pedido.data_venda || "");

      if (!fichaEhMaisRecente) {
        update.pedidoHoje = ativo
          ? {
              id: orderIdStr,
              status: statusLabel,
              total: `R$ ${formatarReal(valorPedido)}`,
              dataVenda: pedido.data_venda || null,
              ehPix: extrairCodigosPagamento(pedido.forma_pagamento).includes("17"),
              // Sempre reflete o documento fresco. Um estorno confirmado pelo
              // Asaas precisa conseguir rebaixar "Pago" para "Estornado".
              pixConfirmado: pixConfirmadoAgora,
              pixStatus: pixStatusAgora,
            }
          : null;
      }

      update.lastOrderType = isDelivery ? "DELIVERY" : "RETIRADA";
      update.lastOrderAt   = admin.firestore.FieldValue.serverTimestamp();
      // O painel ordena/limita a lista de conversas por lastMessageAt (evita
      // baixar a coleção inteira toda vez que o Chat abre). Sem gravar aqui,
      // um cliente que só fez pedido e nunca mandou WhatsApp ficaria sem esse
      // campo e sumiria silenciosamente da lista quando o limite entrar.
      if (!dataAtual.lastMessageAt) {
        update.lastMessageAt = admin.firestore.FieldValue.serverTimestamp();
      }

      // Nome do pedido é a fonte de verdade, salvo edição manual do operador
      const nomePedido = (pedido.nome_destinatario || "").trim();
      if (nomePedido && !dataAtual.nomeClienteManual) {
        update.clientName = nomePedido;
      }

      // LTV e histórico contabilizados uma única vez por pedido (status 2)
      const idsContados = dataAtual.pedidosContabilizadosIds || [];
      if (statusNum === 2 && !idsContados.includes(orderIdStr)) {
        const novoLtv = (dataAtual.ltvTotal || 0) + valorPedido;
        update.ltvTotal    = novoLtv;
        update.ltv         = `R$ ${formatarReal(novoLtv)}`;
        update.totalOrders = (dataAtual.totalOrders || 0) + 1;
        update.pedidosContabilizadosIds = [...idsContados, orderIdStr];
        update.datasHistorico = admin.firestore.FieldValue.arrayUnion(admin.firestore.Timestamp.now());
      }

      if (isDelivery) {
        const enderecosAtuais = dataAtual.enderecos || [];
        const bairro   = pedido.bairro_destinatario || "Bairro não informado";
        const detalhe  = `${pedido.logradouro_destinatario || ""}, ${pedido.numero_destinatario || "S/N"}`.trim();
        const jaExiste = enderecosAtuais.some((e) => e.bairro === bairro && e.detalhe === detalhe);

        update.enderecos = jaExiste
          ? enderecosAtuais.map((e) => (e.bairro === bairro ? { ...e, detalhe, isRecorrente: true } : e))
          : [...enderecosAtuais, { bairro, detalhe, isRecorrente: enderecosAtuais.length === 0 }];
      }

      tx.set(docRef, update, { merge: true });
    });
  } catch (erro) {
    console.error("Erro ao atualizar ficha do cliente:", erro);
  }
}

// ── DESPACHO POR STATUS ──────────────────────────────────────────────────────
async function processarNotificacaoWhatsApp(token, pedido) {
  const telefone = normalizarTelefone(pedido.telefone_destinatario);
  if (!telefone) {
    console.log(`Telefone inválido para envio: ${pedido.telefone_destinatario}`);
    return;
  }

  const statusNum = Number(pedido.status);
  await atualizarFichaCliente(telefone, pedido, statusNum);

  const nome = pedido.nome_destinatario || "Cliente";
  const isDelivery = ehDelivery(pedido);

  switch (statusNum) {
    case 2:
      await enviarReciboCompleto(token, telefone, pedido);
      break;

    case 3:
      if (isDelivery) {
        await enviarTemplate(token, telefone, "saiu_para_entrega_correto",
          [{ type: "text", text: nome }], nome,
          `Olá ${nome}, seu pedido acabou de sair para entrega! 🛵`);
      } else {
        await enviarTemplate(token, telefone, "pronto_para_retirada",
          [{ type: "text", text: nome }], nome,
          `Olá ${nome}, seu pedido já está pronto para retirada no balcão! 📦`);
      }
      break;

    case 4:
      await enviarTemplate(token, telefone, "aviso_cancelamento",
        [{ type: "text", text: nome }, { type: "text", text: String(pedido.order_id) }], nome,
        `Olá ${nome}, Infelizmente seu pedido #${pedido.order_id} precisou ser cancelado. Se tiver alguma dúvida, é só mandar uma mensagem aqui!`);
      break;

    case 5:
      if (isDelivery) {
        // Viagem com várias paradas: o motoboy pode sair bem antes do
        // horário marcado pra ESTA entrega específica, se tiver parada(s)
        // antes na rota. Nesse caso, "está em rota de entrega" sozinho soa
        // como "chegando a qualquer momento" — alarme falso pro cliente que
        // agendou pra mais tarde.
        const agendamentoInfo = agendamentoAindaNoFuturo(pedido.agendamento);
        if (agendamentoInfo?.noFuturo && TEMPLATE_AGENDADO_APROVADO) {
          await enviarTemplate(token, telefone, TEMPLATE_AGENDADO_APROVADO,
            [{ type: "text", text: nome }, { type: "text", text: agendamentoInfo.horario }], nome,
            `Olá, ${nome}! O seu pedido já saiu da Fábrica! 🛵 Ele está numa rota e chegará no horário agendado: ${agendamentoInfo.horario}.`);
        } else {
          await enviarTemplate(token, telefone, "saiu_para_entrega_correto",
            [{ type: "text", text: nome }], nome,
            `Olá ${nome}, Seu pedido está em rota de entrega. 🛵💨`);
        }
      } else {
        console.log(`[CASE 5] Não é delivery, nenhuma mensagem enviada.`);
      }
      break;

    default:
      console.log(`Nenhuma automação configurada para o status: ${statusNum}`);
  }
}

/**
 * Atualiza só o status de pagamento PIX na ficha do cliente, sem reprocessar
 * toda a notificação de status. Usada pelo webhook do Asaas assim que o
 * pagamento é confirmado, para o ContextPanel mostrar "Pago" na hora.
 */
async function atualizarStatusPixNaFicha(
  telefoneNormalizado,
  orderId,
  pixConfirmado,
  pixStatus = pixConfirmado ? "RECEIVED" : "PENDING"
) {
  try {
    const variantes = [...variantesNumero(telefoneNormalizado)];
    let docRef = null;
    for (const v of variantes) {
      const ref = db().collection("conversas").doc(v);
      const snap = await ref.get();
      if (snap.exists) { docRef = ref; break; }
    }
    if (!docRef) return;

    // O PIX costuma ser confirmado SEGUNDOS depois do pedido — às vezes antes
    // de o gatilho do recibo terminar de criar o pedidoHoje na ficha. Em vez
    // de desistir em silêncio na primeira olhada, espera um pouco e tenta de
    // novo (a leitura fresca no atualizarFichaCliente cobre o resto dos casos).
    const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const snap = await docRef.get();
      if (snap.data()?.pedidoHoje?.id === String(orderId)) {
        // Notação com ponto só funciona no update() — no set(merge) ela vira
        // um nome literal de campo na raiz.
        await docRef.update({
          "pedidoHoje.pixConfirmado": pixConfirmado,
          "pedidoHoje.pixStatus": pixStatus,
        });
        return;
      }
      if (tentativa < 3) await dormir(2000);
    }
    console.log(`[atualizarStatusPixNaFicha] pedidoHoje do pedido ${orderId} não apareceu na ficha após 3 tentativas — a leitura fresca corrigirá no próximo status.`);
  } catch (erro) {
    console.error("Erro ao atualizar status PIX na ficha do cliente:", erro);
  }
}

module.exports = { processarNotificacaoWhatsApp, atualizarFichaCliente, enviarReciboCompleto, ehDelivery, extrairCodigosPagamento, atualizarStatusPixNaFicha };
