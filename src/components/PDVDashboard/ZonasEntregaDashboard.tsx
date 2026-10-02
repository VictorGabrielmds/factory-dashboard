// src/components/PDVDashboard/ZonasEntregaDashboard.tsx
import { useEffect, useMemo, useState } from "react";
import "./ZonasEntregaDashboard.css";
import { db, collection, onSnapshot, query, setDoc, updateDoc, deleteDoc, doc, getDoc } from "../../services/firebase";
import ModalBase from "../ModalBase/ModalBase";
import {
  BsPlusCircleFill as PlusCircleFill,
  BsPencilFill as PencilFill,
  BsTrash as Trash,
  BsGeoAltFill as GeoAltFill,
  BsSearch as Search,
  BsX as Close,
} from "react-icons/bs";
import { useToast } from "../../contexts/ToastContext";
import type { ZonaEntrega } from "../../types/ZonaEntrega";

const FORM_VAZIO = { bairro: "", taxa: "", tempoEntrega: "", ativo: true };

// Mesma máscara de centavos usada em Produtos/Cupons — cada admin é
// independente (sem abstração compartilhada só pra ~5 linhas puras).
function formatarCentavos(valorDigitado: string): string {
  const digits = valorDigitado.replace(/\D/g, "");
  const centavos = parseInt(digits || "0", 10);
  return (centavos / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function precoParaNumero(precoFormatado: string): number {
  return parseFloat(precoFormatado.replace(/\./g, "").replace(",", ".")) || 0;
}

// Mesma normalização usada em criarPedido (functions/src/cliente/pedidos.js)
// pra buscar a taxa a partir do bairro que vem do endereço do cliente.
function normalizarBairro(bairro: string): string {
  return bairro
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export default function ZonasEntregaDashboard() {
  const { addToast } = useToast();
  const [zonas, setZonas] = useState<ZonaEntrega[]>([]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(FORM_VAZIO);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [zonaToDelete, setZonaToDelete] = useState<string | null>(null);

  const [taxaPadrao, setTaxaPadrao] = useState("0,00");
  const [tempoEntregaPadrao, setTempoEntregaPadrao] = useState("");
  const [salvandoPadroes, setSalvandoPadroes] = useState(false);
  const [busca, setBusca] = useState("");

  useEffect(() => {
    const q = query(collection(db, "zonas_entrega"));
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as ZonaEntrega))
        .sort((a, b) => a.bairro.localeCompare(b.bairro));
      setZonas(data);
    });
    return () => unsub();
  }, []);

  const zonasFiltradas = useMemo(() => {
    const termo = normalizarBairro(busca);
    if (!termo) return zonas;
    return zonas.filter((zona) => normalizarBairro(zona.bairro).includes(termo));
  }, [busca, zonas]);

  useEffect(() => {
    getDoc(doc(db, "configuracoes", "entrega")).then((snap) => {
      const dados = snap.data();
      const valor = dados?.taxaPadrao;
      if (typeof valor === "number") {
        setTaxaPadrao(valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      }
      const tempo = dados?.tempoEntregaPadraoMinutos;
      if (typeof tempo === "number") {
        setTempoEntregaPadrao(String(tempo));
      }
    });
  }, []);

  const salvarPadroes = async () => {
    setSalvandoPadroes(true);
    try {
      const payload = {
        taxaPadrao: precoParaNumero(taxaPadrao),
        tempoEntregaPadraoMinutos: Number(tempoEntregaPadrao) || 0,
      };
      await updateDoc(doc(db, "configuracoes", "entrega"), payload).catch(
        // updateDoc falha se o doc ainda não existe — cria na primeira vez.
        () => setDoc(doc(db, "configuracoes", "entrega"), payload)
      );
      addToast("Padrões de entrega salvos!", "success");
    } catch (err) {
      console.error(err);
      addToast("Erro ao salvar padrões de entrega.", "error");
    } finally {
      setSalvandoPadroes(false);
    }
  };

  const abrirNovo = () => {
    setEditingId(null);
    setForm(FORM_VAZIO);
    setIsModalOpen(true);
  };

  const abrirEdicao = (z: ZonaEntrega) => {
    setEditingId(z.id!);
    setForm({
      bairro: z.bairro,
      taxa: z.taxa.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      tempoEntrega: z.tempoEntregaMinutos != null ? String(z.tempoEntregaMinutos) : "",
      ativo: z.ativo,
    });
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const bairro = form.bairro.trim();
    const taxa = precoParaNumero(form.taxa);
    if (!bairro || taxa < 0) {
      addToast("Preencha o bairro e uma taxa válida.", "warning");
      return;
    }

    const id = normalizarBairro(bairro);
    // Campo omitido (não "0") quando em branco — deixa o bairro cair no
    // tempo padrão em vez de travar em "0 min" por engano.
    const payload = {
      bairro,
      taxa,
      ativo: form.ativo,
      ...(form.tempoEntrega.trim() !== "" ? { tempoEntregaMinutos: Number(form.tempoEntrega) } : {}),
    };

    try {
      await setDoc(doc(db, "zonas_entrega", id), payload);
      addToast(editingId ? "Bairro atualizado!" : "Bairro cadastrado!", "success");
      setIsModalOpen(false);
    } catch (err) {
      console.error(err);
      addToast("Erro ao salvar o bairro.", "error");
    }
  };

  const toggleAtivo = async (z: ZonaEntrega) => {
    try {
      await updateDoc(doc(db, "zonas_entrega", z.id!), { ativo: !z.ativo });
    } catch (err) {
      console.error(err);
      addToast("Erro ao atualizar o bairro.", "error");
    }
  };

  const confirmDelete = (id: string) => {
    setZonaToDelete(id);
    setIsDeleteModalOpen(true);
  };

  const executeDelete = async () => {
    if (!zonaToDelete) return;
    try {
      await deleteDoc(doc(db, "zonas_entrega", zonaToDelete));
      addToast("Bairro removido.", "info");
      setIsDeleteModalOpen(false);
      setZonaToDelete(null);
    } catch (err) {
      console.error(err);
      addToast("Erro ao remover bairro.", "error");
    }
  };

  return (
    <div className="zonas-container fade-in">
      <div className="pdv-page-header">
        <div>
          <h1>Áreas de entrega</h1>
          <p>{zonas.length} {zonas.length === 1 ? "bairro cadastrado" : "bairros cadastrados"}</p>
        </div>
        <button className="btn btn-primary" onClick={abrirNovo}>
          <PlusCircleFill size={17} /> Novo bairro
        </button>
      </div>

      <div className="zonas-taxa-padrao">
        <div>
          <h3>Padrões de entrega</h3>
          <p>
            Taxa: usada quando o bairro não está na lista abaixo. Tempo: só entra se o bairro não
            tiver um valor manual nem estimativa automática por distância.
          </p>
        </div>
        <div className="zonas-padroes-campos">
          <div className="input-with-prefix">
            <span className="input-prefix">R$</span>
            <input
              type="text"
              inputMode="numeric"
              value={taxaPadrao}
              onChange={(e) => setTaxaPadrao(formatarCentavos(e.target.value))}
            />
          </div>
          <div className="input-with-suffix">
            <input
              type="number"
              min="0"
              inputMode="numeric"
              value={tempoEntregaPadrao}
              onChange={(e) => setTempoEntregaPadrao(e.target.value)}
              placeholder="0"
            />
            <span className="input-suffix">min</span>
          </div>
        </div>
        <button className="btn btn-secondary" onClick={salvarPadroes} disabled={salvandoPadroes}>
          {salvandoPadroes ? "Salvando..." : "Salvar"}
        </button>
      </div>

      <section className="zonas-lista-shell" aria-label="Bairros atendidos">
        <div className="zonas-lista-toolbar">
          <label className="zonas-busca">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={busca}
              onChange={(event) => setBusca(event.target.value)}
              placeholder="Buscar bairro"
              aria-label="Buscar bairro"
            />
            {busca && (
              <button type="button" onClick={() => setBusca("")} aria-label="Limpar busca">
                <Close size={18} />
              </button>
            )}
          </label>
          <span className="zonas-lista-count">
            {zonasFiltradas.length} {zonasFiltradas.length === 1 ? "bairro" : "bairros"}
          </span>
        </div>

        {zonas.length === 0 ? (
          <div className="zonas-empty fade-in">
            <div className="zonas-empty-icon">
              <GeoAltFill size={28} />
            </div>
            <p>Nenhum bairro cadastrado ainda — todo delivery usa a taxa padrão.</p>
          </div>
        ) : zonasFiltradas.length === 0 ? (
          <div className="zonas-empty zonas-empty-search fade-in">
            <div className="zonas-empty-icon">
              <Search size={24} />
            </div>
            <p>Nenhum bairro encontrado para “{busca}”.</p>
            <button type="button" className="btn btn-secondary" onClick={() => setBusca("")}>
              Limpar busca
            </button>
          </div>
        ) : (
          <div className="zonas-lista" role="table" aria-label="Lista de bairros e taxas">
            <div className="zonas-lista-header" role="row">
              <span role="columnheader">Bairro</span>
              <span role="columnheader">Taxa</span>
              <span role="columnheader">Prazo</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" aria-label="Ações" />
            </div>
            {zonasFiltradas.map((z) => (
              <div
                key={z.id}
                className={`zona-lista-item${z.ativo ? "" : " indisponivel"}`}
                role="row"
              >
                <div className="zona-lista-bairro" role="cell" data-label="Bairro">
                  <span className="zona-lista-pin"><GeoAltFill size={13} /></span>
                  <strong>{z.bairro}</strong>
                  {!z.ativo && <span className="zona-badge-inativo">Inativo</span>}
                </div>
                <span className="zona-lista-taxa" role="cell" data-label="Taxa">
                  R$ {z.taxa.toFixed(2).replace(".", ",")}
                </span>
                <span className="zona-lista-tempo" role="cell" data-label="Prazo">
                  {z.tempoEntregaMinutos != null ? `${z.tempoEntregaMinutos} min` : "Automático"}
                </span>
                <label className="produto-toggle zona-lista-status" role="cell" data-label="Status">
                  <input type="checkbox" checked={z.ativo} onChange={() => toggleAtivo(z)} />
                  <span>{z.ativo ? "Ativo" : "Inativo"}</span>
                </label>
                <div className="zona-lista-acoes" role="cell">
                  <button
                    className="btn-icon-action"
                    title="Editar bairro"
                    aria-label={`Editar ${z.bairro}`}
                    onClick={() => abrirEdicao(z)}
                  >
                    <PencilFill size={15} />
                  </button>
                  <button
                    className="btn-icon-action btn-trash"
                    title="Excluir bairro"
                    aria-label={`Excluir ${z.bairro}`}
                    onClick={() => confirmDelete(z.id!)}
                  >
                    <Trash size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ─── MODAL DE CADASTRO/EDIÇÃO ─── */}
      <ModalBase isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? "Editar Bairro" : "Novo Bairro"}>
        <form onSubmit={handleSave} className="zona-form">
          <div className="form-group">
            <label>Bairro</label>
            <input
              type="text"
              value={form.bairro}
              onChange={(e) => setForm({ ...form, bairro: e.target.value })}
              placeholder="Ex: Centro"
              disabled={!!editingId}
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>Taxa de entrega</label>
            <div className="input-with-prefix">
              <span className="input-prefix">R$</span>
              <input
                type="text"
                inputMode="numeric"
                value={form.taxa}
                onChange={(e) => setForm({ ...form, taxa: formatarCentavos(e.target.value) })}
                placeholder="0,00"
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label>Tempo de entrega (min)</label>
            <input
              type="number"
              min="0"
              inputMode="numeric"
              value={form.tempoEntrega}
              onChange={(e) => setForm({ ...form, tempoEntrega: e.target.value })}
              placeholder="Ex: 35 (em branco = estimativa por distância da loja)"
            />
          </div>

          <div className="form-group form-group-checkbox">
            <label className="produto-toggle">
              <input
                type="checkbox"
                checked={form.ativo}
                onChange={(e) => setForm({ ...form, ativo: e.target.checked })}
              />
              <span>Bairro ativo</span>
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-confirm">
              {editingId ? "Salvar Alterações" : "Cadastrar Bairro"}
            </button>
          </div>
        </form>
      </ModalBase>

      {/* ─── MODAL DE EXCLUSÃO ─── */}
      <ModalBase isOpen={isDeleteModalOpen} onClose={() => setIsDeleteModalOpen(false)} title="Excluir Bairro">
        <div style={{ textAlign: "center", padding: "16px 0" }}>
          <div style={{ width: "56px", height: "56px", borderRadius: "50%", backgroundColor: "rgba(225, 29, 72, 0.1)", color: "var(--sys-color-danger)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px auto" }}>
            <Trash size={28} />
          </div>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "1.2rem", color: "var(--sys-color-text-main)" }}>Tem certeza?</h3>
          <p style={{ margin: 0, color: "var(--sys-color-text-muted)", fontSize: "0.95rem" }}>
            O bairro removido passa a usar a taxa padrão.
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
