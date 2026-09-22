import { auth } from "./firebase";

export type VinculoFiscal = {
  codigoProduto: string; nomeEf: string; revisado: boolean; nomeProdutoNaRevisao: string;
  observacao: string; revisao: string; revisadoEm: string | null;
};
export type ProdutoFiscal = {
  id: string; nome: string; categoria: string; especial: boolean; disponivel: boolean;
  vinculo: VinculoFiscal | null;
};
export type ConexaoFiscal = {
  estado: "ok" | "falha" | "testando"; mensagem: string;
  verificadoEm: string | null; proximaTentativaEm: string | null;
};
export type ConferenciaFiscal = {
  estado: "pendencias" | "conferido"; emissaoHabilitada: false; fonteHash: string;
  atualizadoEm: string; criadoEm: string;
  snapshot: {
    pedidoId: string; cliente: string; criadoEm: string; agendamento: string; tipoEntrega: string;
    referenciaExterna: string; formaPagamento: string; pagamento: string;
    itens: { produtoId: string | null; descricao: string; quantidade: number | null;
      totalCentavos: number | null; codigoProduto: string | null; nomeEf: string }[];
    resumo: { itensCentavos: number | null; descontoCentavos: number | null;
      entregaCentavos: number | null; taxaCartaoCentavos: number | null; totalCentavos: number | null };
  };
  pendencias: { codigo: string; mensagem: string; item: number | null }[];
  avisos: string[];
};
export type ResumoFiscal = {
  emissaoHabilitada: false; cnpj: string; etapasPendentes: string[]; produtos: ProdutoFiscal[];
  catalogoLimitado: boolean; conexao: ConexaoFiscal | null;
  conferencias: { pedidoId: string; cliente: string; estado: string; pendencias: number; atualizadoEm: string }[];
};
export type FiscalRequest = <T>(acao: string, dados?: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;

const FISCAL_URL = "https://southamerica-east1-entregas-781a8.cloudfunctions.net/fiscal";

// Separate from apiFetch: no public panel API key and no automatic retry of
// fiscal operations. Only the signed-in staff member's Firebase ID token.
export const fiscalRequest: FiscalRequest = async <T>(acao: string, dados = {}, signal?: AbortSignal): Promise<T> => {
  const usuario = auth.currentUser;
  if (!usuario) throw new Error("Entre novamente no painel para acessar o módulo fiscal.");
  const token = await usuario.getIdToken();
  const controller = new AbortController();
  const abortar = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abortar, { once: true });
  const timer = setTimeout(abortar, 30000);
  try {
    const resposta = await fetch(FISCAL_URL, {
      method: "POST", credentials: "omit", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...dados, acao }),
    });
    const corpo = await resposta.json().catch(() => null);
    if (!resposta.ok) {
      throw new Error(corpo?.error || (resposta.status === 404
        ? "O módulo fiscal ainda não foi publicado no servidor. É necessário publicar a função fiscal."
        : "Não foi possível acessar o módulo fiscal."));
    }
    if (!corpo || typeof corpo !== "object") throw new Error("O servidor retornou uma resposta fiscal inesperada.");
    return corpo as T;
  } catch (erro) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error("O servidor não respondeu a tempo. Se estava salvando, atualize a tela para conferir o resultado antes de tentar novamente.");
    }
    throw erro;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortar);
  }
};
