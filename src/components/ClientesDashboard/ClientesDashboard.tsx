// src/components/ClientesDashboard/ClientesDashboard.tsx
import { useCallback, useEffect, useState } from "react";
import "./ClientesDashboard.css";
import { apiFetch, BASE_URL } from "../../services/api";
import { dateToISOString, toTitleCase } from "../../utils/dateUtils";
import { formatarMoeda, type EstatisticasClientes } from "./clientesHelpers";
import {
  MdRefresh,
  MdPeople,
  MdPersonAddAlt,
  MdRepeat,
  MdPayments,
  MdReceiptLong,
  MdExpandMore,
  MdExpandLess,
} from "react-icons/md";

type FiltroPeriodo = "7d" | "30d" | "90d" | "mes" | "tudo";

const OPCOES_PERIODO: { valor: FiltroPeriodo; rotulo: string }[] = [
  { valor: "7d", rotulo: "7 dias" },
  { valor: "30d", rotulo: "30 dias" },
  { valor: "90d", rotulo: "90 dias" },
  { valor: "mes", rotulo: "Este mês" },
  { valor: "tudo", rotulo: "Todo o período" },
];

// Pedidos existem desde antes dessa tela — não há necessidade de ir mais
// longe do que isso pra cobrir "todo o período" na prática.
const INICIO_DOS_TEMPOS = new Date(2023, 0, 1);

function calcularIntervalo(filtro: FiltroPeriodo): { inicio: Date; fim: Date } {
  const hoje = new Date();
  const fim = new Date(hoje);
  fim.setHours(23, 59, 59, 999);

  if (filtro === "tudo") {
    return { inicio: INICIO_DOS_TEMPOS, fim };
  }

  const inicio = new Date(hoje);
  if (filtro === "7d") inicio.setDate(inicio.getDate() - 6);
  else if (filtro === "30d") inicio.setDate(inicio.getDate() - 29);
  else if (filtro === "90d") inicio.setDate(inicio.getDate() - 89);
  else if (filtro === "mes") inicio.setDate(1);
  inicio.setHours(0, 0, 0, 0);
  return { inicio, fim };
}

