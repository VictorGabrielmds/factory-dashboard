import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MdOutlineReceiptLong, MdLockOutline, MdOutlineLink, MdOutlineFactCheck,
  MdOutlineRefresh, MdSearch, MdClose, MdCheckCircleOutline } from "react-icons/md";
import { fiscalRequest, type FiscalRequest, type ResumoFiscal, type ProdutoFiscal,
  type VinculoFiscal, type ConferenciaFiscal, type ConexaoFiscal } from "../../services/fiscalApi";
import "./FiscalDashboard.css";

const dinheiro = (centavos: number | null) => centavos === null ? "—" :
  (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dataHora = (data: string | null) => data ? new Date(data).toLocaleString("pt-BR") : "Ainda não verificado";
const revisado = (produto: ProdutoFiscal) => produto.vinculo?.revisado === true &&
  produto.vinculo.nomeProdutoNaRevisao === produto.nome;
const textoErro = (erro: unknown) => erro instanceof Error ? erro.message : "Não foi possível concluir a operação.";

type DadosVinculo = { codigoProduto: string; nomeEf: string; revisado: boolean; observacao: string };

function EditorVinculo({ produto, salvando, salvar, fechar }: {
  produto: ProdutoFiscal; salvando: boolean; salvar: (dados: DadosVinculo) => void; fechar: () => void;
}) {
  const [dados, setDados] = useState<DadosVinculo>(() => ({
    codigoProduto: produto.vinculo?.codigoProduto || "", nomeEf: produto.vinculo?.nomeEf || "",
    revisado: revisado(produto), observacao: produto.vinculo?.observacao || "",
  }));
  const alterar = (campo: "codigoProduto" | "nomeEf" | "observacao", valor: string) =>
    setDados(anterior => ({ ...anterior, [campo]: valor, revisado: false }));
  function enviar(evento: FormEvent) {
    evento.preventDefault();
    salvar(dados);
  }
  return <form className="fiscal-editor" onSubmit={enviar} aria-label={`Vínculo fiscal de ${produto.nome}`}>
    <div className="fiscal-editor-fields">
      <label>Código do produto na EF
        <input autoFocus required inputMode="numeric" pattern="[1-9][0-9]{0,14}" maxLength={15}
          value={dados.codigoProduto} onChange={e => alterar("codigoProduto", e.target.value)} disabled={salvando} />
      </label>
      <label>Nome no cadastro fiscal
        <input required maxLength={160} value={dados.nomeEf} onChange={e => alterar("nomeEf", e.target.value)} disabled={salvando} />
      </label>
    </div>
    <p>Use o código interno de um produto <strong>já existente</strong> na Eficiência Fiscal, não o código externo do InstaDelivery.</p>
    <label>Observação da conferência <span className="fiscal-optional">(opcional)</span>
      <input maxLength={500} value={dados.observacao} onChange={e => alterar("observacao", e.target.value)} disabled={salvando} />
    </label>
    <label className="fiscal-checkbox">
      <input type="checkbox" checked={dados.revisado} onChange={e => setDados(atual => ({ ...atual, revisado: e.target.checked }))} disabled={salvando} />
      <span>Conferi o código, o produto e sua figura tributária no cadastro fiscal com orientação da contabilidade.</span>
    </label>
    <p>Esta marcação registra a sua conferência; o sistema não valida a tributação automaticamente.</p>
    <div className="fiscal-editor-actions">
      <button type="button" onClick={fechar} disabled={salvando}>Cancelar</button>
      <button className="fiscal-primary" type="submit" disabled={salvando}>{salvando ? "Salvando…" : "Salvar vínculo"}</button>
    </div>
  </form>;
}

function ResultadoConferencia({ resultado, atualizar, ocupado }: {
  resultado: ConferenciaFiscal; atualizar: () => void; ocupado: boolean;
}) {
  const { snapshot, pendencias } = resultado;
  return <section className="fiscal-result" aria-labelledby="fiscal-result-title">
    <header className="fiscal-result-heading">
      <div><span className="fiscal-eyebrow">Pedido #{snapshot.pedidoId} · {snapshot.tipoEntrega === "retirada" ? "Retirada" : "Delivery"}</span>
        <h3 id="fiscal-result-title">{snapshot.cliente}</h3>
        <p>Conferência salva em {dataHora(resultado.atualizadoEm)}</p>
      </div>
      <span className={`fiscal-badge ${pendencias.length ? "" : "is-ok"}`}>
        {pendencias.length ? `${pendencias.length} pendência${pendencias.length === 1 ? "" : "s"}` : "Conferido · sem emissão"}
      </span>
    </header>
    {snapshot.agendamento && <p className="fiscal-schedule">Agendamento: {snapshot.agendamento}</p>}
    <div className="fiscal-table-scroll"><table className="fiscal-items">
      <caption className="fiscal-sr-only">Itens do pedido no momento da conferência</caption>
      <thead><tr><th>Item</th><th>Qtd.</th><th>Código EF</th><th>Total</th></tr></thead>
      <tbody>{snapshot.itens.map((item, index) => <tr key={`${item.produtoId}-${index}`}>
        <td>{item.descricao || "Sem descrição"}</td><td>{item.quantidade ?? "—"}</td>
        <td>{item.codigoProduto || "Não vinculado"}</td><td>{dinheiro(item.totalCentavos)}</td>
      </tr>)}</tbody>
    </table></div>
    <dl className="fiscal-totals">
      <div><dt>Itens</dt><dd>{dinheiro(snapshot.resumo.itensCentavos)}</dd></div>
      <div><dt>Desconto</dt><dd>{dinheiro(snapshot.resumo.descontoCentavos)}</dd></div>
      <div><dt>Entrega</dt><dd>{dinheiro(snapshot.resumo.entregaCentavos)}</dd></div>
      <div><dt>Taxa de cartão</dt><dd>{dinheiro(snapshot.resumo.taxaCartaoCentavos)}</dd></div>
      <div className="fiscal-total"><dt>Total do pedido</dt><dd>{dinheiro(snapshot.resumo.totalCentavos)}</dd></div>
    </dl>
    {pendencias.length > 0 && <div className="fiscal-issues"><h4>O que precisa de atenção</h4>
      <ul>{pendencias.map((item, index) => <li key={`${item.codigo}-${index}`}>
        {item.item !== null && <strong>Item {item.item + 1}: </strong>}{item.mensagem}
      </li>)}</ul>
    </div>}
    <details className="fiscal-notes"><summary>Limites desta conferência e cuidados antes da emissão</summary>
      <ul>{resultado.avisos.map(aviso => <li key={aviso}>{aviso}</li>)}</ul>
    </details>
    <footer className="fiscal-result-footer">
      <p>Retrato dos dados naquele momento. Se o pedido ou o vínculo mudou, confira novamente.</p>
      <button type="button" onClick={atualizar} disabled={ocupado}><MdOutlineRefresh aria-hidden="true" />Atualizar conferência</button>
    </footer>
  </section>;
}

export default function FiscalDashboard({ request = fiscalRequest }: { request?: FiscalRequest }) {
  const [resumo, setResumo] = useState<ResumoFiscal | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [aba, setAba] = useState<"pedidos" | "produtos">("pedidos");
  const [pedidoId, setPedidoId] = useState("");
  const [conferencia, setConferencia] = useState<ConferenciaFiscal | null>(null);
  const [busca, setBusca] = useState("");
  const [somentePendentes, setSomentePendentes] = useState(true);
  const [editando, setEditando] = useState<string | null>(null);
  const ativo = useRef(true);
  const emVoo = useRef(false);
  const controles = useRef(new Set<AbortController>());

  const carregar = useCallback(async (signal?: AbortSignal) => {
    const dados = await request<ResumoFiscal>("resumo", {}, signal);
    if (ativo.current && !signal?.aborted) setResumo(dados);
  }, [request]);

  useEffect(() => {
    ativo.current = true;
    const controller = new AbortController();
    void carregar(controller.signal).catch(error => {
      if (!controller.signal.aborted && ativo.current) setErro(textoErro(error));
    }).finally(() => { if (!controller.signal.aborted && ativo.current) setCarregando(false); });
    const pendentes = controles.current;
    return () => { ativo.current = false; controller.abort(); pendentes.forEach(c => c.abort()); };
  }, [carregar]);

  async function executar(chave: string, operacao: (signal: AbortSignal) => Promise<void>) {
    if (emVoo.current) return;
    emVoo.current = true;
    const controller = new AbortController();
    controles.current.add(controller);
    setOcupado(chave); setErro(""); setMensagem("");
    try { await operacao(controller.signal); }
    catch (error) { if (ativo.current && !controller.signal.aborted) setErro(textoErro(error)); }
    finally {
      controles.current.delete(controller); emVoo.current = false;
      if (ativo.current) setOcupado(null);
    }
  }

  const testar = () => executar("conexao", async signal => {
    const dados = await request<{ conexao: ConexaoFiscal }>("testarConexao", {}, signal);
    if (ativo.current) setResumo(atual => atual ? { ...atual, conexao: dados.conexao } : atual);
  });
  const conferir = (id: string) => executar("pedido", async signal => {
    setConferencia(null);
    const dados = await request<{ conferencia: ConferenciaFiscal }>("conferirPedido", { pedidoId: id.trim() }, signal);
    if (!ativo.current) return;
    setConferencia(dados.conferencia); setPedidoId(id.trim());
    setMensagem("Conferência salva. Nenhuma nota foi emitida.");
    await carregar(signal);
  });
  const abrirConferencia = (id: string) => executar("historico", async signal => {
    setConferencia(null);
    const dados = await request<{ conferencia: ConferenciaFiscal }>("consultarConferencia", { pedidoId: id }, signal);
    if (ativo.current) { setConferencia(dados.conferencia); setPedidoId(id); }
  });
  const salvarVinculo = (produto: ProdutoFiscal, dados: DadosVinculo) => executar("vinculo", async signal => {
    const resposta = await request<{ vinculo: VinculoFiscal }>("salvarVinculo", {
      produtoId: produto.id, versaoEsperada: produto.vinculo?.revisao ?? null, ...dados,
    }, signal);
    if (!ativo.current) return;
    setResumo(atual => atual ? { ...atual, produtos: atual.produtos.map(p => p.id === produto.id ? { ...p, vinculo: resposta.vinculo } : p) } : atual);
    setEditando(null); setMensagem("Vínculo salvo. Conferências anteriores precisam ser atualizadas para usar esta revisão.");
  });

  const produtos = resumo?.produtos.filter(p => !p.especial) || [];
  const revisados = produtos.filter(revisado).length;
  const termo = busca.trim().toLocaleLowerCase("pt-BR");
  const filtrados = produtos.filter(p => (!somentePendentes || !revisado(p) || p.id === editando) &&
    `${p.nome} ${p.categoria} ${p.vinculo?.codigoProduto || ""}`.toLocaleLowerCase("pt-BR").includes(termo));
  const conexao = resumo?.conexao;

  return <div className="fiscal-page">
    <header className="fiscal-heading"><div className="fiscal-heading-copy">
      <span className="fiscal-heading-icon"><MdOutlineReceiptLong aria-hidden="true" /></span>
      <div><h2>Fiscal</h2><p>Prepare os pedidos para emitir com segurança.</p></div>
    </div><span className="fiscal-badge"><MdLockOutline aria-hidden="true" />Emissão desativada</span></header>

    {erro && <div className="fiscal-feedback is-error" role="alert"><span>{erro}</span>
      <button type="button" disabled={!!ocupado} onClick={() => executar("carregar", signal => carregar(signal))}><MdOutlineRefresh aria-hidden="true" />Atualizar dados</button>
    </div>}
    {mensagem && <p className="fiscal-feedback" role="status">{mensagem}</p>}
    {carregando ? <div className="fiscal-empty" role="status"><div className="spinner" /><p>Carregando preparação fiscal…</p></div> : resumo && <>
      <section className="fiscal-connection" aria-label="Conexão com a Eficiência Fiscal">
        <div><strong>Eficiência Fiscal</strong><p>CNPJ 11.560.207/0001-37</p></div>
        <div className="fiscal-connection-state" role="status"><span className={`fiscal-dot ${conexao?.estado === "ok" ? "is-ok" : conexao?.estado === "falha" ? "is-failed" : ""}`} />
          <div><span>{ocupado === "conexao" ? "Testando conexão…" : conexao?.mensagem || "Conexão ainda não testada nesta instalação."}</span>
            <small>{conexao ? dataHora(conexao.verificadoEm) : "O teste apenas consulta; não emite notas."}</small></div>
        </div>
        <button type="button" onClick={testar} disabled={!!ocupado}><MdOutlineRefresh aria-hidden="true" />{ocupado === "conexao" ? "Aguarde…" : "Testar conexão"}</button>
      </section>
      <details className="fiscal-readiness"><summary><MdLockOutline aria-hidden="true" />O que falta para liberar a emissão?</summary>
        <ul>{resumo.etapasPendentes.map(etapa => <li key={etapa}>{etapa}</li>)}</ul>
        <p>Não há envio à SEFAZ nesta etapa. Conferir um pedido não cria nem reserva uma nota fiscal.</p>
      </details>

      <div className="fiscal-workspace">
        <div className="fiscal-tabs" role="tablist" aria-label="Preparação fiscal">
          {(["pedidos", "produtos"] as const).map((id, index) => <button key={id} id={`fiscal-tab-${id}`} type="button" role="tab"
            aria-selected={aba === id} aria-controls={`fiscal-panel-${id}`} tabIndex={aba === id ? 0 : -1}
            className={aba === id ? "active" : ""} onClick={() => setAba(id)}
            onKeyDown={event => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const proximo = event.key === "Home" ? "pedidos" : event.key === "End" ? "produtos" : index === 0 ? "produtos" : "pedidos";
                setAba(proximo); document.getElementById(`fiscal-tab-${proximo}`)?.focus();
              }
            }}>
            {id === "pedidos" ? <MdOutlineFactCheck aria-hidden="true" /> : <MdOutlineLink aria-hidden="true" />}
            {id === "pedidos" ? "Conferir pedido" : "Vínculos de produtos"}
            {id === "produtos" && <span className="fiscal-tab-count">{revisados}/{produtos.length}</span>}
          </button>)}
        </div>

        {aba === "pedidos" ? <section role="tabpanel" id="fiscal-panel-pedidos" aria-labelledby="fiscal-tab-pedidos">
          <form className="fiscal-order-search" onSubmit={event => { event.preventDefault(); void conferir(pedidoId); }}>
            <label htmlFor="fiscal-order-id">ID do pedido do app cliente</label>
            <div><input id="fiscal-order-id" required maxLength={128} pattern="[A-Za-z0-9_-]+" autoComplete="off"
              placeholder="Ex.: 148237434" value={pedidoId} onChange={e => setPedidoId(e.target.value)} disabled={!!ocupado} />
              <button className="fiscal-primary" type="submit" disabled={!!ocupado || !pedidoId.trim()}><MdOutlineFactCheck aria-hidden="true" />{ocupado === "pedido" ? "Conferindo…" : "Conferir pedido"}</button></div>
            <p>A conferência usa os valores salvos no pedido, sem recalcular pelo preço atual do cardápio.</p>
          </form>
          {conferencia ? <ResultadoConferencia resultado={conferencia} ocupado={!!ocupado} atualizar={() => conferir(conferencia.snapshot.pedidoId)} /> :
            <div className="fiscal-empty"><MdOutlineReceiptLong aria-hidden="true" /><h3>Confira antes de emitir</h3>
              <p>Veja produtos sem vínculo, valores divergentes e pendências de pagamento em um só lugar.</p></div>}
          {resumo.conferencias.length > 0 && <section className="fiscal-history"><h3>Últimas conferências</h3>
            <p>Registros de preparação — não são notas emitidas.</p>
            {resumo.conferencias.map(item => <button type="button" key={item.pedidoId} disabled={!!ocupado} onClick={() => abrirConferencia(item.pedidoId)}>
              <span><strong>#{item.pedidoId} · {item.cliente}</strong><small>{dataHora(item.atualizadoEm)}</small></span>
              <span>{item.pendencias ? `${item.pendencias} pendência(s)` : "Conferido"}</span>
            </button>)}
          </section>}
        </section> : <section role="tabpanel" id="fiscal-panel-produtos" aria-labelledby="fiscal-tab-produtos">
          <div className="fiscal-products-heading"><h3>O mesmo produto, nos dois sistemas</h3>
            <p>Vincule ao catálogo existente da Eficiência Fiscal. Nenhum produto será criado lá automaticamente.</p></div>
          <div className="fiscal-products-toolbar"><label className="fiscal-search"><MdSearch aria-hidden="true" />
            <input aria-label="Buscar produto ou código fiscal" placeholder="Buscar produto ou código EF" value={busca} onChange={e => setBusca(e.target.value)} />
            {busca && <button type="button" aria-label="Limpar busca" onClick={() => setBusca("")}><MdClose /></button>}
          </label><label className="fiscal-checkbox"><input type="checkbox" checked={somentePendentes} onChange={e => setSomentePendentes(e.target.checked)} />Somente pendentes</label></div>
          {resumo.catalogoLimitado && <p role="status">Exibindo até 500 produtos. Amplie a paginação antes de usar um catálogo maior.</p>}
          {filtrados.length ? <div className="fiscal-product-list">{filtrados.map(produto => <article className="fiscal-product" key={produto.id}>
            <div className="fiscal-product-line"><div><h4>{produto.nome}</h4><p>{produto.categoria}{!produto.disponivel ? " · Fora do cardápio" : ""}</p></div>
              <div className="fiscal-product-link"><span>{produto.vinculo ? `EF ${produto.vinculo.codigoProduto} · ${produto.vinculo.nomeEf}` : "Sem vínculo fiscal"}</span>
                <small className={revisado(produto) ? "is-ok" : ""}>{revisado(produto) ? "Conferência registrada" : "Pendente de conferência"}</small></div>
              <button type="button" disabled={!!ocupado} aria-expanded={editando === produto.id}
                onClick={() => setEditando(editando === produto.id ? null : produto.id)}>{produto.vinculo ? "Editar vínculo" : "Vincular"}</button>
            </div>
            {editando === produto.id && <EditorVinculo key={produto.id} produto={produto} salvando={ocupado === "vinculo"}
              salvar={dados => salvarVinculo(produto, dados)} fechar={() => setEditando(null)} />}
          </article>)}</div> : <div className="fiscal-empty"><MdCheckCircleOutline aria-hidden="true" /><h3>{termo ? "Nenhum produto encontrado" : "Nenhum vínculo pendente nesta lista"}</h3>
            <p>{termo ? "Tente outro nome ou código." : "A conferência dos vínculos não libera a emissão automaticamente."}</p></div>}
          <p className="fiscal-footnote">Itens de sistema e serviços de fritura não entram neste vínculo de mercadorias. A revisão tributária permanece sob orientação da contabilidade.</p>
        </section>}
      </div>
    </>}
  </div>;
}
