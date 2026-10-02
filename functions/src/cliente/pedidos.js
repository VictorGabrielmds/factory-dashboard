// ============================================================================
// CRIAÇÃO DE PEDIDO — App Cliente (checkout)
// Único caminho pelo qual um pedido do app cliente entra em pedidos/ — o
// cliente NUNCA escreve essa coleção direto (ver firestore.rules, allow
// create exige logado()/staff). Preço, nome e valor de cada item vêm
// SEMPRE do servidor (produtos/{id} e cupons/{codigo}), nunca do que o
// cliente mandou — mesmo princípio já usado em validarCupom.
//
// O documento gerado usa o MESMO formato que o InstaDelivery já manda pro
// webhookPedidos (descricao_item[]/quantidade_item[]/forma_pagamento[] —
// ver src/types/Pedido.ts no painel): recibo por WhatsApp, tela da
// cozinha, atribuição de motoboy e confirmação de PIX (webhookAsaas.js)
// continuam funcionando sem qualquer alteração nelas.
//
// CONCORRÊNCIA (várias pessoas pedindo ao mesmo tempo):
//   - idempotencyKey (gerada no app cliente, mesmo padrão do outbox do
//     painel): clique duplo ou retry de rede nunca cria dois pedidos/duas
//     cobranças PIX — a 2ª chamada com a mesma chave devolve o resultado
//     já concluído ou retoma o MESMO order_id após o vencimento do lease.
//   - Preço e disponibilidade de cada produto são lidos DENTRO da mesma
//     transação que grava o pedido (tx.get), não antes — se dois checkouts
//     concorrentes disputam o mesmo produto (ex.: staff edita o preço no
//     meio de um checkout), o Firestore detecta o conflito e tenta de novo
//     sozinho (retry automático de runTransaction), nunca grava com dado velho.
//   - order_id tem 9 dígitos, é reservado junto da idempotencyKey e tem a
//     colisão verificada antes de ser usado.
//
// Ordem pensada pra nunca deixar estado inconsistente NEM notificar o
// cliente sobre algo que não existe de verdade:
//   1. Reivindica a idempotencyKey.
//   2. Transação: lê produtos e cupom, valida tudo, consome o cupom E cria
//      o pedido juntos (atômico — ou os dois acontecem, ou nenhum). PIX
//      entra com status 1 (não dispara recibo); débito/crédito já entram
//      com status 2.
//   3. Se for PIX, chama o Asaas DEPOIS da transação. O QR fica durável,
//      mas o pedido permanece em status 1, visível em Aguardando PIX.
//      Somente a confirmação financeira libera status 2. Resultado inconclusivo preserva o pedido e entra
//      na recuperação automática; rejeição definitiva sem cobrança conhecida
//      desfaz pedido, cupom e contador na mesma transação.
//   4. Pedido e idempotência são concluídos juntos. O app também guarda a
//      tentativa por 48h para sobreviver a fechamento ou recarga da página.
// ============================================================================

const crypto = require("crypto");
const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const { ASAAS_API_KEY_ESCRITA } = require("../config");
const { dataHoraAtualSP } = require("../lib/util");
const { criarClienteAsaas, criarCobrancaPix, buscarQrCodePix } = require("../services/asaasEscrita");
const {
  gerarHashCheckout,
  decidirReivindicacao,
  resultadoDoPedidoPersistido,
  montarConclusaoQrPix,
  erroAsaasEhDefinitivo,
} = require("../services/checkoutConfiavel");
const { buscarInfoZona } = require("../services/entrega");
const { buscarHorarioFuncionamento, validarAgendamento, formatarAgendamento } = require("../services/horario");
const { buscarConfiguracaoGeral } = require("../services/pagamento");

const db = () => admin.firestore();

const CODIGO_PAGAMENTO = { pix: "17", debito: "04", credito: "03" };
const CPF_CNPJ_REGEX = /^(\d{11}|\d{14})$/;
const MAX_ITENS = 50;
// Colchão de tempo entre o cliente escolher um horário e apertar "Finalizar"
// — sem isso, o primeiro horário da lista pode deixar de valer só pelo tempo
// que ele leva preenchendo o resto do checkout (aqui validamos contra o
// relógio NA HORA de finalizar). Mesmo valor usado em CarrinhoContext.tsx.
const MARGEM_PREENCHIMENTO_MINUTOS = 5;
const DURACAO_IDEMPOTENCIA_MS = 48 * 60 * 60 * 1000;
const DURACAO_LEASE_MS = 90 * 1000;
const INTERVALO_RECUPERACAO_PIX_MS = 2 * 60 * 1000;

// Número de 9 dígitos, mesmo estilo dos pedidos que já chegam pelo
// InstaDelivery (#142354374) — o painel mostra os dois tipos de pedido
// misturados na mesma tela (OrderCard/PedidoTicket/OrdersList), sempre como
// "#{order_id}", então ficam visualmente idênticos pra quem trabalha ali.
// 900 milhões de valores possíveis: colisão é praticamente impossível mesmo
// em anos de operação, e a transação abaixo confere/recusa de qualquer jeito.
function gerarOrderId() {
  return String(crypto.randomInt(100000000, 1000000000));
}

// Soma o tempo de preparo de cada item DISTINTO do carrinho, com o tempo
// próprio do produto ou o padrão geral quando ele não tem um definido — a
// cozinha prepara em paralelo, não item por item, ATÉ um certo volume: até
// TAMANHO_LOTE_PREPARO unidades do mesmo item contam como um lote só (não
// multiplica o tempo); a partir daí, cada lote adicional de até 90 unidades
// soma mais um tempo de preparo inteiro (pedido de 200 unidades de um mesmo
// item não sai no mesmo tempo que um de 2 — mas até 90, sim). Lido fora da
// transação principal (não precisa de consistência transacional, só do
// valor mais recente) porque a antecedência de agendamento precisa desse
// número ANTES de validarAgendamento, que roda antes da transação que lê os
// produtos de verdade pra preço/disponibilidade.
const TAMANHO_LOTE_PREPARO = 90;

