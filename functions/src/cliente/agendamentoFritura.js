// ============================================================================
// SOLICITAÇÃO DE AGENDAMENTO DE FRITURA — App Cliente
//
// Este fluxo é separado do carrinho: o cliente escolhe apenas a data e deixa
// uma observação. A equipe recebe uma solicitação na agenda de frituras e
// confirma horário/local pelo painel.
// ============================================================================

const crypto = require("crypto");
const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

const db = () => admin.firestore();

const PRODUTO_ID = "agendamento_fritura";
const TIPO_PRODUTO = "agendamento_fritura";
const MAX_OBSERVACOES = 500;
const MAX_DIAS_ANTECEDENCIA = 366;

function formatarDataISOEmFortaleza(data = new Date()) {
  const partes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(data);
  const valor = (tipo) => partes.find((parte) => parte.type === tipo)?.value;
  return `${valor("year")}-${valor("month")}-${valor("day")}`;
}

function dataISOValida(valor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [ano, mes, dia] = valor.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return (
    data.getUTCFullYear() === ano &&
    data.getUTCMonth() === mes - 1 &&
    data.getUTCDate() === dia
  );
}

function somarDiasISO(valor, dias) {
  const [ano, mes, dia] = valor.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia + dias));
  return [
    data.getUTCFullYear(),
    String(data.getUTCMonth() + 1).padStart(2, "0"),
    String(data.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

const solicitarAgendamentoFritura = onCall(
  { region: "southamerica-east1", enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Faça login para solicitar uma fritura.");
    }

    const uid = request.auth.uid;
    const dataAlvo = String(request.data?.data || "");
    const observacoes = String(request.data?.observacoes || "").trim().slice(0, MAX_OBSERVACOES);
    const idempotencyKey = String(request.data?.idempotencyKey || "");

    if (!dataISOValida(dataAlvo)) {
      throw new HttpsError("invalid-argument", "Escolha uma data válida.");
    }
    const hoje = formatarDataISOEmFortaleza();
    if (dataAlvo < hoje) {
      throw new HttpsError("failed-precondition", "Escolha uma data de hoje em diante.");
    }
    if (dataAlvo > somarDiasISO(hoje, MAX_DIAS_ANTECEDENCIA)) {
      throw new HttpsError("failed-precondition", "Escolha uma data dentro dos próximos 12 meses.");
    }
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey)) {
      throw new HttpsError("invalid-argument", "Atualize a página e tente novamente.");
    }

    const chaveHash = crypto
      .createHash("sha256")
      .update(`${uid}:${idempotencyKey}`)
      .digest("hex");
    const idempotencyRef = db().collection("_idempotency_frituras").doc(chaveHash);
    const produtoRef = db().collection("produtos").doc(PRODUTO_ID);
    const clienteRef = db().collection("clientes").doc(uid);
    const solicitacaoRef = db().collection("frituras").doc();

    return db().runTransaction(async (tx) => {
      const [idempotencySnap, produtoSnap, clienteSnap] = await Promise.all([
        tx.get(idempotencyRef),
        tx.get(produtoRef),
        tx.get(clienteRef),
      ]);

      if (idempotencySnap.exists) {
        return idempotencySnap.data().resultado;
      }

      if (!produtoSnap.exists) {
        throw new HttpsError("failed-precondition", "O agendamento de fritura não está disponível.");
      }
      const produto = produtoSnap.data();
      if (
        produto.tipoSistema !== TIPO_PRODUTO ||
        produto.disponivel !== true ||
        produto.esgotado === true
      ) {
        throw new HttpsError("failed-precondition", "O agendamento de fritura não está disponível no momento.");
      }

      if (!clienteSnap.exists || !clienteSnap.data().telefone) {
        throw new HttpsError("failed-precondition", "Sessão inválida — faça login novamente.");
      }
      const cliente = clienteSnap.data();
      if (cliente.pedidosBloqueados === true) {
        throw new HttpsError(
          "failed-precondition",
          "Seu cadastro está impedido de enviar solicitações. Entre em contato com a loja."
        );
      }

      const resultado = {
        solicitacaoId: solicitacaoRef.id,
        data: dataAlvo,
        status: "solicitado",
      };

      tx.set(solicitacaoRef, {
        cliente: String(cliente.nome || cliente.telefone),
        clienteUid: uid,
        telefoneCliente: String(cliente.telefone),
        dataAlvo,
        horario: "",
        local: "",
        observacoes,
        status: "solicitado",
        origem: "app_cliente",
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(idempotencyRef, {
        uid,
        resultado,
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        expiraEm: admin.firestore.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      });

      return resultado;
    });
  }
);

module.exports = {
  solicitarAgendamentoFritura,
  dataISOValida,
  formatarDataISOEmFortaleza,
  somarDiasISO,
};
