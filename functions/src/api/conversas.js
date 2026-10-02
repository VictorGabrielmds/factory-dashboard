// ============================================================================
// API — conversas (painel): templates, iniciar conversa, busca por pedido
// Agora com autenticação e CORS restrito.
// ============================================================================

const { onRequest } = require("firebase-functions/v2/https");
const admin         = require("firebase-admin");

const { SEGREDOS_CHAT, TOKEN_META, ORIGENS_PAINEL, ASAAS_API_KEY, ASAAS_API_BASE } = require("../config");
const { exigirPainel }               = require("../lib/seguranca");
const { exigirCapacidadePainel }      = require("../lib/permissoesPainel");
const { buscarTemplates, enviarTemplate } = require("../services/meta");
const { normalizarTelefone, horaAtualSP, idDocSeguro } = require("../lib/util");
const { extrairCodigosPagamento, atualizarStatusPixNaFicha } = require("../services/pedidos");
const { buscarPagamentoAsaas, buscarPagadorDoPagamento } = require("../services/asaas");
const {
  validarPagamentoRecebido,
  parseValor,
  atualizacaoOperacionalAoConfirmarPix,
  pedidoVisivelNoPainel,
} = require("../services/pixConfiavel");
const { http, comRetentativa }            = require("../lib/http");

const db = () => admin.firestore();

const TIPOS_PENDENCIA_CONFIRMACAO_PIX = [
  "pix_sem_vinculo_exato",
  "pix_colisao",
  "pix_nao_encontrado",
];
const TIPOS_PENDENCIA_CONFIRMACAO_PIX_SET = new Set(TIPOS_PENDENCIA_CONFIRMACAO_PIX);

