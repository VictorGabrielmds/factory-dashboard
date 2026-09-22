// ============================================================================
// API — clientes (painel)
// Resumo agregado (faturamento, itens mais pedidos, recompra) calculado
// AQUI, no servidor — antes isso rodava no navegador: baixar o histórico
// inteiro de pedidos pro cliente e agregar na thread principal, travando a
// aba inteira em períodos maiores ("todo o período" chega a dezenas de
// milhares de documentos). O painel só recebe o resultado já pronto, um
// JSON pequeno, não os pedidos crus.
// ============================================================================

const { onRequest } = require("firebase-functions/v2/https");
const admin         = require("firebase-admin");

const { ORIGENS_PAINEL } = require("../config");
const { exigirPainel } = require("../lib/seguranca");
const { exigirCapacidadePainel } = require("../lib/permissoesPainel");
const { normalizarTelefone, variantesNumero, garantirNonoDigito } = require("../lib/util");

const db = () => admin.firestore();

const STATUS_CANCELADO = 4;
// "Todo o período" pode acumular muita gente de pedido único — corta um teto
// no payload de volta pro painel em vez de mandar uma lista sem fim.
const MAX_CLIENTES_UM_PEDIDO = 200;

function chaveTelefone(telefone) {
  const normalizado = normalizarTelefone(telefone);
  return normalizado ? garantirNonoDigito(normalizado) : null;
}

function clientePublico(telefone, dados = {}, conversa = {}) {
  return {
    telefone,
    nome: dados.nome || conversa.clientName || telefone,
    pedidosBloqueados: dados.pedidosBloqueados === true,
    bloqueadoEm: dados.pedidosBloqueadosEm || null,
  };
}