async function calcularTempoPreparoMinutos(itensValidados, tempoPreparoPadrao) {
  const snaps = await Promise.all(
    itensValidados.map((item) => db().collection("produtos").doc(item.produtoId).get())
  );
  return snaps.reduce((soma, snap, i) => {
    const tempo = snap.exists && typeof snap.data().tempoPreparoMinutos === "number"
      ? snap.data().tempoPreparoMinutos
      : tempoPreparoPadrao;
    const lotes = Math.max(1, Math.ceil(itensValidados[i].quantidade / TAMANHO_LOTE_PREPARO));
    return soma + tempo * lotes;
  }, 0);
}

function timestampDaqui(ms) {
  return admin.firestore.Timestamp.fromMillis(Date.now() + ms);
}

function mensagemErro(erro) {
  return String(
    erro?.response?.data?.errors?.[0]?.description ??
    erro?.response?.data?.message ??
    erro?.message ??
    erro
  ).slice(0, 1500);
}

async function reivindicarCheckout({ idempotencyRef, uid, payloadHash }) {
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const candidatoPedidoId = gerarOrderId();
    try {
      return await db().runTransaction(async (tx) => {
        const idempotencySnap = await tx.get(idempotencyRef);
        const registro = idempotencySnap.exists ? idempotencySnap.data() : null;
        const decisao = decidirReivindicacao(registro, {
          uid,
          payloadHash,
          agoraMs: Date.now(),
        });

        if (decisao.acao === "retornar") {
          return { concluido: true, resultado: decisao.resultado };
        }
        if (decisao.acao === "recusar_usuario") {
          throw new HttpsError("permission-denied", "Esta tentativa pertence a outra sessão.");
        }
        if (decisao.acao === "recusar_conteudo") {
          throw new HttpsError(
            "invalid-argument",
            "Os dados desta tentativa mudaram. Atualize a página e finalize novamente."
          );
        }
        if (decisao.acao === "aguardar") {
          throw new HttpsError(
            "already-exists",
            "O pedido ainda está sendo confirmado. Aguarde alguns segundos."
          );
        }

        let pedidoId = decisao.pedidoId || null;
        if (!pedidoId) {
          // Mesmo que o TTL já tenha removido o marcador, a chave também fica
          // no pedido. Essa busca fecha a janela rara entre as duas retenções.
          const pedidosDaChave = await tx.get(
            db().collection("pedidos")
              .where("checkout_idempotency_key", "==", idempotencyRef.id)
              .limit(2)
          );
          if (pedidosDaChave.size > 1) {
            throw new HttpsError(
              "failed-precondition",
              "Foram encontrados pedidos duplicados para a mesma tentativa. A equipe precisa conferir."
            );
          }
          if (pedidosDaChave.size === 1) {
            const pedidoRecuperado = pedidosDaChave.docs[0];
            const dadosPedido = pedidoRecuperado.data();
            if (dadosPedido.clienteUid !== uid) {
              throw new HttpsError("permission-denied", "Esta tentativa pertence a outra sessão.");
            }
            if (dadosPedido.checkout_payload_hash && dadosPedido.checkout_payload_hash !== payloadHash) {
              throw new HttpsError("invalid-argument", "O conteúdo desta tentativa não corresponde ao pedido salvo.");
            }
            pedidoId = pedidoRecuperado.id;
          } else {
            pedidoId = candidatoPedidoId;
            const pedidoComMesmoId = await tx.get(db().collection("pedidos").doc(pedidoId));
            if (pedidoComMesmoId.exists) {
              const erroColisao = new Error("COLISAO_PEDIDO");
              erroColisao.colisaoPedido = true;
              throw erroColisao;
            }
          }
        }

        const agora = admin.firestore.FieldValue.serverTimestamp();
        tx.set(idempotencyRef, {
          tipo: "checkout_app_cliente",
          uid,
          payloadHash,
          pedidoId,
          estado: "processando",
          leaseAte: timestampDaqui(DURACAO_LEASE_MS),
          atualizadoEm: agora,
          expiraEm: timestampDaqui(DURACAO_IDEMPOTENCIA_MS),
          tentativas: admin.firestore.FieldValue.increment(1),
          ...(idempotencySnap.exists ? {} : { criadoEm: agora }),
        }, { merge: true });

        return { concluido: false, pedidoId };
      });
    } catch (erro) {
      if (erro?.colisaoPedido === true) continue;
      throw erro;
    }
  }
  throw new HttpsError("aborted", "Não foi possível reservar o número do pedido. Tente novamente.");
}

async function concluirIdempotencia(idempotencyRef, resultado, vinculo = {}) {
  await idempotencyRef.set({
    tipo: "checkout_app_cliente",
    ...(vinculo.uid ? { uid: vinculo.uid } : {}),
    ...(vinculo.pedidoId ? { pedidoId: vinculo.pedidoId } : {}),
    ...(vinculo.payloadHash ? { payloadHash: vinculo.payloadHash } : {}),
    estado: "concluido",
    resultado,
    concluidoEm: admin.firestore.FieldValue.serverTimestamp(),
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    leaseAte: admin.firestore.FieldValue.delete(),
    expiraEm: timestampDaqui(DURACAO_IDEMPOTENCIA_MS),
  }, { merge: true });
}

