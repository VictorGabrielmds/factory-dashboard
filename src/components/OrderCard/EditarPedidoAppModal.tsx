// src/components/OrderCard/EditarPedidoAppModal.tsx
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  deleteField,
} from "firebase/firestore";
import { db } from "../../services/firebase";
import type { Pedido } from "../../types/Pedido";
import type { Produto } from "../../types/Produto";
import ModalBase from "../ModalBase/ModalBase";
import { useToast } from "../../contexts/ToastContext";
import { PAYMENT_LABELS } from "./orderCardConstants";
import "./EditarPedidoAppModal.css";

const OBSERVACOES_MAX = 500;

interface EditarPedidoAppModalProps {
  orderId: string;
  onClose: () => void;
}

interface ItemEditavel {
  produtoId: string | null;
  descricao: string;
  quantidade: number;
  valorUnitario: number;
}

// Mesma normalização usada em functions/src/services/entrega.js e
// ZonasEntregaDashboard.tsx — o ID do documento em zonas_entrega é o bairro
// normalizado, precisa bater com o texto livre digitado aqui.
function normalizarBairro(bairro: string) {
  return bairro
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export default function EditarPedidoAppModal({ orderId, onClose }: EditarPedidoAppModalProps) {
  const { addToast } = useToast();

  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [pedidoOriginal, setPedidoOriginal] = useState<Pedido | null>(null);

  const [itens, setItens] = useState<ItemEditavel[]>([]);
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [buscaProduto, setBuscaProduto] = useState("");

  const [tipoEntrega, setTipoEntrega] = useState<"delivery" | "retirada">("retirada");
  const [logradouro, setLogradouro] = useState("");
  const [numero, setNumero] = useState("");
  const [complemento, setComplemento] = useState("");
  const [bairro, setBairro] = useState("");
  const [referencia, setReferencia] = useState("");
  const [valorTaxa, setValorTaxa] = useState(0);
  const [buscandoTaxa, setBuscandoTaxa] = useState(false);

  const [formaPagamento, setFormaPagamento] = useState("01");
  const [observacoes, setObservacoes] = useState("");

  // Lê o pedido direto do Firestore ao abrir (não confia no card já
  // renderizado, que pode estar um pouco desatualizado numa lista longa).
  useEffect(() => {
    let cancelado = false;
    (async () => {
      const snap = await getDoc(doc(db, "pedidos", orderId));
      if (cancelado) return;
      if (!snap.exists()) {
        addToast("Pedido não encontrado.", "error");
        onClose();
        return;
      }
      const pedido = snap.data() as Pedido;
      setPedidoOriginal(pedido);

      const descricoes = pedido.descricao_item || [];
      const quantidades = pedido.quantidade_item || [];
      const valoresTotais = pedido.valor_total_item || [];
      const produtoIds = pedido.produto_id_item || [];
      setItens(
        descricoes.map((descricao, i) => {
          const quantidade = quantidades[i] || 1;
          const valorTotal = valoresTotais[i] ?? 0;
          return {
            produtoId: produtoIds[i] || null,
            descricao,
            quantidade,
            valorUnitario: quantidade > 0 ? valorTotal / quantidade : 0,
          };
        })
      );

      setTipoEntrega(pedido.tipo_entrega === "delivery" ? "delivery" : "retirada");
      setLogradouro(pedido.logradouro_destinatario ? String(pedido.logradouro_destinatario) : "");
      setNumero(pedido.numero_destinatario ? String(pedido.numero_destinatario) : "");
      setComplemento(pedido.complemento_destinatario || "");
      setBairro(pedido.bairro_destinatario || "");
      setReferencia((pedido as unknown as { referencia?: string }).referencia || "");
      setValorTaxa(Number(pedido.valor_taxa) || 0);

      const pagamentoAtual = Array.isArray(pedido.forma_pagamento)
        ? pedido.forma_pagamento[0]
        : pedido.forma_pagamento;
      setFormaPagamento(pagamentoAtual ? String(pagamentoAtual) : "01");
      setObservacoes(pedido.observacoes || "");

      setCarregando(false);
    })();
    return () => {
      cancelado = true;
    };
  }, [orderId, onClose, addToast]);

  // Lista de produtos disponíveis pra adicionar — mesmo padrão de fetch já
  // usado em ProdutosDashboard.tsx.
  useEffect(() => {
    const q = query(collection(db, "produtos"));
    const unsub = onSnapshot(q, (snap) => {
      const lista = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as Produto))
        .filter((p) => p.disponivel);
      setProdutos(lista);
    });
    return () => unsub();
  }, []);

  const produtosFiltrados = useMemo(() => {
    const termo = buscaProduto.trim().toLowerCase();
    if (!termo) return produtos;
    return produtos.filter((p) => p.nome.toLowerCase().includes(termo));
  }, [produtos, buscaProduto]);

  function adicionarProduto(produto: Produto) {
    setItens((atual) => {
      const existente = atual.findIndex((it) => it.produtoId === produto.id);
      if (existente >= 0) {
        const copia = [...atual];
        copia[existente] = { ...copia[existente], quantidade: copia[existente].quantidade + 1 };
        return copia;
      }
      return [
        ...atual,
        { produtoId: produto.id || null, descricao: produto.nome, quantidade: 1, valorUnitario: produto.preco },
      ];
    });
  }

  function alterarQuantidade(index: number, quantidade: number) {
    setItens((atual) => {
      const copia = [...atual];
      copia[index] = { ...copia[index], quantidade: Math.max(0, quantidade) };
      return copia;
    });
  }

  function removerItem(index: number) {
    setItens((atual) => atual.filter((_, i) => i !== index));
  }

  async function buscarTaxaDoBairro() {
    if (!bairro.trim()) return;
    setBuscandoTaxa(true);
    try {
      const zonaSnap = await getDoc(doc(db, "zonas_entrega", normalizarBairro(bairro)));
      if (zonaSnap.exists() && zonaSnap.data().ativo) {
        setValorTaxa(Number(zonaSnap.data().taxa) || 0);
      } else {
        addToast("Bairro não cadastrado — informe a taxa manualmente.", "info");
      }
    } finally {
      setBuscandoTaxa(false);
    }
  }

  const itensValidos = itens.filter((it) => it.quantidade > 0);
  const subtotal = itensValidos.reduce((soma, it) => soma + it.valorUnitario * it.quantidade, 0);
  const podeSalvar =
    itensValidos.length > 0 &&
    (tipoEntrega === "retirada" || (logradouro.trim() && numero.trim() && bairro.trim()));

  async function handleSalvar() {
    if (!podeSalvar || !pedidoOriginal) return;
    setSalvando(true);
    try {
      await runTransaction(db, async (tx) => {
        const pedidoRef = doc(db, "pedidos", orderId);
        const snap = await tx.get(pedidoRef);
        if (!snap.exists()) throw new Error("Pedido não encontrado.");
        const atual = snap.data() as Pedido;

        const descricao_item = itensValidos.map((it) => it.descricao);
        const quantidade_item = itensValidos.map((it) => it.quantidade);
        const valor_total_item = itensValidos.map((it) => it.valorUnitario * it.quantidade);
        const produto_id_item = itensValidos.map((it) => it.produtoId || "");
        const valor_itens = valor_total_item.reduce((soma, v) => soma + v, 0);

        const valorDesconto = Number(atual.valor_desconto) || 0;
        const valorTaxaCartao = Number(atual.valor_taxa_cartao) || 0;
        const novaTaxaEntrega = tipoEntrega === "delivery" ? valorTaxa : 0;
        const totalAntesTaxaCartao = valor_itens - valorDesconto + novaTaxaEntrega;
        const valor_venda = totalAntesTaxaCartao + valorTaxaCartao;

        tx.update(pedidoRef, {
          descricao_item,
          quantidade_item,
          valor_total_item,
          produto_id_item,
          valor_itens,
          valor_venda,
          forma_pagamento: [formaPagamento],
          observacoes: observacoes.trim() || deleteField(),
          tipo_entrega: tipoEntrega,
          ...(tipoEntrega === "delivery"
            ? {
                logradouro_destinatario: logradouro.trim(),
                numero_destinatario: numero.trim(),
                complemento_destinatario: complemento.trim() || deleteField(),
                bairro_destinatario: bairro.trim(),
                referencia: referencia.trim() || deleteField(),
                valor_taxa: novaTaxaEntrega,
              }
            : {
                logradouro_destinatario: deleteField(),
                numero_destinatario: deleteField(),
                complemento_destinatario: deleteField(),
                bairro_destinatario: deleteField(),
                referencia: deleteField(),
                valor_taxa: 0,
              }),
          // Campo que o robô de impressão escuta — reimprime sozinho quando
          // vira false (ver RoboImpressaoDelivery/Form1.cs), sem precisar de
          // nenhuma mudança lá.
          impresso: false,
        });
      });
      addToast("Pedido atualizado — a notinha vai reimprimir automaticamente.", "success");
      onClose();
    } catch (erro) {
      console.error("Erro ao salvar edição do pedido:", erro);
      addToast("Erro ao salvar — tente novamente.", "error");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <ModalBase isOpen onClose={onClose} title={`Editar pedido #${orderId}`}>
      {carregando ? (
        <p className="epa-carregando">Carregando pedido...</p>
      ) : (
        <div className="epa-container">
          <section className="epa-section">
            <h3>Itens do pedido</h3>
            <div className="epa-itens-lista">
              {itens.map((item, index) => (
                <div key={index} className="epa-item-row">
                  <span className="epa-item-nome">{item.descricao}</span>
                  <div className="epa-item-qtd">
                    <button type="button" onClick={() => alterarQuantidade(index, item.quantidade - 1)}>
                      −
                    </button>
                    <span>{item.quantidade}</span>
                    <button type="button" onClick={() => alterarQuantidade(index, item.quantidade + 1)}>
                      +
                    </button>
                  </div>
                  <button type="button" className="epa-item-remover" onClick={() => removerItem(index)} aria-label={`Remover ${item.descricao}`}>
                    Remover
                  </button>
                </div>
              ))}
              {itens.length === 0 && <p className="epa-vazio">Nenhum item no pedido.</p>}
            </div>
          </section>

          <section className="epa-section">
            <h3>Adicionar item</h3>
            <input
              type="search"
              value={buscaProduto}
              onChange={(e) => setBuscaProduto(e.target.value)}
              placeholder="Buscar produto..."
              className="epa-busca"
            />
            <div className="epa-produtos-lista">
              {produtosFiltrados.map((produto) => (
                <button
                  type="button"
                  key={produto.id}
                  className="epa-produto-item"
                  onClick={() => adicionarProduto(produto)}
                >
                  <span>{produto.nome}</span>
                  <span className="epa-produto-preco">R$ {produto.preco.toFixed(2)}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="epa-section">
            <h3>Tipo de entrega</h3>
            <div className="epa-tipo-toggle">
              <button
                type="button"
                className={tipoEntrega === "retirada" ? "ativo" : ""}
                onClick={() => setTipoEntrega("retirada")}
              >
                Retirada
              </button>
              <button
                type="button"
                className={tipoEntrega === "delivery" ? "ativo" : ""}
                onClick={() => setTipoEntrega("delivery")}
              >
                Delivery
              </button>
            </div>

            {tipoEntrega === "delivery" && (
              <div className="epa-endereco">
                <div className="epa-endereco-grid">
                  <input value={logradouro} onChange={(e) => setLogradouro(e.target.value)} placeholder="Rua" />
                  <input value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="Número" />
                </div>
                <input value={complemento} onChange={(e) => setComplemento(e.target.value)} placeholder="Complemento" />
                <div className="epa-bairro-row">
                  <input
                    value={bairro}
                    onChange={(e) => setBairro(e.target.value)}
                    onBlur={buscarTaxaDoBairro}
                    placeholder="Bairro"
                  />
                  <div className="epa-taxa-field">
                    <span>Taxa</span>
                    <input
                      type="number"
                      step="0.01"
                      value={valorTaxa}
                      disabled={buscandoTaxa}
                      onChange={(e) => setValorTaxa(Number(e.target.value) || 0)}
                    />
                  </div>
                </div>
                <input value={referencia} onChange={(e) => setReferencia(e.target.value)} placeholder="Referência" />
              </div>
            )}
          </section>

          <section className="epa-section">
            <h3>Pagamento e observações</h3>
            <select
              className="epa-select"
              value={formaPagamento}
              onChange={(e) => setFormaPagamento(e.target.value)}
            >
              {Object.entries(PAYMENT_LABELS).map(([codigo, label]) => (
                <option key={codigo} value={codigo}>{label}</option>
              ))}
            </select>
            <textarea
              className="epa-textarea"
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value.slice(0, OBSERVACOES_MAX))}
              placeholder="Observações do cliente (ex.: sem cebola, troco pra R$ 50...)"
              rows={3}
              maxLength={OBSERVACOES_MAX}
            />
          </section>

          <div className="epa-resumo">
            <span>Subtotal dos itens</span>
            <strong>R$ {subtotal.toFixed(2)}</strong>
          </div>

          <div className="epa-acoes">
            <button type="button" className="epa-btn-cancelar" onClick={onClose} disabled={salvando}>
              Cancelar
            </button>
            <button type="button" className="epa-btn-salvar" onClick={handleSalvar} disabled={!podeSalvar || salvando}>
              {salvando ? "Salvando..." : "Salvar e reimprimir"}
            </button>
          </div>
        </div>
      )}
    </ModalBase>
  );
}
