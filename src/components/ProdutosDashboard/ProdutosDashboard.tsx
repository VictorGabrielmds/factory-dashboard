// src/components/ProdutosDashboard/ProdutosDashboard.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import "./ProdutosDashboard.css";
import { db, getStorageLazy, collection, onSnapshot, query, addDoc, updateDoc, deleteDoc, doc, getDoc, setDoc } from "../../services/firebase";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import type { DropResult } from "@hello-pangea/dnd";
import ModalBase from "../ModalBase/ModalBase";
import CategoriaAutocomplete from "./CategoriaAutocomplete";
import {
  BsPlusCircleFill as PlusCircleFill,
  BsPencilFill as PencilFill,
  BsTrash as Trash,
  BsEyeSlash as EyeSlash,
  BsSlashCircle as SlashCircle,
  BsBasket2 as Basket2,
  BsUpload as Upload,
  BsArrowsMove as ArrowsMove,
  BsCalendarEvent as CalendarEvent,
  BsGeoAlt as GeoAlt,
  BsSearch as Search,
  BsShieldCheck as ShieldCheck,
  BsX as Close,
} from "react-icons/bs";
import { useToast } from "../../contexts/ToastContext";
import type { Produto } from "../../types/Produto";

const PRODUTO_AGENDAMENTO_FRITURA_ID = "agendamento_fritura";
const TIPO_AGENDAMENTO_FRITURA = "agendamento_fritura" as const;
const PRODUTO_AGENDAMENTO_FRITURA_PADRAO = {
  nome: "Agendar fritura",
  descricao: "Escolha uma data e envie sua solicitação de fritura para nossa equipe.",
  preco: 0,
  categoria: "Serviços",
  imagemUrl: "",
  disponivel: true,
  esgotado: false,
  tempoPreparoMinutos: null,
  friturasNoLocal: false,
  dataHoraFritura: null,
  localFritura: null,
  tipoSistema: TIPO_AGENDAMENTO_FRITURA,
  itemSistema: true,
};

const ehProdutoAgendamentoFritura = (produto?: Produto | null) =>
  produto?.id === PRODUTO_AGENDAMENTO_FRITURA_ID ||
  produto?.tipoSistema === TIPO_AGENDAMENTO_FRITURA;

const FORM_VAZIO = {
  nome: "", descricao: "", preco: "", categoria: "", imagemUrl: "", disponivel: true, esgotado: false, tempoPreparo: "",
  friturasNoLocal: false, dataHoraFritura: "", localFritura: "",
};

// "Dia 10/08 às 14:30" a partir do valor cru do <input type="datetime-local">
// ("2026-08-10T14:30") — mesmo espírito de formatarAgendamento no app cliente.
function formatarDataHoraFritura(bruto: string): string {
  const data = new Date(bruto);
  if (Number.isNaN(data.getTime())) return "";
  const dia = String(data.getDate()).padStart(2, "0");
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const hora = String(data.getHours()).padStart(2, "0");
  const min = String(data.getMinutes()).padStart(2, "0");
  return `${dia}/${mes} às ${hora}:${min}`;
}