async function concluirPixAtomico({ pedidoRef, idempotencyRef, paymentId, qrCode }) {
  return db().runTransaction(async (tx) => {
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) {
      throw new HttpsError("not-found", "O pedido não foi encontrado durante a recuperação do PIX.");
    }
    const pedido = pedidoSnap.data();
    if (
      pedido.pix_pagamento_id &&
      String(pedido.pix_pagamento_id) !== String(paymentId)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "A cobrança PIX recuperada não corresponde à cobrança já vinculada ao pedido."
      );
    }

    const resultado = {
      orderId: pedidoRef.id,
      pix: {
        qrCodeBase64: qrCode.qrCodeBase64,
        copiaCola: qrCode.copiaCola,
      },
      numeroPedidoCliente: pedido.numero_pedido_cliente || null,
    };

    const conclusaoQr = montarConclusaoQrPix({ pedido, paymentId, qrCode });
    tx.set(pedidoRef, {
      ...conclusaoQr.atualizacao,
      pix_checkout_concluido_em: admin.firestore.FieldValue.serverTimestamp(),
      pix_checkout_proxima_tentativa_em: admin.firestore.FieldValue.delete(),
      pix_checkout_lease_ate: admin.firestore.FieldValue.delete(),
      pix_checkout_ultimo_erro: admin.firestore.FieldValue.delete(),
      ...(conclusaoQr.deveAgendarVerificacaoInicial
        ? {
            pix_proxima_verificacao_em: timestampDaqui(2 * 60 * 1000),
          }
        : {}),
    }, { merge: true });
    tx.set(idempotencyRef, {
      tipo: "checkout_app_cliente",
      uid: pedido.clienteUid,
      pedidoId: pedidoRef.id,
      ...(pedido.checkout_payload_hash ? { payloadHash: pedido.checkout_payload_hash } : {}),
      estado: "concluido",
      resultado,
      concluidoEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      leaseAte: admin.firestore.FieldValue.delete(),
      expiraEm: timestampDaqui(DURACAO_IDEMPOTENCIA_MS),
    }, { merge: true });
    return resultado;
  });
}

