// Prévia de transporte restrito. Nenhum listener de pedidos ou despacho foi ativado.
// Trabalhos serão produzidos pelo backend; nunca aceitar um recibo criado pelo robô.
const { autenticarDispositivo, autorizarCadastro, COLECAO_DISPOSITIVOS } = require("./acessoDispositivo");
const COLECAO_TRABALHOS = "trabalhos_impressao";
const ID_TRABALHO = /^[A-Za-z0-9_-]{1,128}$/;

function texto(valor, limite, obrigatorio = false) {
  if (valor === undefined && !obrigatorio) return "";
  if (typeof valor !== "string" || valor.length > limite || obrigatorio && !valor.trim()) throw new Error("RECIBO_INVALIDO");
  // Texto do cliente não pode injetar comandos ESC/POS no futuro renderizador.
  return valor.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

function projetarRecibo(recibo) {
  if (recibo?.versao !== 1 || !["delivery", "retirada"].includes(recibo.tipo) ||
      !ID_TRABALHO.test(recibo.pedidoId || "") || !Array.isArray(recibo.itens) ||
      !recibo.itens.length || recibo.itens.length > 100 ||
      !Number.isSafeInteger(recibo.totalCentavos) || recibo.totalCentavos < 0 ||
      typeof recibo.pago !== "boolean") throw new Error("RECIBO_INVALIDO");
  const resultado = {
    versao: 1, pedidoId: recibo.pedidoId, tipo: recibo.tipo,
    nome: texto(recibo.nome, 160, true), horarioAgendado: texto(recibo.horarioAgendado, 80, true),
    pagamento: texto(recibo.pagamento, 80, true), pago: recibo.pago, totalCentavos: recibo.totalCentavos,
    observacoes: texto(recibo.observacoes, 1000),
    itens: recibo.itens.map((item) => {
      if (!Number.isSafeInteger(item?.quantidade) || item.quantidade < 1 || item.quantidade > 100000) throw new Error("RECIBO_INVALIDO");
      return { nome: texto(item.nome, 160, true), quantidade: item.quantidade, observacoes: texto(item.observacoes, 500) };
    }),
  };
  if (recibo.tipo === "delivery") {
    resultado.entrega = {
      endereco: texto(recibo.entrega?.endereco, 240, true), bairro: texto(recibo.entrega?.bairro, 120, true),
      complemento: texto(recibo.entrega?.complemento, 240), referencia: texto(recibo.entrega?.referencia, 240),
      contato: texto(recibo.entrega?.contato, 30),
    };
  }
  if (Buffer.byteLength(JSON.stringify(resultado), "utf8") > 32 * 1024) throw new Error("RECIBO_INVALIDO");
  return resultado;
}

function validarComando(dados) {
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) return false;
  const campos = dados.action === "consultarTrabalho" ? ["action", "trabalhoId"]
    : dados.action === "registrarPresenca" ? ["action", "versaoApp"] : null;
  if (!campos || Object.keys(dados).some((k) => !campos.includes(k))) return false;
  return dados.action === "consultarTrabalho"
    ? typeof dados.trabalhoId === "string" && ID_TRABALHO.test(dados.trabalhoId)
    : typeof dados.versaoApp === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(dados.versaoApp);
}

async function executarConsulta({ db, FieldValue, identidade, dados, agoraMs = Date.now() }) {
  const dispositivoRef = db.collection(COLECAO_DISPOSITIVOS).doc(identidade.uid);
  return db.runTransaction(async (tx) => {
    // Revalida dentro da transação: revogação/rotação concorrente não pode ser ignorada.
    const [cadastro, staff, config] = await Promise.all([
      tx.get(dispositivoRef), tx.get(db.collection("staff").doc(identidade.uid)),
      tx.get(db.collection("configuracoes").doc("impressao_api")),
    ]);
    const decisao = autorizarCadastro({ identidade, dispositivo: cadastro.data(), staffExiste: staff.exists,
      configuracao: config.data() });
    if (!decisao.ok) return decisao;
    if (dados.action === "registrarPresenca") {
      const ultima = cadastro.data().ultimaPresenca?.toMillis?.() || 0;
      if (ultima > agoraMs - 30000) return { ok: false, status: 429, codigo: "AGUARDE_PROXIMA_PRESENCA" };
      tx.update(dispositivoRef, { ultimaPresenca: FieldValue.serverTimestamp(), versaoApp: dados.versaoApp });
      return { ok: true, status: 200, corpo: { recebida: true } };
    }
    const snap = await tx.get(db.collection(COLECAO_TRABALHOS).doc(dados.trabalhoId));
    const job = snap.data();
    // Mesma resposta para inexistente, outro dono, cancelado e expirado.
    if (!snap.exists || job.dispositivoUid !== identidade.uid || job.credencialVersao !== identidade.credencialVersao ||
        job.estado !== "pendente" || !(job.expiraEm?.toMillis?.() > agoraMs)) {
      return { ok: false, status: 404, codigo: "TRABALHO_INDISPONIVEL" };
    }
    try {
      return { ok: true, status: 200, corpo: { trabalhoId: snap.id, recibo: projetarRecibo(job.recibo),
        autorizacaoDeImpressao: false } };
    } catch { return { ok: false, status: 409, codigo: "RECIBO_INDISPONIVEL" }; }
  });
}

// Handler sem onRequest/export no index: não existe endpoint em produção ainda.
// Consulta não é autorização de imprimir; reivindicação/envio/resultado serão outro recorte.
function criarHandlerConsultaImpressao({ db, auth, FieldValue }) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ codigo: "METODO_NAO_PERMITIDO" });
    if (req.rawBody?.length > 2048) return res.status(413).json({ codigo: "REQUISICAO_MUITO_GRANDE" });
    if (!validarComando(req.body)) return res.status(400).json({ codigo: "COMANDO_INVALIDO" });
    const sessao = await autenticarDispositivo({ authorization: req.headers?.authorization, auth, db });
    if (!sessao.ok) return res.status(sessao.status).json({ codigo: sessao.codigo });
    try {
      const resultado = await executarConsulta({ db, FieldValue, identidade: sessao.identidade, dados: req.body });
      return res.status(resultado.status).json(resultado.ok ? resultado.corpo : { codigo: resultado.codigo });
    } catch { return res.status(503).json({ codigo: "IMPRESSAO_TEMPORARIAMENTE_INDISPONIVEL" }); }
  };
}

module.exports = { COLECAO_TRABALHOS, validarComando, projetarRecibo, executarConsulta, criarHandlerConsultaImpressao };