const ClientesDashboard = () => {
  const [filtro, setFiltro] = useState<FiltroPeriodo>("30d");
  const [stats, setStats] = useState<EstatisticasClientes | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);
  const [mostrarUmPedido, setMostrarUmPedido] = useState(false);

  // A agregação roda no servidor (functions/src/api/clientes.js) — baixar o
  // histórico inteiro de pedidos pro navegador e somar ali travava a aba
  // inteira em períodos maiores ("todo o período" chegava a dezenas de
  // milhares de documentos). Aqui só chega o resultado já pronto.
  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const { inicio, fim } = calcularIntervalo(filtro);
      const inicioStr = `${dateToISOString(inicio)} 00:00:00`;
      const fimStr = `${dateToISOString(fim)} 23:59:59`;

      const resp = await apiFetch(`${BASE_URL}/clientes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resumo", inicio: inicioStr, fim: fimStr }),
      });
      if (!resp.ok) {
        const dados = await resp.json().catch(() => null) as { error?: string } | null;
        throw new Error(dados?.error || `Falha ao calcular o resumo (HTTP ${resp.status})`);
      }
      const { dados } = (await resp.json()) as { dados: EstatisticasClientes };
      setStats(dados);
      setAtualizadoEm(new Date());
    } catch (err) {
      console.error("Erro ao carregar resumo de clientes:", err);
      setErro(err instanceof Error ? err.message : "Não foi possível carregar os dados. Tente atualizar de novo.");
    } finally {
      setCarregando(false);
    }
  }, [filtro]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const pctRecorrentes = stats && stats.clientesUnicos > 0 ? Math.round((stats.clientesRecorrentes / stats.clientesUnicos) * 100) : 0;
  const pctUmPedido = 100 - pctRecorrentes;

  return (
    <div className="clientes-dashboard">
      <div className="clientes-toolbar">
        <div className="clientes-periodos" role="tablist" aria-label="Período do resumo">
          {OPCOES_PERIODO.map((op) => (
            <button
              key={op.valor}
              className={filtro === op.valor ? "active" : ""}
              onClick={() => setFiltro(op.valor)}
            >
              {op.rotulo}
            </button>
          ))}
        </div>
        <div className="clientes-toolbar-direita">
          {atualizadoEm && !carregando && (
            <span className="clientes-atualizado-em">
              Atualizado às {atualizadoEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button type="button" className="clientes-refresh-btn" onClick={carregar} disabled={carregando}>
            <MdRefresh size={16} className={carregando ? "girando" : ""} /> Atualizar
          </button>
        </div>
      </div>

      {erro && <div className="clientes-erro">{erro}</div>}

      {carregando ? (
        <div className="clientes-carregando">
          <div className="spinner" />
          <p>Calculando o resumo do período…</p>
        </div>
      ) : stats ? (
        <>
          <div className="clientes-kpi-grid">
            <div className="clientes-kpi-card">
              <MdReceiptLong size={20} aria-hidden="true" />
              <span className="clientes-kpi-label">Pedidos válidos</span>
              <strong className="clientes-kpi-valor">{stats.totalPedidosValidos}</strong>
            </div>
            <div className="clientes-kpi-card">
              <MdPayments size={20} aria-hidden="true" />
              <span className="clientes-kpi-label">Faturamento</span>
              <strong className="clientes-kpi-valor">{formatarMoeda(stats.faturamentoTotal)}</strong>
            </div>
            <div className="clientes-kpi-card">
              <MdPayments size={20} aria-hidden="true" />
              <span className="clientes-kpi-label">Ticket médio</span>
              <strong className="clientes-kpi-valor">{formatarMoeda(stats.ticketMedio)}</strong>
            </div>
            <div className="clientes-kpi-card">
              <MdPeople size={20} aria-hidden="true" />
              <span className="clientes-kpi-label">Clientes únicos</span>
              <strong className="clientes-kpi-valor">{stats.clientesUnicos}</strong>
            </div>
            <div className="clientes-kpi-card destaque">
              <MdRepeat size={20} aria-hidden="true" />
              <span className="clientes-kpi-label">Taxa de recompra</span>
              <strong className="clientes-kpi-valor">{stats.taxaRecompra.toFixed(0)}%</strong>
            </div>
            <div className="clientes-kpi-card">
              <MdPersonAddAlt size={20} aria-hidden="true" />
              <span className="clientes-kpi-label">Pediram só 1x</span>
              <strong className="clientes-kpi-valor">{stats.clientesUmPedido}</strong>
            </div>
          </div>

          <div className="clientes-secao">
            <h3>Novos vs. recorrentes no período</h3>
            <div className="clientes-barra-comparativa">
              <div className="segmento recorrente" style={{ width: `${pctRecorrentes}%` }} />
              <div className="segmento novo" style={{ width: `${pctUmPedido}%` }} />
            </div>
            <div className="clientes-barra-legenda">
              <span><i className="dot recorrente" /> {stats.clientesRecorrentes} pediram 2x ou mais ({pctRecorrentes}%)</span>
              <span><i className="dot novo" /> {stats.clientesUmPedido} pediram só 1 vez ({pctUmPedido}%)</span>
            </div>
            <p className="clientes-nota">
              Baseado só no período selecionado — alguém que pediu 1x aqui pode já ter pedido antes, fora dessa janela.
            </p>
          </div>

          <div className="clientes-colunas">
            <div className="clientes-secao">
              <h3>Itens mais pedidos</h3>
              {stats.itensMaisPedidos.length === 0 ? (
                <p className="clientes-vazio">Nenhum item nesse período.</p>
              ) : (
                <table className="clientes-tabela">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Qtd.</th>
                      <th>Faturamento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.itensMaisPedidos.map((item) => (
                      <tr key={item.nome}>
                        <td>{toTitleCase(item.nome)}</td>
                        <td>{item.quantidadeTotal}</td>
                        <td>{formatarMoeda(item.faturamentoTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="clientes-secao">
              <h3>Quem mais pede</h3>
              {stats.rankingClientes.length === 0 ? (
                <p className="clientes-vazio">Nenhum cliente nesse período.</p>
              ) : (
                <table className="clientes-tabela">
                  <thead>
                    <tr>
                      <th>Cliente</th>
                      <th>Pedidos</th>
                      <th>Gasto total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.rankingClientes.map((c) => (
                      <tr key={c.telefone}>
                        <td>
                          {toTitleCase(c.nome)}
                          <span className="clientes-tel">{c.telefone}</span>
                        </td>
                        <td>{c.totalPedidos}</td>
                        <td>{formatarMoeda(c.valorTotalGasto)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="clientes-secao">
            <button type="button" className="clientes-secao-toggle" onClick={() => setMostrarUmPedido((v) => !v)}>
              <h3>Pediram só uma vez ({stats.clientesUmPedido})</h3>
              {mostrarUmPedido ? <MdExpandLess size={20} /> : <MdExpandMore size={20} />}
            </button>
            {mostrarUmPedido && stats.clientesUmPedidoTruncado && (
              <p className="clientes-nota">
                Mostrando os {stats.listaClientesUmPedido.length} mais recentes de {stats.clientesUmPedido}.
              </p>
            )}
            {mostrarUmPedido && (
              stats.listaClientesUmPedido.length === 0 ? (
                <p className="clientes-vazio">Ninguém nessa situação no período selecionado.</p>
              ) : (
                <table className="clientes-tabela">
                  <thead>
                    <tr>
                      <th>Cliente</th>
                      <th>Telefone</th>
                      <th>Pedido em</th>
                      <th>Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.listaClientesUmPedido.map((c) => (
                      <tr key={c.telefone}>
                        <td>{toTitleCase(c.nome)}</td>
                        <td>{c.telefone}</td>
                        <td>{c.ultimoPedidoEm}</td>
                        <td>{formatarMoeda(c.valorTotalGasto)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </div>
        </>
      ) : null}
    </div>
  );
};

export default ClientesDashboard;