async function processarPixPendente({ pedidoRef, idempotencyRef }) {
  let pedidoSnap = await pedidoRef.get();
  if (!pedidoSnap.exists) {
    throw new HttpsError("not-found", "Pedido PIX não encontrado.");
  }
  let pedido = pedidoSnap.data();
  const resultadoExistente = resultadoDoPedidoPersistido(pedidoRef.id, pedido);
  if (resultadoExistente) {
    await concluirIdempotencia(idempotencyRef, resultadoExistente, {
      uid: pedido.clienteUid,
      pedidoId: pedidoRef.id,
      payloadHash: pedido.checkout_payload_hash,
    });
    return resultadoExistente;
  }

  await db().runTransaction(async (tx) => {
    const atualSnap = await tx.get(pedidoRef);
    if (!atualSnap.exists) throw new HttpsError("not-found", "Pedido PIX não encontrado.");
    const atual = atualSnap.data();
    const leaseAtual = atual.pix_checkout_lease_ate?.toMillis?.() || 0;
    if (leaseAtual > Date.now()) {
      throw new HttpsError(
        "already-exists",
        "A recuperação deste PIX já está em andamento."
      );
    }
    tx.set(pedidoRef, {
      pix_checkout_lease_ate: timestampDaqui(DURACAO_LEASE_MS),
      pix_checkout_ultima_tentativa_em: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(idempotencyRef, {
      tipo: "checkout_app_cliente",
      uid: atual.clienteUid,
      pedidoId: pedidoRef.id,
      ...(atual.checkout_payload_hash ? { payloadHash: atual.checkout_payload_hash } : {}),
      estado: "processando",
      leaseAte: timestampDaqui(DURACAO_LEASE_MS),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      expiraEm: timestampDaqui(DURACAO_IDEMPOTENCIA_MS),
    }, { merge: true });
  });

  pedidoSnap = await pedidoRef.get();
  pedido = pedidoSnap.data();
  const clienteRef = db().collection("clientes").doc(String(pedido.clienteUid || ""));
  const clienteSnap = await clienteRef.get();
  const cliente = clienteSnap.exists ? clienteSnap.data() : {};
  let asaasCustomerId = pedido.pix_asaas_customer_id || cliente.asaasCustomerId;

  if (!asaasCustomerId) {
    asaasCustomerId = await criarClienteAsaas({
      nome: pedido.nome_destinatario,
      telefone: pedido.telefone_destinatario,
      cpf: pedido.pix_cpf_cnpj,
    }, ASAAS_API_KEY_ESCRITA.value());
  }

  await db().runTransaction(async (tx) => {
    const atualSnap = await tx.get(pedidoRef);
    if (!atualSnap.exists) throw new HttpsError("not-found", "Pedido PIX não encontrado.");
    const atual = atualSnap.data();
    if (
      atual.pix_asaas_customer_id &&
      String(atual.pix_asaas_customer_id) !== String(asaasCustomerId)
    ) {
      asaasCustomerId = atual.pix_asaas_customer_id;
    }
    tx.set(pedidoRef, {
      pix_asaas_customer_id: asaasCustomerId,
      pix_checkout_ultima_tentativa_em: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(clienteRef, { asaasCustomerId }, { merge: true });
  });

  pedidoSnap = await pedidoRef.get();
  pedido = pedidoSnap.data();
  let paymentId = pedido.pix_pagamento_id;
  if (!paymentId) {
    paymentId = await criarCobrancaPix({
      customerId: asaasCustomerId,
      valor: pedido.valor_venda,
      orderId: pedidoRef.id,
    }, ASAAS_API_KEY_ESCRITA.value());

    await pedidoRef.set({
      pix_pagamento_id: paymentId,
      pix_status: "QR_PENDING",
      pix_checkout_ultima_tentativa_em: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  const qrCode = await buscarQrCodePix(paymentId, ASAAS_API_KEY_ESCRITA.value());
  return concluirPixAtomico({ pedidoRef, idempotencyRef, paymentId, qrCode });
}

async function marcarPixParaRecuperacao({ pedidoRef, idempotencyRef, erro }) {
  const descricao = mensagemErro(erro);
  await db().runTransaction(async (tx) => {
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) return;
    const tentativas = Number(pedidoSnap.data().pix_checkout_tentativas || 0) + 1;
    tx.set(pedidoRef, {
      pix_checkout_pendente: true,
      pix_checkout_tentativas: tentativas,
      pix_checkout_ultimo_erro: descricao,
      pix_checkout_ultima_falha_em: admin.firestore.FieldValue.serverTimestamp(),
      pix_checkout_proxima_tentativa_em: timestampDaqui(INTERVALO_RECUPERACAO_PIX_MS),
      pix_checkout_lease_ate: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    tx.set(idempotencyRef, {
      estado: "aguardando_recuperacao_pix",
      ultimoErro: descricao,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      leaseAte: admin.firestore.FieldValue.delete(),
    }, { merge: true });
  });
}

async function desfazerPedidoPix({ pedidoRef, idempotencyRef }) {
  await db().runTransaction(async (tx) => {
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) {
      tx.set(idempotencyRef, {
        estado: "falhou",
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        leaseAte: admin.firestore.FieldValue.delete(),
      }, { merge: true });
      return;
    }

    const pedido = pedidoSnap.data();
    const cupomRef = pedido.cupomAplicado
      ? db().collection("cupons").doc(String(pedido.cupomAplicado))
      : null;
    const clienteRef = db().collection("clientes").doc(String(pedido.clienteUid));
    const cupomSnap = cupomRef ? await tx.get(cupomRef) : null;
    const clienteSnap = await tx.get(clienteRef);

    tx.delete(pedidoRef);
    if (cupomRef && cupomSnap.exists) {
      tx.update(cupomRef, {
        usosCount: Math.max(Number(cupomSnap.data().usosCount || 1) - 1, 0),
      });
    }
    tx.set(clienteRef, {
      totalPedidos: Math.max(Number(clienteSnap.data()?.totalPedidos || 1) - 1, 0),
    }, { merge: true });
    tx.set(idempotencyRef, {
      estado: "falhou",
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      leaseAte: admin.firestore.FieldValue.delete(),
    }, { merge: true });
  });
}

const criarPedido = onCall(
  {
    region: "southamerica-east1",
    secrets: [ASAAS_API_KEY_ESCRITA],
    enforceAppCheck: true,
    // Sem override — usa o teto padrão de 10 instâncias (setGlobalOptions em
    // index.js), que já é sobra de sobra pro volume real (~200 pedidos/dia,
    // picos raros de ~600 em datas especiais). 10 instâncias concorrentes,
    // cada uma processando um pedido em 1–3s, aguentam uma taxa de centenas
    // de pedidos por MINUTO — nunca é o gargalo real. maxInstances alto
    // demais aqui só rouba cota de CPU (20 vCPU no total, compartilhada por
    // TODAS as functions da região) dos outros serviços do projeto — foi
    // isso que quebrou o deploy quando esse valor estava em 30.
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Faça login para finalizar o pedido.");
    }
    const uid = request.auth.uid;
    const payload = request.data || {};
    const { idempotencyKey } = payload;

    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 10) {
      throw new HttpsError("invalid-argument", "Requisição inválida — atualize o app e tente novamente.");
    }

    const idempotencyRef = db().collection("_idempotency").doc(idempotencyKey);
    const payloadHash = gerarHashCheckout(payload);
    const reivindicacao = await reivindicarCheckout({
      idempotencyRef,
      uid,
      payloadHash,
    });
    if (reivindicacao.concluido) return reivindicacao.resultado;
    const orderId = reivindicacao.pedidoId;
    const pedidoRef = db().collection("pedidos").doc(orderId);

    try {
      // Uma resposta pode se perder depois de o pedido já ter sido salvo. A
      // repetição não refaz validações nem gera outro número: recupera o mesmo
      // documento e conclui apenas o que ainda estiver pendente.
      const pedidoJaPersistido = await pedidoRef.get();
      if (pedidoJaPersistido.exists) {
        const pedido = pedidoJaPersistido.data();
        if (pedido.clienteUid !== uid || pedido.checkout_idempotency_key !== idempotencyKey) {
          throw new HttpsError("failed-precondition", "A tentativa não corresponde ao pedido salvo.");
        }
        const resultadoSalvo = resultadoDoPedidoPersistido(orderId, pedido);
        if (resultadoSalvo) {
          await concluirIdempotencia(idempotencyRef, resultadoSalvo, {
            uid: pedido.clienteUid,
            pedidoId: orderId,
            payloadHash: pedido.checkout_payload_hash,
          });
          return resultadoSalvo;
        }
        if (pedido.pix_checkout_pendente === true) {
          return await processarPixPendente({ pedidoRef, idempotencyRef });
        }
        throw new HttpsError(
          "failed-precondition",
          "O pedido salvo está incompleto e precisa de conferência."
        );
      }

      const { itens, observacoes, cupomCodigo, formaPagamento, nome, cpf, tipoEntrega, endereco, agendamento } =
        payload;

      if (!Array.isArray(itens) || itens.length === 0 || itens.length > MAX_ITENS) {
        throw new HttpsError("invalid-argument", "Carrinho inválido.");
      }
      if (!CODIGO_PAGAMENTO[formaPagamento]) {
        throw new HttpsError("invalid-argument", "Forma de pagamento inválida.");
      }
      if (tipoEntrega !== "retirada" && tipoEntrega !== "delivery") {
        throw new HttpsError("invalid-argument", "Tipo de entrega inválido.");
      }

      const nomeLimpo = String(nome || "").trim().slice(0, 120);
      if (!nomeLimpo) {
        throw new HttpsError("invalid-argument", "Informe seu nome.");
      }
      const cpfLimpo = String(cpf || "").replace(/\D/g, "");
      if (formaPagamento === "pix" && !CPF_CNPJ_REGEX.test(cpfLimpo)) {
        throw new HttpsError("invalid-argument", "CPF/CNPJ inválido — obrigatório para pagar com PIX.");
      }
      // Fora do PIX o campo é opcional (só entra na nota) — mas se vier
      // preenchido precisa ter o formato certo, senão a notinha sai errada.
      if (formaPagamento !== "pix" && cpfLimpo && !CPF_CNPJ_REGEX.test(cpfLimpo)) {
        throw new HttpsError("invalid-argument", "CPF/CNPJ inválido.");
      }

      // Só valida o FORMATO aqui (não precisa ler nada) — existência,
      // disponibilidade e preço de verdade são lidos dentro da transação.
      const itensValidados = itens.map((item) => {
        const produtoId = String(item?.produtoId || "");
        const quantidade = Number(item?.quantidade);
        if (!produtoId || !Number.isInteger(quantidade) || quantidade <= 0 || quantidade > 100) {
          throw new HttpsError("invalid-argument", "Item de carrinho inválido.");
        }
        return { produtoId, quantidade };
      });

      // Taxa de cartão e tempo de preparo padrão vêm do mesmo doc — buscado
      // aqui (antes do agendamento) porque o tempo de preparo já entra na
      // antecedência mínima, e antes ainda da transação porque não precisa
      // de consistência transacional, só do valor mais recente.
      const configGeral = await buscarConfiguracaoGeral();
      const tempoPreparoTotal = await calcularTempoPreparoMinutos(itensValidados, configGeral.tempoPreparoPadraoMinutos);

      // Endereço/taxa/tempo de entrega precisam ser resolvidos ANTES de validar
      // o agendamento: a antecedência mínima pra delivery depende de quanto
      // tempo de moto até o bairro (retirada não tem esse tempo extra, mas
      // sempre tem o tempo de preparo, calculado acima).
      let enderecoCampos = {};
      let valorTaxa = 0;
      let tempoEntregaMinutos = 0;
      if (tipoEntrega === "delivery") {
        const bairro = String(endereco?.bairro || "").trim();
        const logradouro = String(endereco?.logradouro || "").trim();
        const numero = String(endereco?.numero || "").trim();
        if (!bairro || !logradouro || !numero) {
          throw new HttpsError("invalid-argument", "Endereço de entrega incompleto.");
        }
        const infoZona = await buscarInfoZona(bairro);
        valorTaxa = infoZona.taxa;
        tempoEntregaMinutos = infoZona.tempoEntregaMinutos;
        enderecoCampos = {
          cep_destinatario: String(endereco?.cep || "").replace(/\D/g, ""),
          logradouro_destinatario: logradouro,
          numero_destinatario: numero,
          bairro_destinatario: bairro,
          complemento_destinatario: String(endereco?.complemento || "").trim() || null,
          referencia: String(endereco?.referencia || "").trim() || null,
        };
      }

      // Todo pedido é agendado — o cliente escolhe um horário dentro do que
      // está configurado em configuracoes/horario, mas quem decide de verdade
      // se aquele horário vale é o servidor (mesma escolha já validada como
      // "prévia" em consultarHorarioFuncionamento/consultarTaxaEntrega).
      const dataAgendamento = String(agendamento?.data || "");
      const horaAgendamento = String(agendamento?.hora || "");
      const horarioFuncionamento = await buscarHorarioFuncionamento();
      // Preparo sempre conta (vale pra retirada também — a comida precisa
      // estar pronta), mais o tempo de moto até o bairro quando é delivery
      // (0 nesse caso pra retirada). Ex.: 30min de entrega + 10min de preparo
      // = primeiro horário só daqui 40min.
      const antecedenciaTotalMinutos = tempoPreparoTotal + tempoEntregaMinutos + MARGEM_PREENCHIMENTO_MINUTOS;
      const validacaoHorario = validarAgendamento(
        horarioFuncionamento,
        dataAgendamento,
        horaAgendamento,
        tipoEntrega,
        antecedenciaTotalMinutos
      );
      if (!validacaoHorario.valido) {
        throw new HttpsError("failed-precondition", validacaoHorario.motivo);
      }
      const agendamentoTexto = formatarAgendamento(dataAgendamento, horaAgendamento);

      const percentualTaxaCartao =
        formaPagamento === "debito"
          ? configGeral.taxaDebitoPercentual
          : formaPagamento === "credito"
            ? configGeral.taxaCreditoPercentual
            : 0;

      const clienteRef = db().collection("clientes").doc(uid);
      const clienteSnap = await clienteRef.get();
      const clienteDados = clienteSnap.exists ? clienteSnap.data() : {};
      const telefone = clienteDados.telefone;
      if (!telefone) {
        throw new HttpsError("failed-precondition", "Sessão inválida — faça login novamente.");
      }

      const codigoCupom = cupomCodigo ? String(cupomCodigo).trim().toUpperCase() : null;
      const cupomRef = codigoCupom ? db().collection("cupons").doc(codigoCupom) : null;
      const perfilEntrega = {
        tipoEntregaPreferida: tipoEntrega,
        ...(tipoEntrega === "delivery"
          ? {
              enderecoSalvo: {
                cep: enderecoCampos.cep_destinatario || "",
                logradouro: enderecoCampos.logradouro_destinatario || "",
                numero: enderecoCampos.numero_destinatario || "",
                complemento: enderecoCampos.complemento_destinatario || "",
                bairro: enderecoCampos.bairro_destinatario || "",
                referencia: enderecoCampos.referencia || "",
              },
            }
          : {}),
      };

      // Transação: lê produtos + cupom, valida e grava tudo junto — nunca um
      // pedido com preço desatualizado, nem um cupom "gasto" por um pedido
      // que acabou não existindo (ou vice-versa). Se outro checkout mexer no
      // mesmo produto/cupom ao mesmo tempo, o Firestore detecta o conflito e
      // tenta de novo sozinho (retry automático do runTransaction).
      const { total, numeroPedidoCliente } = await db().runTransaction(async (tx) => {
          // 1) TODAS as leituras primeiro (regra do Firestore p/ transações).
          const produtoRefs = itensValidados.map((it) => db().collection("produtos").doc(it.produtoId));
          const produtoSnaps = await Promise.all(produtoRefs.map((ref) => tx.get(ref)));

          let cupomSnap = null;
          if (cupomRef) cupomSnap = await tx.get(cupomRef);

          const pedidoExistente = await tx.get(pedidoRef);
          if (pedidoExistente.exists) {
            // Praticamente impossível com 9 dígitos numéricos — mas se
            // acontecer, é melhor falhar alto e deixar o cliente tentar de
            // novo (novo orderId) do que sobrescrever o pedido de outra pessoa.
            throw new HttpsError("aborted", "Conflito ao gerar o pedido — tente novamente.");
          }

          // Lido de novo AQUI (dentro da tx) — não pra reaproveitar o dado já
          // lido antes (telefone), mas pra incrementar totalPedidos de forma
          // atômica: se dois pedidos do mesmo cliente forem concorrentes, o
          // Firestore serializa as transações e nenhum incremento se perde.
          // totalPedidos conta só pedidos feitos PELO APP (métrica própria,
          // não lida em lugar nenhum hoje, mas mantida por completude).
          const clienteSnapTx = await tx.get(clienteRef);
          if (clienteSnapTx.data()?.pedidosBloqueados === true) {
            throw new HttpsError(
              "failed-precondition",
              "Seu cadastro está impedido de realizar pedidos. Entre em contato com a loja."
            );
          }
          const totalPedidosApp = (clienteSnapTx.data()?.totalPedidos || 0) + 1;

          // numero_pedido_cliente (gravado no PEDIDO, não na conta) conta em
          // TODOS os canais — mesmo telefone, InstaDelivery ou App Cliente —
          // mesmo critério do primeiro_pedido_cliente já calculado no webhook
          // do InstaDelivery (webhooks/pedidos.js). Sem isso, o primeiro
          // pedido de alguém pelo app apareceria como "== 1" (primeiro pedido)
          // mesmo se essa pessoa já tivesse pedido antes pelo InstaDelivery —
          // é esse número que o robô de impressão lê pra estampar "PRIMEIRO
          // PEDIDO" na notinha.
          const pedidosMesmoTelefoneSnap = await tx.get(
            db().collection("pedidos").where("telefone_destinatario", "==", telefone)
          );
          const numeroPedidoCliente = pedidosMesmoTelefoneSnap.size + 1;

          // 2) Validações que dependem do que foi lido AGORA, dentro da tx.
          const descricaoItemTx = [];
          const quantidadeItemTx = [];
          const valorTotalItemTx = [];
          const produtoIdItemTx = [];
          let subtotalTx = 0;
          produtoSnaps.forEach((snap, i) => {
            if (!snap.exists || snap.data().disponivel !== true) {
              throw new HttpsError("failed-precondition", "Um dos produtos do carrinho não está mais disponível.");
            }
            const produto = snap.data();
            const quantidade = itensValidados[i].quantidade;
            const totalItem = produto.preco * quantidade;
            descricaoItemTx.push(produto.nome);
            quantidadeItemTx.push(quantidade);
            valorTotalItemTx.push(totalItem);
            produtoIdItemTx.push(itensValidados[i].produtoId);
            subtotalTx += totalItem;
          });

          let descontoCalc = 0;
          if (cupomRef) {
            if (!cupomSnap.exists) throw new HttpsError("failed-precondition", "Cupom não encontrado.");
            const cupom = cupomSnap.data();
            if (!cupom.ativo) throw new HttpsError("failed-precondition", "Este cupom não está mais ativo.");
            if (cupom.expiraEm && Date.now() > cupom.expiraEm.toMillis()) {
              throw new HttpsError("failed-precondition", "Este cupom expirou.");
            }
            if (cupom.limiteUsos != null && (cupom.usosCount || 0) >= cupom.limiteUsos) {
              throw new HttpsError("failed-precondition", "Este cupom já atingiu o limite de usos.");
            }
            const valorDesconto = cupom.tipo === "fixo" ? cupom.valor : (subtotalTx * cupom.valor) / 100;
            descontoCalc = Math.min(valorDesconto, subtotalTx);
          }

          // Mínimo de delivery incide sobre o valor dos itens já com desconto
          // (não conta a taxa de entrega em cima) — evita corrida que deixasse
          // passar um carrinho abaixo do mínimo configurado em configuracoes/geral.
          if (tipoEntrega === "delivery" && configGeral.valorMinimoEntrega > 0) {
            const valorItensComDesconto = subtotalTx - descontoCalc;
            if (valorItensComDesconto < configGeral.valorMinimoEntrega) {
              throw new HttpsError(
                "failed-precondition",
                `Valor mínimo para entrega é R$ ${configGeral.valorMinimoEntrega.toFixed(2).replace(".", ",")}.`
              );
            }
          }

          // Taxa de cartão incide sobre o valor já com desconto/entrega — é
          // isso que a maquininha realmente cobra em cima do total da venda.
          const totalAntesTaxaCartao = subtotalTx - descontoCalc + valorTaxa;
          const valorTaxaCartaoCalc =
            percentualTaxaCartao > 0
              ? Math.round(totalAntesTaxaCartao * percentualTaxaCartao) / 100
              : 0;
          const totalCalc = totalAntesTaxaCartao + valorTaxaCartaoCalc;

          // 3) Escritas — só depois de todas as leituras acima.
          if (cupomRef) {
            tx.update(cupomRef, { usosCount: (cupomSnap.data().usosCount || 0) + 1 });
          }

          tx.set(clienteRef, {
            totalPedidos: totalPedidosApp,
            nome: nomeLimpo,
            ...(formaPagamento === "pix" ? { cpf: cpfLimpo } : {}),
            ...perfilEntrega,
          }, { merge: true });

          tx.set(pedidoRef, {
            order_id: orderId,
            data_venda: dataHoraAtualSP(),
            // Dia em que a equipe realmente precisa operar este pedido. Não
            // depende da data de criação e permite encontrar agendamentos
            // antigos sem varrer todo o histórico.
            data_operacional: dataAgendamento,
            // Timestamp de verdade (data_venda acima é só texto formatado
            // DD/MM/YYYY, não dá pra ordenar/consultar por ele) — usado por
            // "repetir último pedido" e "solicitar alteração" no app cliente.
            criadoEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            // status 2 (Aceito/Em preparo) libera o fluxo operacional.
            // Débito/crédito já vão criados com status 2 direto — não têm mais
            // nada pra esperar. PIX fica em 1, visível para conferência no
            // dashboard, até webhook/conciliação comprovarem o recebimento.
            // Criar uma cobrança ou obter seu QR não comprova pagamento.
            status: formaPagamento === "pix" ? 1 : 2,
            status_interno: "recebido",
            nome_destinatario: nomeLimpo,
            telefone_destinatario: telefone,
            valor_itens: subtotalTx,
            valor_desconto: descontoCalc,
            valor_taxa: valorTaxa,
            valor_taxa_cartao: valorTaxaCartaoCalc,
            valor_venda: totalCalc,
            descricao_item: descricaoItemTx,
            quantidade_item: quantidadeItemTx,
            valor_total_item: valorTotalItemTx,
            // Paralelo a descricao_item/quantidade_item — permite "repetir
            // último pedido" recarregar o carrinho por ID em vez de casar
            // pelo nome do produto (que pode mudar ou ser removido).
            produto_id_item: produtoIdItemTx,
            forma_pagamento: [CODIGO_PAGAMENTO[formaPagamento]],
            clienteUid: uid,
            checkout_idempotency_key: idempotencyKey,
            checkout_payload_hash: payloadHash,
            // Nº sequencial de pedidos DESTE cliente — gravado no próprio
            // pedido (não só no perfil) pra sobreviver a um refresh da tela
            // de confirmação sem precisar reconsultar o perfil.
            numero_pedido_cliente: numeroPedidoCliente,
            // Só informativo pra equipe — quanto tempo de preparo entrou na
            // conta da antecedência mínima deste pedido específico.
            tempo_preparo_minutos: tempoPreparoTotal,
            cupomAplicado: codigoCupom,
            observacoes: String(observacoes || "").slice(0, 500),
            // Campo explícito — antes o tipo de entrega só era inferido no painel
            // (e em vários lugares diferentes) pela presença de bairro/cep/taxa.
            // Pedidos vindos do InstaDelivery (webhookPedidos) continuam sem esse
            // campo; a heurística de ehDelivery segue como fallback pra eles.
            tipo_entrega: tipoEntrega,
            // Marca explícita de origem — pedidos do InstaDelivery (webhookPedidos)
            // continuam sem esse campo. Usado pelo painel pra mostrar o badge "App"
            // e liberar o modal de editar itens/reimprimir.
            origem: "app",
            // Mesmo campo/formato que o painel já usa pra pedidos agendados
            // (ver parseAgendamentoDate) — todo pedido do app cliente é agendado.
            agendamento: agendamentoTexto,
            ...(formaPagamento === "pix"
              ? {
                  pix_confirmado: false,
                  pix_status: "CREATING",
                  pix_cpf_cnpj: cpfLimpo,
                  pix_asaas_customer_id: clienteDados.asaasCustomerId || null,
                  pix_checkout_pendente: true,
                  pix_checkout_tentativas: 0,
                  pix_checkout_idempotency_key: idempotencyKey,
                  pix_checkout_proxima_tentativa_em: timestampDaqui(INTERVALO_RECUPERACAO_PIX_MS),
                }
              : {}),
            ...enderecoCampos,
          });

          const resultado = {
            orderId,
            pix: null,
            numeroPedidoCliente,
          };
          tx.set(idempotencyRef, formaPagamento === "pix"
            ? {
                pedidoPersistidoEm: admin.firestore.FieldValue.serverTimestamp(),
                atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
              }
            : {
                estado: "concluido",
                resultado,
                concluidoEm: admin.firestore.FieldValue.serverTimestamp(),
                atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
                leaseAte: admin.firestore.FieldValue.delete(),
              }, { merge: true });

          return {
            desconto: descontoCalc,
            total: totalCalc,
            descricaoItem: descricaoItemTx,
            quantidadeItem: quantidadeItemTx,
            valorTotalItem: valorTotalItemTx,
            subtotal: subtotalTx,
            numeroPedidoCliente,
          };
        });

      if (formaPagamento === "pix") {
        return await processarPixPendente({ pedidoRef, idempotencyRef });
      }

      // Para cartão, pedido, perfil e resultado idempotente já foram gravados
      // juntos na transação. Mesmo que esta resposta se perca, a repetição lê
      // exatamente este resultado e não cria um segundo pedido.
      return { orderId, pix: null, numeroPedidoCliente };
    } catch (erro) {
      let pedidoNoErro = null;
      try {
        const snap = await pedidoRef.get();
        pedidoNoErro = snap.exists ? snap.data() : null;
      } catch {
        // A indisponibilidade do Firestore não pode esconder o erro original.
      }

      const resultadoSalvo = resultadoDoPedidoPersistido(orderId, pedidoNoErro);
      if (resultadoSalvo) {
        await concluirIdempotencia(idempotencyRef, resultadoSalvo, {
          uid: pedidoNoErro.clienteUid,
          pedidoId: orderId,
          payloadHash: pedidoNoErro.checkout_payload_hash,
        });
        return resultadoSalvo;
      }

      if (pedidoNoErro?.pix_checkout_pendente === true) {
        if (erro?.code === "already-exists") {
          throw new HttpsError(
            "unavailable",
            "O PIX deste pedido já está sendo recuperado. Aguarde alguns segundos e tente novamente."
          );
        }
        const semCobrancaConhecida = !pedidoNoErro.pix_pagamento_id;
        if (semCobrancaConhecida && erroAsaasEhDefinitivo(erro)) {
          await desfazerPedidoPix({ pedidoRef, idempotencyRef });
          const motivoAsaas = erro.response?.data?.errors?.[0]?.description;
          throw new HttpsError(
            "invalid-argument",
            motivoAsaas
              ? `Não foi possível gerar o PIX: ${motivoAsaas}`
              : "Não foi possível gerar o PIX com os dados informados."
          );
        }

        await marcarPixParaRecuperacao({ pedidoRef, idempotencyRef, erro });
        console.error(
          `[criarPedido] PIX ${orderId} ficou pendente de recuperação:`,
          mensagemErro(erro)
        );
        throw new HttpsError(
          "unavailable",
          "O pedido foi recebido, mas o PIX ainda está sendo recuperado. Aguarde alguns segundos e tente novamente; nenhum pedido novo será criado."
        );
      }

      await idempotencyRef.set({
        estado: "falhou",
        ultimoErro: mensagemErro(erro),
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        leaseAte: admin.firestore.FieldValue.delete(),
      }, { merge: true }).catch(() => {
        // Falha ao marcar não pode mascarar o erro original abaixo.
      });
      throw erro;
    }
  }
);

const consultarCheckoutPedido = onCall(
  {
    region: "southamerica-east1",
    enforceAppCheck: true,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Faça login para consultar o pedido.");
    }
    const idempotencyKey = String(request.data?.idempotencyKey || "");
    if (idempotencyKey.length < 10) {
      throw new HttpsError("invalid-argument", "Tentativa de pedido inválida.");
    }

    const idempotencyRef = db().collection("_idempotency").doc(idempotencyKey);
    const idempotencySnap = await idempotencyRef.get();
    if (!idempotencySnap.exists) {
      const pedidosDaChave = await db().collection("pedidos")
        .where("checkout_idempotency_key", "==", idempotencyKey)
        .limit(2)
        .get();
      if (pedidosDaChave.size === 0) return { estado: "nao_encontrado" };
      if (pedidosDaChave.size > 1) {
        throw new HttpsError(
          "failed-precondition",
          "Há mais de um pedido para esta tentativa. A equipe precisa conferir."
        );
      }
      const pedidoDoc = pedidosDaChave.docs[0];
      const pedido = pedidoDoc.data();
      if (pedido.clienteUid !== request.auth.uid) {
        throw new HttpsError("permission-denied", "O pedido pertence a outra sessão.");
      }
      const resultado = resultadoDoPedidoPersistido(pedidoDoc.id, pedido);
      if (resultado) {
        await concluirIdempotencia(idempotencyRef, resultado, {
          uid: pedido.clienteUid,
          pedidoId: pedidoDoc.id,
          payloadHash: pedido.checkout_payload_hash,
        });
        return { estado: "concluido", resultado };
      }
      return {
        estado: pedido.pix_checkout_pendente === true ? "recuperando_pix" : "processando",
        pedidoId: pedidoDoc.id,
      };
    }

    const registro = idempotencySnap.data();
    if (registro.uid && registro.uid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "Esta tentativa pertence a outra sessão.");
    }
    if (registro.estado === "concluido" && registro.resultado) {
      return { estado: "concluido", resultado: registro.resultado };
    }

    const pedidoId = String(registro.pedidoId || "");
    if (pedidoId) {
      const pedidoSnap = await db().collection("pedidos").doc(pedidoId).get();
      if (pedidoSnap.exists) {
        const pedido = pedidoSnap.data();
        if (pedido.clienteUid !== request.auth.uid) {
          throw new HttpsError("permission-denied", "O pedido pertence a outra sessão.");
        }
        const resultado = resultadoDoPedidoPersistido(pedidoId, pedido);
        if (resultado) {
          await concluirIdempotencia(idempotencyRef, resultado, {
            uid: pedido.clienteUid,
            pedidoId,
            payloadHash: pedido.checkout_payload_hash,
          });
          return { estado: "concluido", resultado };
        }
        if (pedido.pix_checkout_pendente === true) {
          return { estado: "recuperando_pix", pedidoId };
        }
        return { estado: "processando", pedidoId };
      }
    }

    if (registro.estado === "falhou") return { estado: "falhou" };
    return { estado: "processando", pedidoId: pedidoId || null };
  }
);

async function reconciliarCheckoutPixDoc(pedidoDoc) {
  const pedido = pedidoDoc.data();
  const idempotencyKey = pedido.pix_checkout_idempotency_key || pedido.checkout_idempotency_key;
  if (!idempotencyKey) {
    await pedidoDoc.ref.set({
      pix_checkout_pendente: false,
      pix_checkout_ultimo_erro: "Pedido PIX pendente sem chave de recuperação.",
      pix_checkout_proxima_tentativa_em: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    await db().collection("pendencias").doc(`checkout_pix_${pedidoDoc.id}`).set({
      chatId: "sistema",
      tipo: "checkout_pix_sem_chave",
      descricao: `Pedido #${pedidoDoc.id} está sem a chave necessária para recuperar o PIX.`,
      pedidoId: pedidoDoc.id,
      resolvida: false,
      criadaEm: dataHoraAtualSP(),
      criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return;
  }

  const idempotencyRef = db().collection("_idempotency").doc(String(idempotencyKey));
  try {
    await processarPixPendente({
      pedidoRef: pedidoDoc.ref,
      idempotencyRef,
    });
  } catch (erro) {
    if (erro?.code === "already-exists") return;

    const snapAtual = await pedidoDoc.ref.get();
    if (!snapAtual.exists || snapAtual.data().pix_checkout_pendente !== true) return;
    const atual = snapAtual.data();

    if (!atual.pix_pagamento_id && erroAsaasEhDefinitivo(erro)) {
      await desfazerPedidoPix({ pedidoRef: pedidoDoc.ref, idempotencyRef });
      return;
    }

    await marcarPixParaRecuperacao({
      pedidoRef: pedidoDoc.ref,
      idempotencyRef,
      erro,
    });

    const depoisDaFalha = await pedidoDoc.ref.get();
    const tentativas = Number(depoisDaFalha.data()?.pix_checkout_tentativas || 0);
    if (tentativas >= 5) {
      await db().collection("pendencias").doc(`checkout_pix_${pedidoDoc.id}`).set({
        chatId: "sistema",
        tipo: "checkout_pix_recuperacao",
        descricao:
          `O PIX do pedido #${pedidoDoc.id} ainda não pôde ser recuperado após ${tentativas} tentativas.`,
        detalhes: { ultimoErro: mensagemErro(erro) },
        pedidoId: pedidoDoc.id,
        resolvida: false,
        criadaEm: dataHoraAtualSP(),
        criadaEmTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    console.error(
      `[reconciliarCheckoutsPix] Falha no pedido ${pedidoDoc.id}:`,
      mensagemErro(erro)
    );
  }
}

const reconciliarCheckoutsPix = onSchedule(
  {
    schedule: "every 2 minutes",
    timeZone: "America/Sao_Paulo",
    secrets: [ASAAS_API_KEY_ESCRITA],
    memory: "256MiB",
    cpu: 1,
    timeoutSeconds: 180,
  },
  async () => {
    const snapshot = await db().collection("pedidos")
      .where("pix_checkout_pendente", "==", true)
      .limit(50)
      .get();
    const agora = Date.now();
    const devidos = snapshot.docs.filter((doc) => {
      const proxima = doc.data().pix_checkout_proxima_tentativa_em?.toMillis?.() || 0;
      return proxima <= agora;
    });

    for (const pedidoDoc of devidos) {
      await reconciliarCheckoutPixDoc(pedidoDoc);
    }
  }
);

module.exports = { criarPedido, consultarCheckoutPedido, reconciliarCheckoutsPix };