function parseValor(bruto) {
  if (typeof bruto === "number") return Number.isFinite(bruto) ? bruto : 0;
  if (!bruto) return 0;
  const n = parseFloat(String(bruto).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function calcularEstatisticas(pedidos) {
  // Cancelado não é venda de verdade — entraria distorcendo faturamento,
  // ticket médio e a própria contagem de pedidos por cliente.
  const validos = pedidos.filter((p) => Number(p.status) !== STATUS_CANCELADO);

  const porTelefone = new Map();
  const porItem = new Map();
  let faturamentoTotal = 0;

  for (const p of validos) {
    const valor = parseValor(p.valor_venda);
    faturamentoTotal += valor;

    const telefone = p.telefone_destinatario || "—";
    const existente = porTelefone.get(telefone);
    if (existente) {
      existente.totalPedidos += 1;
      existente.valorTotalGasto += valor;
      if (p.nome_destinatario) existente.nome = p.nome_destinatario; // fica com o nome mais recente
      if (p.data_venda < existente.primeiroPedidoEm) existente.primeiroPedidoEm = p.data_venda;
      if (p.data_venda > existente.ultimoPedidoEm) existente.ultimoPedidoEm = p.data_venda;
    } else {
      porTelefone.set(telefone, {
        telefone,
        nome: p.nome_destinatario || "Sem nome",
        totalPedidos: 1,
        valorTotalGasto: valor,
        primeiroPedidoEm: p.data_venda,
        ultimoPedidoEm: p.data_venda,
      });
    }

    const descricoes = p.descricao_item || [];
    descricoes.forEach((nomeItem, i) => {
      if (!nomeItem) return;
      const chave = String(nomeItem).trim().toUpperCase();
      const qtd = Number(p.quantidade_item?.[i]) || 0;
      const valorItem = Number(p.valor_total_item?.[i]) || 0;
      const atual = porItem.get(chave) || { nome: nomeItem, quantidade: 0, faturamento: 0, pedidos: new Set() };
      atual.quantidade += qtd;
      atual.faturamento += valorItem;
      atual.pedidos.add(String(p.order_id));
      porItem.set(chave, atual);
    });
  }

  const clientes = Array.from(porTelefone.values());
  const clientesRecorrentes = clientes.filter((c) => c.totalPedidos >= 2);
  const clientesUmPedidoArr = clientes.filter((c) => c.totalPedidos === 1);

  const rankingClientes = [...clientes]
    .sort((a, b) => b.totalPedidos - a.totalPedidos || b.valorTotalGasto - a.valorTotalGasto)
    .slice(0, 15);

  const listaClientesUmPedido = [...clientesUmPedidoArr]
    .sort((a, b) => (b.ultimoPedidoEm > a.ultimoPedidoEm ? 1 : b.ultimoPedidoEm < a.ultimoPedidoEm ? -1 : 0))
    .slice(0, MAX_CLIENTES_UM_PEDIDO);

  const itensMaisPedidos = Array.from(porItem.values())
    .map((i) => ({ nome: i.nome, quantidadeTotal: i.quantidade, faturamentoTotal: i.faturamento, pedidosCount: i.pedidos.size }))
    .sort((a, b) => b.quantidadeTotal - a.quantidadeTotal)
    .slice(0, 15);

  return {
    totalPedidosValidos: validos.length,
    faturamentoTotal,
    ticketMedio: validos.length > 0 ? faturamentoTotal / validos.length : 0,
    clientesUnicos: clientes.length,
    clientesRecorrentes: clientesRecorrentes.length,
    clientesUmPedido: clientesUmPedidoArr.length,
    clientesUmPedidoTruncado: clientesUmPedidoArr.length > MAX_CLIENTES_UM_PEDIDO,
    taxaRecompra: clientes.length > 0 ? (clientesRecorrentes.length / clientes.length) * 100 : 0,
    rankingClientes,
    listaClientesUmPedido,
    itensMaisPedidos,
  };
}

const acoesClientes = {
  async resumo({ inicio, fim }, res) {
    if (typeof inicio !== "string" || typeof fim !== "string") {
      return res.status(400).json({ error: "Período inválido" });
    }

    const snap = await db().collection("pedidos")
      .where("data_venda", ">=", inicio)
      .where("data_venda", "<=", fim)
      .get();

    const pedidos = snap.docs.map((d) => ({ order_id: d.id, ...d.data() }));
    const dados = calcularEstatisticas(pedidos);
    return res.status(200).json({ success: true, dados });
  },

  async buscar({ termo }, res) {
    const busca = String(termo || "").trim().toLowerCase();
    if (busca.length < 3) {
      return res.status(400).json({ error: "Digite pelo menos 3 caracteres" });
    }
    const buscaNumeros = busca.replace(/\D/g, "");

    const [clientesSnap, conversasSnap] = await Promise.all([
      db().collection("clientes").get(),
      db().collection("conversas").get(),
    ]);

    const perfisPorTelefone = new Map();
    for (const documento of clientesSnap.docs) {
      const dados = documento.data();
      const chave = chaveTelefone(dados.telefone || documento.id.replace(/^cliente_/, ""));
      if (!chave) continue;
      const atual = perfisPorTelefone.get(chave);
      if (!atual || dados.pedidosBloqueados === true) {
        perfisPorTelefone.set(chave, dados);
      }
    }

    const resultados = new Map();
    for (const documento of conversasSnap.docs) {
      const conversa = documento.data();
      const telefone = normalizarTelefone(conversa.phone || documento.id);
      const chave = chaveTelefone(telefone);
      if (!telefone || !chave) continue;

      const nome = String(conversa.clientName || "");
      const corresponde =
        nome.toLowerCase().includes(busca) ||
        (buscaNumeros.length >= 3 && telefone.includes(buscaNumeros));
      if (!corresponde) continue;

      resultados.set(
        chave,
        clientePublico(telefone, perfisPorTelefone.get(chave), conversa)
      );
    }

    for (const [chave, dados] of perfisPorTelefone.entries()) {
      const telefone = normalizarTelefone(dados.telefone || chave);
      if (!telefone) continue;
      const nome = String(dados.nome || "");
      const corresponde =
        nome.toLowerCase().includes(busca) ||
        (buscaNumeros.length >= 3 && telefone.includes(buscaNumeros));
      if (!corresponde) continue;

      const atual = resultados.get(chave);
      resultados.set(chave, {
        ...clientePublico(telefone, dados),
        ...(atual ? { nome: atual.nome || dados.nome || telefone } : {}),
      });
    }

    const lista = Array.from(resultados.values())
      .sort((a, b) =>
        Number(b.pedidosBloqueados) - Number(a.pedidosBloqueados) ||
        a.nome.localeCompare(b.nome, "pt-BR")
      )
      .slice(0, 30);

    return res.status(200).json({ success: true, clientes: lista });
  },

  async listarBloqueados(_dados, res) {
    const clientesSnap = await db().collection("clientes")
      .where("pedidosBloqueados", "==", true)
      .limit(200)
      .get();

    const unicos = new Map();
    for (const documento of clientesSnap.docs) {
      const dados = documento.data();
      const telefone = normalizarTelefone(dados.telefone || documento.id.replace(/^cliente_/, ""));
      const chave = chaveTelefone(telefone);
      if (!telefone || !chave) continue;
      unicos.set(chave, clientePublico(telefone, dados));
    }

    const clientes = Array.from(unicos.values())
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    return res.status(200).json({ success: true, clientes });
  },

  async definirBloqueio({ telefone, nome, bloqueado }, res, operador, decisaoPermissao) {
    const telefoneNormalizado = normalizarTelefone(telefone);
    if (!telefoneNormalizado || typeof bloqueado !== "boolean") {
      return res.status(400).json({ error: "Dados inválidos" });
    }

    const nomeSeguro = String(nome || "").trim().slice(0, 120);
    const variantes = Array.from(variantesNumero(telefoneNormalizado));
    const canonico = garantirNonoDigito(telefoneNormalizado);
    const clienteRefs = variantes.map((numero) =>
      db().collection("clientes").doc(`cliente_${numero}`)
    );
    const conversaRefs = variantes.map((numero) =>
      db().collection("conversas").doc(numero)
    );
    const auditoriaRef = db().collection("auditorias_operacao").doc();

    await db().runTransaction(async (tx) => {
      const clienteSnaps = [];
      for (const ref of clienteRefs) clienteSnaps.push(await tx.get(ref));
      const conversaSnaps = [];
      for (const ref of conversaRefs) conversaSnaps.push(await tx.get(ref));

      const existentes = clienteSnaps.filter((snap) => snap.exists).map((snap) => snap.ref);
      const alvosCliente = existentes.length > 0
        ? existentes
        : [db().collection("clientes").doc(`cliente_${canonico}`)];

      const agora = admin.firestore.FieldValue.serverTimestamp();
      const payloadCliente = {
        telefone: canonico,
        pedidosBloqueados: bloqueado,
        pedidosBloqueadosEm: bloqueado ? agora : null,
        pedidosBloqueadosPor: bloqueado ? "painel" : null,
        ...(nomeSeguro ? { nome: nomeSeguro } : {}),
      };
      const payloadConversa = {
        pedidosBloqueados: bloqueado,
        pedidosBloqueadosEm: bloqueado ? agora : null,
      };

      for (const ref of alvosCliente) tx.set(ref, payloadCliente, { merge: true });
      for (const snap of conversaSnaps) {
        if (snap.exists) tx.set(snap.ref, payloadConversa, { merge: true });
      }
      tx.set(auditoriaRef, {
        acao: bloqueado ? "cliente_bloqueado" : "cliente_liberado",
        clienteTelefone: canonico,
        nomeCliente: nomeSeguro || null,
        operador: {
          uid: operador.uid,
          email: operador.email,
          nome: operador.nome,
          papel: operador.papel,
        },
        autorizacao: decisaoPermissao,
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.status(200).json({
      success: true,
      telefone: canonico,
      pedidosBloqueados: bloqueado,
    });
  },
};

const clientes = onRequest(
  // memory/timeout maiores que o padrão do painel — "todo o período" pode
  // envolver dezenas de milhares de leituras antes de responder.
  // Lista vazia explícita remove o segredo legado da configuração publicada.
  { cors: ORIGENS_PAINEL, secrets: [], memory: "1GiB", cpu: 1, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Método não permitido");
    const operador = await exigirPainel(req, res);
    if (!operador) return;

    const { action } = req.body;
    const handler = acoesClientes[action];
    if (!handler) return res.status(400).json({ error: `Action desconhecida: ${action}` });

    const decisaoPermissao = action === "definirBloqueio"
      ? exigirCapacidadePainel(res, operador, "clientes.bloquear")
      : null;
    if (action === "definirBloqueio" && !decisaoPermissao) return;

    try {
      return await handler(req.body, res, operador, decisaoPermissao);
    } catch (error) {
      console.error(`[clientes/${action}] Erro:`, error.message);
      return res.status(500).json({ error: "Erro interno" });
    }
  }
);

module.exports = { clientes };