// Máscara de centavos: cada dígito digitado entra pela direita, como numa
// calculadora — "850" vira "8,50". Evita formato inválido no preço.
function formatarCentavos(valorDigitado: string): string {
  const digits = valorDigitado.replace(/\D/g, "");
  const centavos = parseInt(digits || "0", 10);
  return (centavos / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function precoParaNumero(precoFormatado: string): number {
  return parseFloat(precoFormatado.replace(/\./g, "").replace(",", ".")) || 0;
}

export default function ProdutosDashboard() {
  const { addToast } = useToast();
  const [produtos, setProdutos] = useState<Produto[]>([]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(FORM_VAZIO);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [produtoToDelete, setProdutoToDelete] = useState<string | null>(null);

  const [uploadingImagem, setUploadingImagem] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Ordem das categorias no cardápio do cliente — configuracoes/categorias
  // guarda a lista de nomes na ordem desejada + um texto opcional por seção
  // (ex.: "Feitos na hora, crocantes por fora"); categoria nova que ainda
  // não apareceu ali cai no fim, em ordem alfabética entre si.
  const [ordemCategorias, setOrdemCategorias] = useState<string[]>([]);
  const [descricoesCategorias, setDescricoesCategorias] = useState<Record<string, string>>({});
  const [salvandoOrdem, setSalvandoOrdem] = useState(false);
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<"todos" | "disponiveis" | "indisponiveis">("todos");
  const [mostrarOrganizacao, setMostrarOrganizacao] = useState(false);

  useEffect(() => {
    const q = query(collection(db, "produtos"));
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Produto));
      setProdutos(data);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const garantirProdutoDoSistema = async () => {
      const produtoRef = doc(db, "produtos", PRODUTO_AGENDAMENTO_FRITURA_ID);
      try {
        const snap = await getDoc(produtoRef);
        if (!snap.exists()) {
          await setDoc(produtoRef, PRODUTO_AGENDAMENTO_FRITURA_PADRAO);
          addToast("O item Agendar fritura foi adicionado ao cardápio.", "success");
        }
      } catch (err) {
        console.error(err);
        addToast("Não foi possível preparar o item Agendar fritura.", "error");
      }
    };

    void garantirProdutoDoSistema();
  }, [addToast]);

  useEffect(() => {
    getDoc(doc(db, "configuracoes", "categorias")).then((snap) => {
      const dados = snap.data();
      const ordem = dados?.ordem;
      if (Array.isArray(ordem)) setOrdemCategorias(ordem);
      const descricoes = dados?.descricoes;
      if (descricoes && typeof descricoes === "object") setDescricoesCategorias(descricoes);
    });
  }, []);

  const porCategoriaCompleto = useMemo(() => {
    const grupos = new Map<string, Produto[]>();
    for (const p of produtos) {
      const categoria = p.categoria || "Sem categoria";
      if (!grupos.has(categoria)) grupos.set(categoria, []);
      grupos.get(categoria)!.push(p);
    }
    for (const lista of grupos.values()) lista.sort((a, b) => a.nome.localeCompare(b.nome));
    return [...grupos.entries()].sort(([a], [b]) => {
      const idxA = ordemCategorias.indexOf(a);
      const idxB = ordemCategorias.indexOf(b);
      if (idxA === -1 && idxB === -1) return a.localeCompare(b);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
  }, [produtos, ordemCategorias]);

  // Lista de categorias em uso, já na ordem salva (+ novas no fim) — base
  // pro painel de "arrastar pra reordenar" e o que é gravado ao salvar.
  const categoriasEmUso = useMemo(
    () => porCategoriaCompleto.map(([categoria]) => categoria),
    [porCategoriaCompleto],
  );

  const produtosDisponiveis = useMemo(
    () => produtos.filter((produto) => produto.disponivel && !produto.esgotado).length,
    [produtos],
  );

  const produtosVisiveis = useMemo(() => {
    const termo = busca.trim().toLocaleLowerCase("pt-BR");
    return produtos.filter((produto) => {
      const correspondeBusca =
        !termo ||
        [produto.nome, produto.descricao, produto.categoria]
          .some((valor) => valor?.toLocaleLowerCase("pt-BR").includes(termo));
      const estaDisponivel = produto.disponivel && !produto.esgotado;
      const correspondeFiltro =
        filtro === "todos" ||
        (filtro === "disponiveis" && estaDisponivel) ||
        (filtro === "indisponiveis" && !estaDisponivel);
      return correspondeBusca && correspondeFiltro;
    });
  }, [busca, filtro, produtos]);

  const porCategoria = useMemo(() => {
    const idsVisiveis = new Set(produtosVisiveis.map((produto) => produto.id));
    return porCategoriaCompleto
      .map(([categoria, itens]) => [
        categoria,
        itens.filter((item) => idsVisiveis.has(item.id)),
      ] as [string, Produto[]])
      .filter(([, itens]) => itens.length > 0);
  }, [porCategoriaCompleto, produtosVisiveis]);

  const handleDragEndCategoria = (result: DropResult) => {
    if (!result.destination) return;
    const nova = [...categoriasEmUso];
    const [movida] = nova.splice(result.source.index, 1);
    nova.splice(result.destination.index, 0, movida);
    setOrdemCategorias(nova);
  };

  const definirDescricaoCategoria = (categoria: string, texto: string) => {
    setDescricoesCategorias((atual) => ({ ...atual, [categoria]: texto }));
  };

  const salvarOrdemCategorias = async () => {
    setSalvandoOrdem(true);
    try {
      // Só grava descrição de categorias que ainda existem (evita acumular
      // lixo de categorias renomeadas/excluídas no doc de configuração).
      const descricoes = Object.fromEntries(
        categoriasEmUso
          .map((categoria) => [categoria, (descricoesCategorias[categoria] ?? "").trim()])
          .filter(([, texto]) => texto !== "")
      );
      await setDoc(doc(db, "configuracoes", "categorias"), { ordem: categoriasEmUso, descricoes });
      addToast("Ordem das categorias salva!", "success");
    } catch (err) {
      console.error(err);
      addToast("Erro ao salvar a ordem das categorias.", "error");
    } finally {
      setSalvandoOrdem(false);
    }
  };

  const abrirNovo = () => {
    setEditingId(null);
    setForm(FORM_VAZIO);
    setIsModalOpen(true);
  };

  const abrirEdicao = (p: Produto) => {
    setEditingId(p.id!);
    setForm({
      nome: p.nome,
      descricao: p.descricao,
      preco: p.preco.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      categoria: p.categoria,
      imagemUrl: p.imagemUrl,
      disponivel: p.disponivel,
      esgotado: p.esgotado ?? false,
      tempoPreparo: p.tempoPreparoMinutos != null ? String(p.tempoPreparoMinutos) : "",
      friturasNoLocal: p.friturasNoLocal ?? false,
      dataHoraFritura: p.dataHoraFritura ?? "",
      localFritura: p.localFritura ?? "",
    });
    setIsModalOpen(true);
  };

  const handleSelecionarImagem = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      addToast("Selecione um arquivo de imagem.", "warning");
      return;
    }

    setUploadingImagem(true);
    try {
      const storage = await getStorageLazy();
      const storageRef = ref(storage, `produtos/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file, { contentType: file.type });
      const url = await getDownloadURL(storageRef);
      setForm((atual) => ({ ...atual, imagemUrl: url }));
    } catch (err) {
      console.error(err);
      addToast("Erro ao enviar imagem.", "error");
    } finally {
      setUploadingImagem(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const preco = precoParaNumero(form.preco);
    const produtoEmEdicao = produtos.find((produto) => produto.id === editingId);
    const editandoAgendamentoFritura = ehProdutoAgendamentoFritura(produtoEmEdicao);
    const precoInvalido = editandoAgendamentoFritura ? preco < 0 : preco <= 0;
    if (!form.nome || !form.categoria || precoInvalido) {
      addToast("Preencha nome, categoria e um preço válido.", "warning");
      return;
    }

    const tempoPreparoNum = form.tempoPreparo.trim() === "" ? null : Number(form.tempoPreparo);
    const payload = {
      nome: form.nome,
      descricao: form.descricao,
      preco,
      categoria: form.categoria,
      imagemUrl: form.imagemUrl,
      disponivel: form.disponivel,
      esgotado: form.esgotado,
      // null (não omitido) apaga um valor antigo quando o campo é limpo —
      // omitir deixaria o valor anterior "grudado" no updateDoc (merge implícito).
      tempoPreparoMinutos: tempoPreparoNum != null && tempoPreparoNum >= 0 ? tempoPreparoNum : null,
      friturasNoLocal: editandoAgendamentoFritura ? false : form.friturasNoLocal,
      dataHoraFritura: !editandoAgendamentoFritura && form.friturasNoLocal ? form.dataHoraFritura : null,
      localFritura: !editandoAgendamentoFritura && form.friturasNoLocal ? form.localFritura : null,
    };

    try {
      if (editingId) {
        await updateDoc(doc(db, "produtos", editingId), payload);
        addToast("Produto atualizado!", "success");
      } else {
        await addDoc(collection(db, "produtos"), payload);
        addToast("Produto cadastrado!", "success");
      }
      setIsModalOpen(false);
    } catch (err) {
      console.error(err);
      addToast("Erro ao salvar o produto.", "error");
    }
  };

  const toggleDisponivel = async (p: Produto) => {
    try {
      await updateDoc(doc(db, "produtos", p.id!), { disponivel: !p.disponivel });
    } catch (err) {
      console.error(err);
      addToast("Erro ao atualizar disponibilidade.", "error");
    }
  };

  const toggleEsgotado = async (p: Produto) => {
    try {
      await updateDoc(doc(db, "produtos", p.id!), { esgotado: !p.esgotado });
    } catch (err) {
      console.error(err);
      addToast("Erro ao atualizar estoque.", "error");
    }
  };

  const confirmDelete = (id: string) => {
    if (id === PRODUTO_AGENDAMENTO_FRITURA_ID) {
      addToast("Este item faz parte do sistema e não pode ser excluído.", "warning");
      return;
    }
    setProdutoToDelete(id);
    setIsDeleteModalOpen(true);
  };

  const executeDelete = async () => {
    if (!produtoToDelete) return;
    if (produtoToDelete === PRODUTO_AGENDAMENTO_FRITURA_ID) {
      addToast("Este item faz parte do sistema e não pode ser excluído.", "warning");
      setIsDeleteModalOpen(false);
      setProdutoToDelete(null);
      return;
    }
    try {
      await deleteDoc(doc(db, "produtos", produtoToDelete));
      addToast("Produto removido.", "info");
      setIsDeleteModalOpen(false);
      setProdutoToDelete(null);
    } catch (err) {
      console.error(err);
      addToast("Erro ao remover produto.", "error");
    }
  };

  return (
    <div className="produtos-container fade-in">
      {produtos.length > 0 && (
        <div className="produtos-toolbar">
          <label className="produtos-busca">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={busca}
              onChange={(event) => setBusca(event.target.value)}
              placeholder="Buscar no cardápio"
              aria-label="Buscar produto por nome, descrição ou categoria"
            />
            {busca && (
              <button type="button" onClick={() => setBusca("")} aria-label="Limpar busca">
                <Close size={18} />
              </button>
            )}
          </label>

          <div className="produtos-filtros" role="group" aria-label="Filtrar produtos">
            <button
              type="button"
              className={filtro === "todos" ? "active" : ""}
              onClick={() => setFiltro("todos")}
              aria-pressed={filtro === "todos"}
            >
              Todos <span>{produtos.length}</span>
            </button>
            <button
              type="button"
              className={filtro === "disponiveis" ? "active" : ""}
              onClick={() => setFiltro("disponiveis")}
              aria-pressed={filtro === "disponiveis"}
            >
              Disponíveis <span>{produtosDisponiveis}</span>
            </button>
            <button
              type="button"
              className={filtro === "indisponiveis" ? "active" : ""}
              onClick={() => setFiltro("indisponiveis")}
              aria-pressed={filtro === "indisponiveis"}
            >
              Indisponíveis <span>{produtos.length - produtosDisponiveis}</span>
            </button>
          </div>

          <div className="produtos-toolbar-actions">
            {categoriasEmUso.length > 0 && (
              <button
                type="button"
                className={`produtos-organizar${mostrarOrganizacao ? " active" : ""}`}
                onClick={() => setMostrarOrganizacao((atual) => !atual)}
                aria-pressed={mostrarOrganizacao}
              >
                <ArrowsMove size={14} /> Organizar categorias
              </button>
            )}
            <button className="btn btn-primary produtos-novo" onClick={abrirNovo}>
              <PlusCircleFill size={17} /> Novo produto
            </button>
          </div>
        </div>
      )}

      {categoriasEmUso.length > 0 && mostrarOrganizacao && (
        <div className="produtos-ordem-categorias">
          <div className="produtos-ordem-categorias-topo">
            <h3>Categorias do cardápio</h3>
            <button className="btn btn-secondary" onClick={salvarOrdemCategorias} disabled={salvandoOrdem}>
              {salvandoOrdem ? "Salvando..." : "Salvar"}
            </button>
          </div>
          <DragDropContext onDragEnd={handleDragEndCategoria}>
            <Droppable droppableId="categorias">
              {(provided) => (
                <div className="produtos-ordem-lista" ref={provided.innerRef} {...provided.droppableProps}>
                  {categoriasEmUso.map((categoria, index) => (
                    <Draggable key={categoria} draggableId={categoria} index={index}>
                      {(providedItem) => (
                        <div
                          className="produtos-ordem-item"
                          ref={providedItem.innerRef}
                          {...providedItem.draggableProps}
                        >
                          <span className="produtos-ordem-item-nome" {...providedItem.dragHandleProps}>
                            <ArrowsMove size={14} />
                            {categoria}
                          </span>
                          <input
                            type="text"
                            className="produtos-ordem-item-texto"
                            value={descricoesCategorias[categoria] ?? ""}
                            onChange={(e) => definirDescricaoCategoria(categoria, e.target.value)}
                            placeholder="Texto da seção (opcional) — ex.: Feitos na hora, crocantes por fora"
                          />
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        </div>
      )}

      {produtos.length === 0 ? (
        <div className="produtos-empty fade-in">
          <div className="produtos-empty-icon">
            <Basket2 size={28} />
          </div>
          <p>Nenhum produto cadastrado ainda.<br />Cadastre o primeiro item do cardápio.</p>
          <button className="btn btn-primary" onClick={abrirNovo}>
            <PlusCircleFill size={17} /> Novo produto
          </button>
        </div>
      ) : produtosVisiveis.length === 0 ? (
        <div className="produtos-empty produtos-empty-search fade-in">
          <div className="produtos-empty-icon">
            <Search size={25} />
          </div>
          <p>Nenhum produto corresponde à busca ou ao filtro selecionado.</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setBusca("");
              setFiltro("todos");
            }}
          >
            Limpar filtros
          </button>
        </div>
      ) : (
        porCategoria.map(([categoria, itens]) => (
          <div key={categoria} className="produtos-categoria">
            <h3 className="produtos-categoria-titulo">{categoria}</h3>
            {descricoesCategorias[categoria] && (
              <p className="produtos-categoria-texto">{descricoesCategorias[categoria]}</p>
            )}
            <div className="produtos-grid">
              {itens.map((p) => (
                <div key={p.id} className={`produto-card${p.disponivel ? "" : " indisponivel"}${p.esgotado ? " esgotado" : ""}${ehProdutoAgendamentoFritura(p) ? " produto-card-sistema" : ""}`}>
                  <div className="produto-card-imagem">
                    {p.imagemUrl ? (
                      <img src={p.imagemUrl} alt={p.nome} loading="lazy" />
                    ) : (
                      <Basket2 size={24} />
                    )}
                    {!p.disponivel && (
                      <span className="produto-badge-indisponivel">
                        <EyeSlash size={12} /> Indisponível
                      </span>
                    )}
                    {p.disponivel && p.esgotado && (
                      <span className="produto-badge-esgotado">
                        <SlashCircle size={12} /> Esgotado
                      </span>
                    )}
                    {ehProdutoAgendamentoFritura(p) && (
                      <span className="produto-badge-sistema">
                        <ShieldCheck size={12} /> Item do sistema
                      </span>
                    )}
                  </div>
                  <div className="produto-card-info">
                    <h4>{p.nome}</h4>
                    {p.descricao && <p className="produto-descricao">{p.descricao}</p>}
                    <span className="produto-preco">R$ {p.preco.toFixed(2).replace(".", ",")}</span>
                    {p.friturasNoLocal && (
                      <div className="produto-fritura-info">
                        {p.dataHoraFritura && (
                          <span><CalendarEvent size={11} /> {formatarDataHoraFritura(p.dataHoraFritura)}</span>
                        )}
                        {p.localFritura && (
                          <span><GeoAlt size={11} /> {p.localFritura}</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="produto-card-actions">
                    <div className="produto-status-controls">
                      <label className="produto-toggle">
                        <input
                          type="checkbox"
                          checked={p.disponivel}
                          onChange={() => toggleDisponivel(p)}
                        />
                        <span>Disponível</span>
                      </label>
                      <label className="produto-toggle">
                        <input
                          type="checkbox"
                          checked={!!p.esgotado}
                          onChange={() => toggleEsgotado(p)}
                        />
                        <span>Esgotado</span>
                      </label>
                    </div>
                    <div className="action-buttons-group">
                      <button
                        className="btn-icon-action"
                        title="Editar produto"
                        aria-label={`Editar ${p.nome}`}
                        onClick={() => abrirEdicao(p)}
                      >
                        <PencilFill size={16} />
                      </button>
                      {!ehProdutoAgendamentoFritura(p) && (
                        <button
                          className="btn-icon-action btn-trash"
                          title="Excluir produto"
                          aria-label={`Excluir ${p.nome}`}
                          onClick={() => confirmDelete(p.id!)}
                        >
                          <Trash size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {/* ─── MODAL DE CADASTRO/EDIÇÃO ─── */}
      <ModalBase
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId === PRODUTO_AGENDAMENTO_FRITURA_ID ? "Editar item do sistema" : editingId ? "Editar Produto" : "Novo Produto"}
      >
        <form onSubmit={handleSave} className="produto-form">
          {editingId === PRODUTO_AGENDAMENTO_FRITURA_ID && (
            <div className="produto-sistema-notice">
              <ShieldCheck size={18} />
              <div>
                <strong>Item permanente</strong>
                <span>Você pode editar normalmente, mas ele não pode ser excluído ou duplicado.</span>
              </div>
            </div>
          )}
          <div className="form-group">
            <label>Nome do Produto</label>
            <input
              type="text"
              value={form.nome}
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
              placeholder="Ex: Coxinha de Frango"
              required
              autoFocus
            />
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label>Categoria</label>
              <CategoriaAutocomplete
                value={form.categoria}
                categorias={categoriasEmUso}
                onChange={(categoria) => setForm({ ...form, categoria })}
              />
            </div>
            <div className="form-group">
              <label>Preço</label>
              <div className="input-with-prefix">
                <span className="input-prefix">R$</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.preco}
                  onChange={(e) => setForm({ ...form, preco: formatarCentavos(e.target.value) })}
                  placeholder="0,00"
                  required
                />
              </div>
            </div>
          </div>

          <div className="form-group">
            <label>Tempo de preparo <span className="label-optional">(Opcional)</span></label>
            <div className="input-with-suffix">
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={form.tempoPreparo}
                onChange={(e) => setForm({ ...form, tempoPreparo: e.target.value })}
                placeholder="Ex: 5 (em branco = tempo padrão)"
              />
              <span className="input-suffix">min</span>
            </div>
          </div>

          {editingId !== PRODUTO_AGENDAMENTO_FRITURA_ID && (
            <>
              <div className="form-group form-group-checkbox">
                <label className="produto-toggle">
                  <input
                    type="checkbox"
                    checked={form.friturasNoLocal}
                    onChange={(e) => setForm({ ...form, friturasNoLocal: e.target.checked })}
                  />
                  <span>Fritura no local (evento com data e endereço)</span>
                </label>
              </div>

              {form.friturasNoLocal && (
                <div className="form-grid">
                  <div className="form-group">
                    <label>
                      <CalendarEvent size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                      Data e hora aproximada
                    </label>
                    <input
                      type="datetime-local"
                      value={form.dataHoraFritura}
                      onChange={(e) => setForm({ ...form, dataHoraFritura: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>
                      <GeoAlt size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                      Local <span className="label-optional">(Opcional)</span>
                    </label>
                    <input
                      type="text"
                      value={form.localFritura}
                      onChange={(e) => setForm({ ...form, localFritura: e.target.value })}
                      placeholder="Ex: Praça Central, em frente à igreja"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          <div className="form-group">
            <label>Descrição <span className="label-optional">(Opcional)</span></label>
            <textarea
              rows={2}
              value={form.descricao}
              onChange={(e) => setForm({ ...form, descricao: e.target.value })}
              placeholder="Ex: Massa crocante com recheio cremoso de frango"
            />
          </div>

          <div className="form-group">
            <label>Imagem <span className="label-optional">(Opcional)</span></label>
            <div className="produto-imagem-upload">
              <div className="produto-imagem-preview">
                {form.imagemUrl ? (
                  <img src={form.imagemUrl} alt="Prévia do produto" />
                ) : (
                  <Basket2 size={20} />
                )}
              </div>
              <div className="produto-imagem-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingImagem}
                >
                  <Upload size={14} />
                  {uploadingImagem ? "Enviando..." : form.imagemUrl ? "Trocar imagem" : "Escolher do computador"}
                </button>
                {form.imagemUrl && !uploadingImagem && (
                  <button
                    type="button"
                    className="produto-imagem-remover"
                    onClick={() => setForm({ ...form, imagemUrl: "" })}
                  >
                    Remover
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleSelecionarImagem}
                style={{ display: "none" }}
              />
            </div>
          </div>

          <div className="form-group form-group-checkbox">
            <label className="produto-toggle">
              <input
                type="checkbox"
                checked={form.disponivel}
                onChange={(e) => setForm({ ...form, disponivel: e.target.checked })}
              />
              <span>Disponível no cardápio</span>
            </label>
            <label className="produto-toggle">
              <input
                type="checkbox"
                checked={form.esgotado}
                onChange={(e) => setForm({ ...form, esgotado: e.target.checked })}
              />
              <span>Esgotado (aparece no cardápio, mas não dá pra comprar)</span>
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-confirm" disabled={uploadingImagem}>
              {editingId ? "Salvar Alterações" : "Cadastrar Produto"}
            </button>
          </div>
        </form>
      </ModalBase>

      {/* ─── MODAL DE EXCLUSÃO ─── */}
      <ModalBase isOpen={isDeleteModalOpen} onClose={() => setIsDeleteModalOpen(false)} title="Excluir Produto">
        <div style={{ textAlign: "center", padding: "16px 0" }}>
          <div style={{ width: "56px", height: "56px", borderRadius: "50%", backgroundColor: "rgba(225, 29, 72, 0.1)", color: "var(--sys-color-danger)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px auto" }}>
            <Trash size={28} />
          </div>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "1.2rem", color: "var(--sys-color-text-main)" }}>Tem certeza?</h3>
          <p style={{ margin: 0, color: "var(--sys-color-text-muted)", fontSize: "0.95rem" }}>
            Esta ação remove o produto permanentemente do cardápio.
          </p>
        </div>
        <div className="modal-buttons" style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
          <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setIsDeleteModalOpen(false)}>
            Voltar
          </button>
          <button type="button" className="btn btn-primary" style={{ flex: 1, backgroundColor: "var(--sys-color-danger)" }} onClick={executeDelete}>
            Sim, Excluir
          </button>
        </div>
      </ModalBase>
    </div>
  );
}