function textoContemIdentificadorExato(texto, identificador) {
  const escapado = String(identificador).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapado}([^A-Za-z0-9_-]|$)`).test(
    String(texto || "")
  );
}

const conversas = onRequest(
  // memory/timeout maiores que o padrão: backfillLastMessageAt/diagnosticoPix
  // varrem a coleção inteira de pedidos numa passada só (uso pontual).
  { cors: ORIGENS_PAINEL, secrets: [...SEGREDOS_CHAT, ASAAS_API_KEY], memory: "512MiB", cpu: 1, timeoutSeconds: 300 },
  async (req, res) => {
    const operadorPainel = await exigirPainel(req, res);
    if (!operadorPainel) return;

    const { action } = req.method === "GET" ? req.query : req.body;
    if (!action) return res.status(400).json({ error: "Falta action" });

    const token = TOKEN_META.value();

    try {
      // ── buscarTemplates ────────────────────────────────────────────────────
      if (action === "buscarTemplates") {
        const response = await buscarTemplates(token);
        const templates = response.data.data.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          category: t.category,
          language: t.language,
          components: t.components || [],
          preview: t.components?.find((c) => c.type === "BODY")?.text || "",
        }));
        return res.status(200).json({ templates });
      }

      // ── iniciarConversa ────────────────────────────────────────────────────
      if (action === "iniciarConversa") {
        if (req.method !== "POST") return res.status(405).send("Método não permitido");

        const { telefone, templateName, parameters = [], nomeCliente = "", textoPreview } = req.body;
        if (!telefone || !templateName) {
          return res.status(400).json({ error: "Falta telefone ou templateName" });
        }

        const numero = normalizarTelefone(telefone);
        if (!numero) return res.status(400).json({ error: "Telefone inválido" });

        const hora           = horaAtualSP();
        const textoFinal     = textoPreview || `Template "${templateName}" enviado`;
        const nomeInformado  = String(nomeCliente || "").trim();

        await db().collection("conversas").doc(numero).set({
          phone: numero,
          lastMessage: textoFinal,
          lastMessageSender: "outgoing",
          lastMessageStatus: "sent",
          time: hora,
          unreadCount: 0,
          hasCallPermission: false,
          tags: [],
          isOnline: true,
          criadoEm: admin.firestore.FieldValue.serverTimestamp(),
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          // Nome preenchido neste fluxo é uma escolha do operador. Não
          // substituímos por um cadastro anterior, nem por "Cliente" quando
          // o campo foi deixado em branco.
          ...(nomeInformado ? { clientName: nomeInformado, nomeClienteManual: true } : {}),
        }, { merge: true });

        await enviarTemplate(
          token, numero, templateName,
          parameters.map((p) => ({ type: "text", text: String(p.text ?? p) })),
          nomeInformado || undefined, textoFinal
        );

        return res.status(200).json({ success: true, telefone: numero });
      }

      // ── buscarPorPedido ────────────────────────────────────────────────────
      if (action === "buscarPorPedido") {
        const { termo } = req.method === "GET" ? req.query : req.body;
        if (!termo || !String(termo).trim()) return res.status(400).json({ error: "Falta termo" });

        const termoStr = String(termo).trim().toLowerCase();
        const matches  = [];

        const normalizarPedido = (p) => ({
          orderId:     String(p.order_id),
          nome:        p.nome_destinatario || "Cliente",
          telefone:    normalizarTelefone(p.telefone_destinatario) || "",
          status:      p.status,
          total:       p.valor_venda || "0",
          agendamento: p.agendamento || null,
          bairro:      p.bairro_destinatario || "",
          dataVenda:   p.data_venda || "",
        });

        // 1. Busca direta pelo ID
        const docDireto = await db().collection("pedidos").doc(termoStr).get();
        if (docDireto.exists) {
          matches.push(normalizarPedido(docDireto.data()));
        } else {
          const comoNum = String(parseInt(termoStr, 10));
          if (comoNum !== "NaN" && comoNum !== termoStr) {
            const docNum = await db().collection("pedidos").doc(comoNum).get();
            if (docNum.exists) matches.push(normalizarPedido(docNum.data()));
          }
        }

        // 2. Scan nos últimos 300 pedidos se não achou por ID
        if (matches.length === 0) {
          const snap = await db().collection("pedidos").orderBy("data_venda", "desc").limit(300).get();
          snap.docs.forEach((d) => {
            const p = d.data();
            const campos = [
              String(p.order_id || ""),
              String(p.nome_destinatario || ""),
              String(p.telefone_destinatario || "").replace(/\D/g, ""),
              String(p.bairro_destinatario || ""),
              String(p.logradouro_destinatario || ""),
              String(p.agendamento || ""),
            ].map((s) => s.toLowerCase());
            if (campos.some((c) => c.includes(termoStr))) matches.push(normalizarPedido(p));
          });
        }

        return res.status(200).json({ resultados: matches.slice(0, 20) });
      }

      // ── buscarContatos ──────────────────────────────────────────────────────
      // O painel agora só mantém as ~200 conversas mais recentes + fixadas ao
      // vivo (ver useConversas.ts) — sem isso, achar um cliente antigo que
      // caiu fora dessa janela ficaria impossível pela busca local. Varre a
      // coleção inteira só quando alguém digita algo na busca (raro), não a
      // cada abertura do Chat.
      if (action === "buscarContatos") {
        const { termo } = req.method === "GET" ? req.query : req.body;
        if (!termo || !String(termo).trim()) return res.status(400).json({ error: "Falta termo" });
        const termoStr = String(termo).trim().toLowerCase();

        const snap = await db().collection("conversas").get();
        const matches = [];
        snap.docs.forEach((d) => {
          const c = d.data();
          const campos = [
            String(c.clientName || ""),
            String(c.phone || d.id || "").replace(/\D/g, ""),
          ].map((s) => s.toLowerCase());
          if (campos.some((s) => s.includes(termoStr))) {
            matches.push({ id: d.id, clientName: c.clientName || "Cliente", phone: c.phone || d.id });
          }
        });

        return res.status(200).json({ resultados: matches.slice(0, 20) });
      }

      // ── diagnosticoPix (só leitura) ────────────────────────────────────────
      // Ajuda a decidir se um PIX que caiu em pendências (pix_nao_encontrado)
      // é de verdade um pedido daqui que passou da janela de 12h do
      // webhookAsaas, ou um PIX de outra origem (cobrança avulsa criada
      // direto no Asaas, sem relação nenhuma com pedido). Não escreve nada.
      if (action === "diagnosticoPix") {
        const { idPagamento, valor } = req.body;
        if (!idPagamento) return res.status(400).json({ error: "Falta idPagamento" });

        let pagamentoAsaas = null;
        let erroAsaas = null;
        try {
          const headers = { access_token: ASAAS_API_KEY.value(), "User-Agent": "FabricaSalgadosDashboard/1.0" };
          const { data } = await comRetentativa(
            () => http.get(`${ASAAS_API_BASE}/payments/${idPagamento}`, { headers }),
            { rotulo: `asaas:payments/${idPagamento}`, circuito: "asaas" }
          );
          pagamentoAsaas = {
            value: data.value,
            dateCreated: data.dateCreated,
            billingType: data.billingType,
            description: data.description || null,
            externalReference: data.externalReference || null,
            status: data.status,
          };
        } catch (erro) {
          erroAsaas = erro.response?.data || erro.message;
        }

        const pagador = await buscarPagadorDoPagamento(idPagamento, ASAAS_API_KEY.value());

        const valorAlvo = Number(valor) || pagamentoAsaas?.value || 0;
        const snap = await db().collection("pedidos")
          .orderBy("data_venda", "desc")
          .limit(3000)
          .get();

        const candidatos = [];
        snap.forEach((d) => {
          const data = d.data();
          const codigos = extrairCodigosPagamento(data.forma_pagamento);
          const ehPix = codigos.includes("17") || codigos.some((c) => c.toUpperCase().includes("PIX"));
          if (!ehPix) return;
          const valorPedido = parseFloat(String(data.valor_venda ?? "0").replace(",", "."));
          if (Math.abs(valorPedido - valorAlvo) < 0.5) {
            candidatos.push({
              id: d.id,
              nome: data.nome_destinatario || null,
              telefone: data.telefone_destinatario || null,
              valor_venda: data.valor_venda,
              data_venda: data.data_venda,
              pix_confirmado: !!data.pix_confirmado,
              agendamento: data.agendamento || null,
            });
          }
        });

        return res.status(200).json({
          success: true,
          pagamentoAsaas,
          erroAsaas,
          pagador,
          candidatos,
        });
      }

      // ── confirmarPixManualmente ──────────────────────────────────────────
      // Uso pontual: casar na mão um PIX que caiu em pendência
      // (pix_sem_vinculo_exato/pix_nao_encontrado/pix_colisao) depois de
      // checado manualmente via
      // diagnosticoPix. Não manda WhatsApp de "PIX confirmado" — o pedido já
      // pode estar despachado/entregue há dias, avisar agora só confundiria
      // o cliente. Só ajusta o registro (pix_confirmado, ficha, pendência).
      if (action === "confirmarPixManualmente") {
        const decisaoPermissao = exigirCapacidadePainel(
          res,
          operadorPainel,
          "financeiro.confirmar_pix"
        );
        if (!decisaoPermissao) return;
        const { idPagamento, orderId } = req.body;
        if (!idPagamento || !orderId) return res.status(400).json({ error: "Falta idPagamento ou orderId" });

        const paymentId = String(idPagamento).trim();
        const pedidoId = String(orderId).trim();
        if (!paymentId || !pedidoId) {
          return res.status(400).json({ error: "Falta idPagamento ou orderId" });
        }

        const pedidoRef = db().collection("pedidos").doc(pedidoId);
        const pedidoSnap = await pedidoRef.get();
        if (!pedidoSnap.exists) return res.status(404).json({ error: "Pedido não encontrado" });

        const pedido = pedidoSnap.data();

        // Mesmo a confirmação "manual" nunca confia apenas na decisão do
        // operador: relê a cobrança na API do Asaas e valida PIX, RECEIVED,
        // paymentId e valor exato. Pedido do app também exige a
        // externalReference e o paymentId que já estavam gravados nele.
        const pagamento = await buscarPagamentoAsaas(paymentId, ASAAS_API_KEY.value());
        const validarPedido = (pedidoParaValidar) => {
          const ehPedidoApp = pedidoParaValidar?.origem === "app";
          const resultado = validarPagamentoRecebido({
            pagamento,
            pedido: pedidoParaValidar,
            orderId: pedidoId,
            paymentId,
            exigirIdSalvo: ehPedidoApp || !!pedidoParaValidar?.pix_pagamento_id,
            exigirReferencia: ehPedidoApp,
          });
          const erros = [...resultado.erros];
          if (
            pedidoParaValidar?.order_id !== undefined &&
            String(pedidoParaValidar.order_id) !== pedidoId
          ) {
            erros.push("order_id_divergente_do_documento");
          }
          return {
            ...resultado,
            ok: erros.length === 0,
            erros: [...new Set(erros)],
          };
        };

        const validacao = validarPedido(pedido);
        if (!validacao.ok) {
          return res.status(409).json({
            error: "O pagamento não confere integralmente com este pedido.",
            motivos: validacao.erros,
          });
        }

        const operador = operadorPainel;
        const pagamentoRef = db().collection("pagamentos_asaas").doc(idDocSeguro(paymentId));
        const auditoriaRef = db().collection("auditorias_pix").doc();
        const pendenciasCollection = db().collection("pendencias");
        const eventosCollection = db().collection("eventos_asaas");
        const pendenciasDeterministicas = TIPOS_PENDENCIA_CONFIRMACAO_PIX.map((tipo) => ({
          tipo,
          ref: pendenciasCollection.doc(idDocSeguro(`${tipo}_${paymentId}`)),
        }));
        const caminhosDeterministicos = new Map(
          pendenciasDeterministicas.map(({ tipo, ref }) => [ref.path, tipo])
        );

        const resultadoTx = await db().runTransaction(async (tx) => {
          // Todas as fontes que serão alteradas são relidas dentro da mesma
          // transação. Assim uma edição concorrente no pedido, um vínculo feito
          // por outro operador ou um evento novo força o retry do Firestore.
          const [
            pedidoAtualSnap,
            marcaSnap,
            pendenciasPorPagamentoSnap,
            eventosDoPagamentoSnap,
            ...pendenciasDeterministicasSnaps
          ] = await Promise.all([
            tx.get(pedidoRef),
            tx.get(pagamentoRef),
            tx.get(pendenciasCollection.where("pagamentoId", "==", paymentId)),
            tx.get(eventosCollection.where("paymentId", "==", paymentId)),
            ...pendenciasDeterministicas.map(({ ref }) => tx.get(ref)),
          ]);

          if (!pedidoAtualSnap.exists) return { pedidoAusente: true };

          const pedidoAtual = pedidoAtualSnap.data();
          const marca = marcaSnap.data() || {};
          if (marca.pedidoId && String(marca.pedidoId) !== pedidoId) {
            return { conflito: true, pedidoIdExistente: String(marca.pedidoId) };
          }
          if (
            pedidoAtual.pix_pagamento_id &&
            String(pedidoAtual.pix_pagamento_id) !== paymentId
          ) {
            return { conflito: true, paymentIdExistente: pedidoAtual.pix_pagamento_id };
          }

          // A validação anterior dá uma resposta rápida, mas esta é a que
          // autoriza a escrita: usa o pedido atual, já protegido pela transação.
          const validacaoAtual = validarPedido(pedidoAtual);
          if (!validacaoAtual.ok) {
            return { validacaoInvalida: true, motivos: validacaoAtual.erros };
          }

          const pendenciasEncontradas = new Map();
          const considerarPendencia = (docSnap, criterioPreferencial = null) => {
            if (!docSnap.exists) return;
            const dados = docSnap.data() || {};
            const tipo = String(dados.tipo || caminhosDeterministicos.get(docSnap.ref.path) || "");
            if (!TIPOS_PENDENCIA_CONFIRMACAO_PIX_SET.has(tipo) || dados.resolvida === true) return;

            let criterio = null;
            if (String(dados.pagamentoId || "") === paymentId) {
              criterio = "campo_pagamento_id";
            } else if (caminhosDeterministicos.has(docSnap.ref.path)) {
              criterio = "id_deterministico";
            } else if (textoContemIdentificadorExato(dados.descricao, paymentId)) {
              criterio = "descricao_legada";
            }
            criterio = criterioPreferencial || criterio;
            if (!criterio) return;
            pendenciasEncontradas.set(docSnap.ref.path, { docSnap, criterio });
          };

          for (const snap of pendenciasDeterministicasSnaps) {
            considerarPendencia(snap);
          }
          for (const doc of pendenciasPorPagamentoSnap.docs) {
            considerarPendencia(doc);
          }

          // Compatibilidade com alertas antigos, anteriores ao campo
          // pagamentoId e ao ID determinístico. Só faz a varredura legada se
          // as formas fortes acima não localizaram uma pendência aberta.
          if (pendenciasEncontradas.size === 0) {
            const pendenciasLegadasSnap = await tx.get(
              pendenciasCollection
                .where("tipo", "in", TIPOS_PENDENCIA_CONFIRMACAO_PIX)
                .where("resolvida", "==", false)
            );
            for (const doc of pendenciasLegadasSnap.docs) {
              considerarPendencia(doc);
            }
          }

          const eventosParaConcluir = eventosDoPagamentoSnap.docs.filter((doc) => {
            const dados = doc.data() || {};
            return (
              dados.estado === "requer_revisao" &&
              TIPOS_PENDENCIA_CONFIRMACAO_PIX_SET.has(String(dados.motivoRevisao || ""))
            );
          });
          const pendenciasResolvidas = [...pendenciasEncontradas.values()];
          const pendenciasResolvidasIds = pendenciasResolvidas.map(({ docSnap }) => docSnap.id);
          const eventosConcluidosIds = eventosParaConcluir.map((doc) => doc.id);

          const jaConfirmado =
            pedidoAtual.pix_confirmado === true &&
            String(pedidoAtual.pix_pagamento_id || "") === paymentId;
          const agoraServidor = admin.firestore.FieldValue.serverTimestamp();
          const promocaoOperacional = atualizacaoOperacionalAoConfirmarPix(pedidoAtual);
          const atualizacaoPedido = {
            pix_confirmado: true,
            pix_status: "RECEIVED",
            pix_pagamento_id: paymentId,
            pix_valor_recebido: parseValor(pagamento.value),
            ...(!jaConfirmado || !pedidoAtual.pix_confirmado_em
              ? { pix_confirmado_em: agoraServidor }
              : {}),
            pix_confirmado_manualmente: true,
            pix_confirmado_manualmente_por: operador,
            pix_confirmacao_manual_em: agoraServidor,
            pix_origem_confirmacao: "manual",
            pix_asaas_ultima_verificacao_em: agoraServidor,
            pix_proxima_verificacao_em: admin.firestore.Timestamp.fromMillis(
              Date.now() + 15 * 60 * 1000
            ),
            pix_auditoria_etapa: 0,
            ...promocaoOperacional,
            ...(eventosConcluidosIds.length
              ? {
                  pix_asaas_eventos_concluidos_manualmente:
                    admin.firestore.FieldValue.arrayUnion(...eventosConcluidosIds),
                }
              : {}),
          };
          tx.set(pedidoRef, atualizacaoPedido, { merge: true });
          const pedidoDepoisDaConfirmacao = { ...pedidoAtual, ...atualizacaoPedido };
          if (!pedidoVisivelNoPainel(pedidoDepoisDaConfirmacao)) {
            tx.set(
              db().collection("pendencias").doc(idDocSeguro(`pix_pago_invisivel_${paymentId}`)),
              {
                chatId: "sistema",
                tipo: "pix_pago_pedido_invisivel",
                pagamentoId: paymentId,
                pedidoId,
                descricao:
                  `O PIX do pedido #${pedidoId} foi confirmado manualmente, mas o status operacional ` +
                  `${String(pedidoDepoisDaConfirmacao.status ?? "ausente")} não aparece no painel.`,
                resolvida: false,
                criadaEm: horaAtualSP(),
                criadaEmTimestamp: agoraServidor,
              },
              { merge: true }
            );
          }
          tx.set(pagamentoRef, {
            casado: true,
            pedidoId,
            paymentId,
            status: "RECEIVED",
            billingType: pagamento.billingType,
            externalReference: pagamento.externalReference || null,
            valor: parseValor(pagamento.value),
            verificadoDiretamenteNaApi: true,
            confirmadoManualmente: true,
            confirmadoManualmentePor: operador,
            confirmadoManualmenteEm: agoraServidor,
            atualizadoEm: agoraServidor,
            ...(eventosConcluidosIds.length
              ? {
                  eventosConcluidosManualmente:
                    admin.firestore.FieldValue.arrayUnion(...eventosConcluidosIds),
                }
              : {}),
          }, { merge: true });

          for (const { docSnap, criterio } of pendenciasResolvidas) {
            tx.set(docSnap.ref, {
              resolvida: true,
              resolvidaEm: agoraServidor,
              resolvidaEmTimestamp: agoraServidor,
              resolvidaPor: operador,
              resolucao: "confirmacao_manual_pix",
              criterioResolucao: criterio,
              pedidoId,
              pagamentoId: paymentId,
              auditoriaId: auditoriaRef.id,
            }, { merge: true });
          }

          for (const eventoDoc of eventosParaConcluir) {
            tx.set(eventoDoc.ref, {
              estado: "concluido",
              resultado: jaConfirmado
                ? "ja_confirmado_manualmente"
                : "confirmado_manualmente",
              pedidoId,
              concluidoEm: agoraServidor,
              concluidoManualmente: true,
              concluidoManualmentePor: operador,
              revisaoResolvidaEm: agoraServidor,
              auditoriaId: auditoriaRef.id,
            }, { merge: true });
          }

          tx.set(auditoriaRef, {
            acao: "confirmar_pix_manualmente",
            resultado: jaConfirmado
              ? "alertas_limpos_pedido_ja_confirmado"
              : "pedido_confirmado",
            pedidoId,
            pagamentoId: paymentId,
            operador,
            autorizacao: decisaoPermissao,
            origem: "api_conversas",
            validacao: validacaoAtual,
            estadoAnterior: {
              pixConfirmado: pedidoAtual.pix_confirmado === true,
              pixStatus: pedidoAtual.pix_status || null,
              pixPagamentoId: pedidoAtual.pix_pagamento_id || null,
            },
            pendenciasResolvidas: pendenciasResolvidasIds,
            eventosConcluidos: eventosConcluidosIds,
            criadoEm: agoraServidor,
          });

          return {
            conflito: false,
            jaConfirmado,
            pedidoAtual,
            pendenciasResolvidasIds,
            eventosConcluidosIds,
            auditoriaId: auditoriaRef.id,
          };
        });

        if (resultadoTx.pedidoAusente) {
          return res.status(404).json({ error: "Pedido não encontrado" });
        }
        if (resultadoTx.conflito) {
          return res.status(409).json({
            error: "Este pedido ou pagamento já está vinculado a outra conciliação.",
            detalhes: resultadoTx,
          });
        }
        if (resultadoTx.validacaoInvalida) {
          return res.status(409).json({
            error: "O pagamento não confere integralmente com este pedido.",
            motivos: resultadoTx.motivos,
          });
        }

        try {
          const pedidoConfirmado = resultadoTx.pedidoAtual || pedido;
          await atualizarStatusPixNaFicha(
            normalizarTelefone(pedidoConfirmado.telefone_destinatario) ?? "",
            pedidoConfirmado.order_id || pedidoId,
            true,
            "RECEIVED"
          );
        } catch (erroFicha) {
          console.error(`[confirmarPixManualmente] Falha ao atualizar ficha (pedido ${pedidoId}):`, erroFicha.message);
        }

        return res.status(200).json({
          success: true,
          jaConfirmado: resultadoTx.jaConfirmado,
          // Mantém o campo singular usado pela API anterior e acrescenta as
          // listas completas para diagnóstico/auditoria.
          pendenciaResolvidaId: resultadoTx.pendenciasResolvidasIds[0] || null,
          pendenciasResolvidasIds: resultadoTx.pendenciasResolvidasIds,
          eventosConcluidosIds: resultadoTx.eventosConcluidosIds,
          auditoriaId: resultadoTx.auditoriaId,
        });
      }

      // ── backfillLastMessageAt (uso único) ──────────────────────────────────
      // O painel vai passar a limitar o listener de conversas às N mais
      // recentes via orderBy("lastMessageAt"), e o Firestore omite (sem
      // aviso) qualquer doc que não tenha esse campo. Alguns caminhos antigos
      // de criação (ex.: cliente que só fez pedido, nunca mandou WhatsApp)
      // nunca gravaram esse campo. Isso varre a coleção UMA VEZ e preenche
      // só quem está faltando — não sobrescreve quem já tem.
      if (action === "backfillLastMessageAt") {
        const dryRun = !!(req.method === "GET" ? req.query.dryRun : req.body.dryRun);

        const snap = await db().collection("conversas").get();
        const faltando = snap.docs.filter((d) => !d.data().lastMessageAt);

        if (dryRun) {
          return res.status(200).json({
            success: true,
            dryRun: true,
            totalConversas: snap.size,
            semLastMessageAt: faltando.length,
            amostra: faltando.slice(0, 10).map((d) => d.id),
          });
        }

        let corrigidos = 0;
        for (let i = 0; i < faltando.length; i += 400) {
          const lote = faltando.slice(i, i + 400);
          const batch = db().batch();
          for (const doc of lote) {
            const dados = doc.data();
            const melhorData =
              dados.timestamp || dados.lastIncomingAt || dados.criadoEm ||
              admin.firestore.FieldValue.serverTimestamp();
            batch.set(doc.ref, { lastMessageAt: melhorData }, { merge: true });
          }
          await batch.commit();
          corrigidos += lote.length;
        }

        return res.status(200).json({
          success: true,
          dryRun: false,
          totalConversas: snap.size,
          corrigidos,
        });
      }

      return res.status(400).json({ error: `Action desconhecida: ${action}` });
    } catch (error) {
      console.error(`[conversas/${action}] Erro:`, error.response?.data || error.message);
      return res.status(500).json({ error: "Erro interno" });
    }
  }
);

module.exports = { conversas };
