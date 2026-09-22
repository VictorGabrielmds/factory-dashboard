const { CNPJ_EMITENTE, ErroFiscal } = require("./modelo");
const BASE = "https://api.eficiencia.app/api/vendas/v1";

// This adapter intentionally exposes GET only. Do not reuse the generic HTTP
// retry helper: retrying an authorization after timeout can duplicate a note.
function criarConsultaEficiencia({ token, fetchImpl = fetch, timeoutMs = 15000 }) {
  return async function testarConexao() {
    if (typeof token !== "string" || !/^[A-Za-z0-9._~+\/|=-]{20,8192}$/.test(token)) {
      throw new ErroFiscal("TOKEN_FISCAL_INVALIDO", "O token fiscal não está configurado corretamente no servidor.", 503);
    }
    const url = `${BASE}/venda/contingencia/listar?cadastro_nacional=${CNPJ_EMITENTE}&origem=api`;
    let resposta;
    try {
      resposta = await fetchImpl(url, { method: "GET", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ErroFiscal("EF_SEM_RESPOSTA", "A Eficiência Fiscal não respondeu a tempo. Nenhuma emissão foi solicitada.", 503);
    }
    if (!resposta.ok) {
      await resposta.body?.cancel().catch(() => {});
      const negada = [400, 401, 403].includes(resposta.status);
      throw new ErroFiscal(negada ? "EF_ACESSO_RECUSADO" : "EF_INDISPONIVEL",
        negada ? "A Eficiência Fiscal recusou a consulta. Confira o token e a autorização do CNPJ."
          : "A Eficiência Fiscal está indisponível para consulta. Tente novamente mais tarde.", 503);
    }
    try {
      const leitor = resposta.body.getReader();
      const partes = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await leitor.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024 * 1024) throw new Error("resposta_grande");
          partes.push(Buffer.from(value));
        }
      } finally { await leitor.cancel().catch(() => {}); }
      const dados = JSON.parse(Buffer.concat(partes).toString("utf8"));
      if (!Array.isArray(dados.contingencias)) throw new Error("contrato_invalido");
    } catch {
      throw new ErroFiscal("EF_RESPOSTA_INVALIDA", "A consulta retornou um formato inesperado. A emissão permanece desativada.", 503);
    }
    return { estado: "ok", mensagem: "Credencial e autorização válidas para consulta.", operacao: "consulta_contingencias" };
  };
}

module.exports = { criarConsultaEficiencia };
