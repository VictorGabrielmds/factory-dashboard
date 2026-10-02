// ============================================================================
// SALVAR ENDEREÇO/PREFERÊNCIA DE ENTREGA — App Cliente
// clientes/{uid} é staff-only pra escrita nas regras (tem um campo de
// rate-limit de cupom que o cliente não pode resetar sozinho) — mesmo uma
// preferência sem risco de dinheiro precisa passar por Cloud Function.
// criarPedido também salva isso automaticamente a cada pedido concluído;
// esta function existe pra deixar salvar ANTES de qualquer pedido (ex.: a
// barra "Entregar em" no topo do cardápio).
// ============================================================================

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const db = () => admin.firestore();

const TIPO_ENTREGA_VALIDOS = ["retirada", "delivery"];

const salvarEnderecoCliente = onCall(
  {
    region: "southamerica-east1",
    enforceAppCheck: true,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Faça login para continuar.");
    }
    const { tipoEntrega, endereco } = request.data || {};
    if (!TIPO_ENTREGA_VALIDOS.includes(tipoEntrega)) {
      throw new HttpsError("invalid-argument", "Tipo de entrega inválido.");
    }

    const payload = { tipoEntregaPreferida: tipoEntrega };
    if (tipoEntrega === "delivery") {
      const enderecoSalvo = {
        cep: String(endereco?.cep || "").replace(/\D/g, ""),
        logradouro: String(endereco?.logradouro || "").trim().slice(0, 200),
        numero: String(endereco?.numero || "").trim().slice(0, 20),
        complemento: String(endereco?.complemento || "").trim().slice(0, 200),
        bairro: String(endereco?.bairro || "").trim().slice(0, 120),
        referencia: String(endereco?.referencia || "").trim().slice(0, 200),
      };
      if (!enderecoSalvo.logradouro || !enderecoSalvo.numero || !enderecoSalvo.bairro) {
        throw new HttpsError("invalid-argument", "Endereço incompleto.");
      }
      payload.enderecoSalvo = enderecoSalvo;
    }

    await db().collection("clientes").doc(request.auth.uid).set(payload, { merge: true });
    return { ok: true };
  }
);

// ============================================================================
// MÚLTIPLOS ENDEREÇOS SALVOS — lista em clientes/{uid}.enderecos
// Separado de enderecoSalvo (singular, acima) de propósito: aquele é a
// "preferência atual" usada pela barra "Entregar em" e pelo checkout rápido,
// já testado em produção — não mexi nele. Isso aqui é a lista nomeada
// ("Casa", "Trabalho"...) gerenciada na tela de perfil.
// ============================================================================

const MAX_ENDERECOS = 10;

function normalizarEndereco(bruto) {
  return {
    rotulo: String(bruto?.rotulo || "").trim().slice(0, 40) || "Endereço",
    cep: String(bruto?.cep || "").replace(/\D/g, ""),
    logradouro: String(bruto?.logradouro || "").trim().slice(0, 200),
    numero: String(bruto?.numero || "").trim().slice(0, 20),
    complemento: String(bruto?.complemento || "").trim().slice(0, 200),
    bairro: String(bruto?.bairro || "").trim().slice(0, 120),
    referencia: String(bruto?.referencia || "").trim().slice(0, 200),
  };
}

const salvarEndereco = onCall(
  { region: "southamerica-east1", enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Faça login para continuar.");
    }
    const { id } = request.data || {};
    const normalizado = normalizarEndereco(request.data);
    if (!normalizado.logradouro || !normalizado.numero || !normalizado.bairro) {
      throw new HttpsError("invalid-argument", "Endereço incompleto.");
    }

    const ref = db().collection("clientes").doc(request.auth.uid);
    const enderecoSalvo = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const atuais = Array.isArray(snap.data()?.enderecos) ? snap.data().enderecos : [];

      const idxExistente = id ? atuais.findIndex((e) => e.id === id) : -1;
      const idFinal = idxExistente >= 0 ? id : `end_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const registro = { id: idFinal, ...normalizado };

      let novaLista;
      if (idxExistente >= 0) {
        novaLista = [...atuais];
        novaLista[idxExistente] = registro;
      } else {
        if (atuais.length >= MAX_ENDERECOS) {
          throw new HttpsError("resource-exhausted", `Limite de ${MAX_ENDERECOS} endereços salvos atingido.`);
        }
        novaLista = [...atuais, registro];
      }

      tx.set(ref, { enderecos: novaLista }, { merge: true });
      return registro;
    });

    return { ok: true, endereco: enderecoSalvo };
  }
);

const removerEndereco = onCall(
  { region: "southamerica-east1", enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Faça login para continuar.");
    }
    const { id } = request.data || {};
    if (!id) throw new HttpsError("invalid-argument", "Falta o id do endereço.");

    const ref = db().collection("clientes").doc(request.auth.uid);
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const atuais = Array.isArray(snap.data()?.enderecos) ? snap.data().enderecos : [];
      tx.set(ref, { enderecos: atuais.filter((e) => e.id !== id) }, { merge: true });
    });

    return { ok: true };
  }
);

module.exports = { salvarEnderecoCliente, salvarEndereco, removerEndereco };
