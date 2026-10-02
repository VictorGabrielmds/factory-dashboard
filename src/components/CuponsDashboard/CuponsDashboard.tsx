// src/components/CuponsDashboard/CuponsDashboard.tsx
import { useEffect, useState } from "react";
import "./CuponsDashboard.css";
import { db, collection, onSnapshot, query, setDoc, updateDoc, deleteDoc, doc, Timestamp } from "../../services/firebase";
import ModalBase from "../ModalBase/ModalBase";
import {
  BsPlusCircleFill as PlusCircleFill,
  BsPencilFill as PencilFill,
  BsTrash as Trash,
  BsTicketPerforated as TicketPerforated,
} from "react-icons/bs";
import { useToast } from "../../contexts/ToastContext";
import type { Cupom } from "../../types/Cupom";

const FORM_VAZIO = {
  codigo: "",
  tipo: "fixo" as "fixo" | "percentual",
  valor: "",
  expiraEm: "",
  limiteUsos: "",
  ativo: true,
};

// Mesma máscara de centavos do ProdutosDashboard — cada campo de admin é
// independente (sem abstração compartilhada só pra ~5 linhas puras).
function formatarCentavos(valorDigitado: string): string {
  const digits = valorDigitado.replace(/\D/g, "");
  const centavos = parseInt(digits || "0", 10);
  return (centavos / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function precoParaNumero(precoFormatado: string): number {
  return parseFloat(precoFormatado.replace(/\./g, "").replace(",", ".")) || 0;
}

function formatarData(ts: Timestamp | null): string {
  if (!ts) return "";
  return ts.toDate().toISOString().slice(0, 10);
}

export default function CuponsDashboard() {
  const { addToast } = useToast();
  const [cupons, setCupons] = useState<Cupom[]>([]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(FORM_VAZIO);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [cupomToDelete, setCupomToDelete] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, "cupons"));
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as Cupom))
        .sort((a, b) => a.codigo.localeCompare(b.codigo));
      setCupons(data);
    });
    return () => unsub();
  }, []);

  const abrirNovo = () => {
    setEditingId(null);
    setForm(FORM_VAZIO);
    setIsModalOpen(true);
  };

  const abrirEdicao = (c: Cupom) => {
    setEditingId(c.id!);
    setForm({
      codigo: c.codigo,
      tipo: c.tipo,
      valor:
        c.tipo === "fixo"
          ? c.valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : String(c.valor),
      expiraEm: formatarData(c.expiraEm),
      limiteUsos: c.limiteUsos != null ? String(c.limiteUsos) : "",
      ativo: c.ativo,
    });
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const codigo = form.codigo.trim().toUpperCase();
    const valor = form.tipo === "fixo" ? precoParaNumero(form.valor) : parseFloat(form.valor);

    if (!codigo || !Number.isFinite(valor) || valor <= 0) {
      addToast("Preencha código e um valor válido.", "warning");
      return;
    }
    if (form.tipo === "percentual" && valor > 100) {
      addToast("Percentual não pode passar de 100.", "warning");
      return;
    }

    const payload = {
      codigo,
      tipo: form.tipo,
      valor,
      ativo: form.ativo,
      expiraEm: form.expiraEm ? Timestamp.fromDate(new Date(`${form.expiraEm}T23:59:59`)) : null,
      limiteUsos: form.limiteUsos ? parseInt(form.limiteUsos, 10) : null,
    };

    try {
      if (editingId) {
        await updateDoc(doc(db, "cupons", editingId), payload);
        addToast("Cupom atualizado!", "success");
      } else {
        // codigo É o id do documento — evita ambiguidade de maiúsculas/
        // minúsculas na validação (validarCupom normaliza do mesmo jeito).
        await setDoc(doc(db, "cupons", codigo), { ...payload, usosCount: 0 });
        addToast("Cupom cadastrado!", "success");
      }
      setIsModalOpen(false);
    } catch (err) {
      console.error(err);
      addToast("Erro ao salvar o cupom.", "error");
    }
  };

  const toggleAtivo = async (c: Cupom) => {
    try {
      await updateDoc(doc(db, "cupons", c.id!), { ativo: !c.ativo });
    } catch (err) {
      console.error(err);
      addToast("Erro ao atualizar o cupom.", "error");
    }
  };

  const confirmDelete = (id: string) => {
    setCupomToDelete(id);
    setIsDeleteModalOpen(true);
  };

  const executeDelete = async () => {
    if (!cupomToDelete) return;
    try {
      await deleteDoc(doc(db, "cupons", cupomToDelete));
      addToast("Cupom removido.", "info");
      setIsDeleteModalOpen(false);
      setCupomToDelete(null);
    } catch (err) {
      console.error(err);
      addToast("Erro ao remover cupom.", "error");
    }
  };

  const descreverValor = (c: Cupom) =>
    c.tipo === "fixo"
      ? `R$ ${c.valor.toFixed(2).replace(".", ",")} de desconto`
      : `${c.valor}% de desconto`;

  return (
    <div className="cupons-container fade-in">
      <div className="pdv-page-header">
        <div>
          <h1>Cupons</h1>
          <p>{cupons.length} {cupons.length === 1 ? "cupom cadastrado" : "cupons cadastrados"}</p>
        </div>
        <button className="btn btn-primary" onClick={abrirNovo}>
          <PlusCircleFill size={17} /> Novo cupom
        </button>
      </div>

      {cupons.length === 0 ? (
        <div className="cupons-empty fade-in">
          <div className="cupons-empty-icon">
            <TicketPerforated size={28} />
          </div>
          <p>Nenhum cupom cadastrado ainda.</p>
        </div>
      ) : (
        <div className="cupons-grid">
          {cupons.map((c) => (
            <div key={c.id} className={`cupom-card${c.ativo ? "" : " indisponivel"}`}>
              <div className="cupom-card-topo">
                <span className="cupom-codigo">{c.codigo}</span>
                {!c.ativo && <span className="cupom-badge-inativo">Inativo</span>}
              </div>
              <span className="cupom-valor">{descreverValor(c)}</span>
              <div className="cupom-detalhes">
                {c.expiraEm && <span>Expira em {formatarData(c.expiraEm).split("-").reverse().join("/")}</span>}
                <span>
                  Usos: {c.usosCount}
                  {c.limiteUsos != null ? ` / ${c.limiteUsos}` : " (ilimitado)"}
                </span>
              </div>
              <div className="cupom-card-actions">
                <label className="produto-toggle">
                  <input type="checkbox" checked={c.ativo} onChange={() => toggleAtivo(c)} />
                  <span>Ativo</span>
                </label>
                <div className="action-buttons-group">
                  <button className="btn-icon-action" title="Editar" onClick={() => abrirEdicao(c)}>
                    <PencilFill size={16} />
                  </button>
                  <button className="btn-icon-action btn-trash" title="Excluir" onClick={() => confirmDelete(c.id!)}>
                    <Trash size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── MODAL DE CADASTRO/EDIÇÃO ─── */}
      <ModalBase isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? "Editar Cupom" : "Novo Cupom"}>
        <form onSubmit={handleSave} className="cupom-form">
          <div className="form-group">
            <label>Código</label>
            <input
              type="text"
              value={form.codigo}
              onChange={(e) => setForm({ ...form, codigo: e.target.value.toUpperCase() })}
              placeholder="Ex: BEMVINDO10"
              disabled={!!editingId}
              required
              autoFocus
            />
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label>Tipo</label>
              <select
                value={form.tipo}
                onChange={(e) => setForm({ ...form, tipo: e.target.value as "fixo" | "percentual", valor: "" })}
              >
                <option value="fixo">Valor fixo (R$)</option>
                <option value="percentual">Percentual (%)</option>
              </select>
            </div>
            <div className="form-group">
              <label>Valor</label>
              {form.tipo === "fixo" ? (
                <div className="input-with-prefix">
                  <span className="input-prefix">R$</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={form.valor}
                    onChange={(e) => setForm({ ...form, valor: formatarCentavos(e.target.value) })}
                    placeholder="0,00"
                    required
                  />
                </div>
              ) : (
                <div className="input-with-suffix">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={form.valor}
                    onChange={(e) => setForm({ ...form, valor: e.target.value })}
                    placeholder="10"
                    required
                  />
                  <span className="input-suffix">%</span>
                </div>
              )}
            </div>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label>Validade <span className="label-optional">(Opcional)</span></label>
              <input
                type="date"
                value={form.expiraEm}
                onChange={(e) => setForm({ ...form, expiraEm: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Limite de usos <span className="label-optional">(Opcional)</span></label>
              <input
                type="number"
                min={1}
                value={form.limiteUsos}
                onChange={(e) => setForm({ ...form, limiteUsos: e.target.value })}
                placeholder="Ilimitado"
              />
            </div>
          </div>

          <div className="form-group form-group-checkbox">
            <label className="produto-toggle">
              <input
                type="checkbox"
                checked={form.ativo}
                onChange={(e) => setForm({ ...form, ativo: e.target.checked })}
              />
              <span>Cupom ativo</span>
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-confirm">
              {editingId ? "Salvar Alterações" : "Cadastrar Cupom"}
            </button>
          </div>
        </form>
      </ModalBase>

      {/* ─── MODAL DE EXCLUSÃO ─── */}
      <ModalBase isOpen={isDeleteModalOpen} onClose={() => setIsDeleteModalOpen(false)} title="Excluir Cupom">
        <div style={{ textAlign: "center", padding: "16px 0" }}>
          <div style={{ width: "56px", height: "56px", borderRadius: "50%", backgroundColor: "rgba(225, 29, 72, 0.1)", color: "var(--sys-color-danger)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px auto" }}>
            <Trash size={28} />
          </div>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "1.2rem", color: "var(--sys-color-text-main)" }}>Tem certeza?</h3>
          <p style={{ margin: 0, color: "var(--sys-color-text-muted)", fontSize: "0.95rem" }}>
            Esta ação remove o cupom permanentemente.
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
