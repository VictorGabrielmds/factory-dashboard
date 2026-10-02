import { useCallback, useEffect, useRef, useState } from "react";
import {
  MdBlock,
  MdClose,
  MdLockOpen,
  MdManageAccounts,
  MdSearch,
} from "react-icons/md";
import { useToast } from "../../contexts/ToastContext";
import { apiFetch, BASE_URL } from "../../services/api";
import { toTitleCase } from "../../utils/dateUtils";
import "./ClientesBloqueioDashboard.css";

type ClienteAcesso = {
  telefone: string;
  nome: string;
  pedidosBloqueados: boolean;
};

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  const national = digits.startsWith("55") ? digits.slice(2) : digits;
  if (national.length === 11) {
    return `(${national.slice(0, 2)}) ${national.slice(2, 7)}-${national.slice(7)}`;
  }
  if (national.length === 10) {
    return `(${national.slice(0, 2)}) ${national.slice(2, 6)}-${national.slice(6)}`;
  }
  return value;
}

export default function ClientesBloqueioDashboard() {
  const { addToast } = useToast();
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<ClienteAcesso[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingPhone, setUpdatingPhone] = useState<string | null>(null);
  const [confirmingPhone, setConfirmingPhone] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadCustomers = useCallback(async (term: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const response = await apiFetch(`${BASE_URL}/clientes`, {
        method: "POST",
        body: JSON.stringify({
          action: term ? "buscar" : "listarBloqueados",
          ...(term ? { termo: term } : {}),
        }),
      });
      const payload = await response.json().catch(() => null) as {
        error?: string;
        clientes?: ClienteAcesso[];
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error || "Não foi possível carregar os clientes.");
      }
      if (requestId === requestIdRef.current) {
        setCustomers(payload?.clientes ?? []);
      }
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      console.error("Erro ao carregar acesso de clientes:", error);
      setCustomers([]);
      addToast(
        error instanceof Error ? error.message : "Não foi possível carregar os clientes.",
        "error"
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    const term = query.trim();
    if (term && term.length < 3) {
      setLoading(false);
      setCustomers([]);
      return;
    }

    const timer = window.setTimeout(() => {
      void loadCustomers(term);
    }, term ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [loadCustomers, query]);

  const setBlocked = async (customer: ClienteAcesso, blocked: boolean) => {
    if (updatingPhone) return;
    setUpdatingPhone(customer.telefone);
    try {
      const response = await apiFetch(`${BASE_URL}/clientes`, {
        method: "POST",
        body: JSON.stringify({
          action: "definirBloqueio",
          telefone: customer.telefone,
          nome: customer.nome,
          bloqueado: blocked,
        }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error || "Não foi possível alterar o acesso do cliente.");
      }

      setConfirmingPhone(null);
      const hasSearch = query.trim().length >= 3;
      setCustomers((previous) => {
        if (!hasSearch && !blocked) {
          return previous.filter((item) => item.telefone !== customer.telefone);
        }
        return previous.map((item) =>
          item.telefone === customer.telefone
            ? { ...item, pedidosBloqueados: blocked }
            : item
        );
      });
      addToast(
        blocked
          ? "Cliente bloqueado para novos pedidos."
          : "Cliente liberado para fazer pedidos.",
        blocked ? "info" : "success"
      );
    } catch (error) {
      console.error("Erro ao alterar acesso do cliente:", error);
      addToast(
        error instanceof Error ? error.message : "Não foi possível alterar o acesso do cliente.",
        "error"
      );
    } finally {
      setUpdatingPhone(null);
    }
  };

  const trimmedQuery = query.trim();
  const isWaitingForMore = trimmedQuery.length > 0 && trimmedQuery.length < 3;

  return (
    <div className="customer-access-page">
      <header className="pdv-page-header">
        <div>
          <h1>Acesso de clientes</h1>
          <p>Controle quem pode finalizar novos pedidos no aplicativo.</p>
        </div>
      </header>

      <div className="customer-access-toolbar">
        <label className="customer-access-search">
          <MdSearch size={19} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por nome ou telefone"
            aria-label="Buscar cliente por nome ou telefone"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Limpar busca">
              <MdClose size={17} />
            </button>
          )}
        </label>
        <span className="customer-access-view-label">
          {trimmedQuery ? "Resultados da busca" : "Clientes bloqueados"}
        </span>
      </div>

      {isWaitingForMore ? (
        <div className="customer-access-empty">
          <MdSearch size={22} />
          <strong>Continue digitando</strong>
          <span>Use pelo menos três letras ou números.</span>
        </div>
      ) : loading ? (
        <div className="customer-access-empty">
          <div className="spinner" />
          <span>Carregando clientes…</span>
        </div>
      ) : customers.length === 0 ? (
        <div className="customer-access-empty">
          <MdManageAccounts size={24} />
          <strong>{trimmedQuery ? "Nenhum cliente encontrado" : "Nenhum cliente bloqueado"}</strong>
          <span>
            {trimmedQuery
              ? "Confira o nome ou telefone e tente novamente."
              : "Quando alguém for bloqueado, aparecerá nesta lista."}
          </span>
        </div>
      ) : (
        <div className="customer-access-list">
          {customers.map((customer) => {
            const isUpdating = updatingPhone === customer.telefone;
            const isConfirming = confirmingPhone === customer.telefone;
            return (
              <article
                className={`customer-access-row${customer.pedidosBloqueados ? " blocked" : ""}`}
                key={customer.telefone}
              >
                <span className="customer-access-avatar" aria-hidden="true">
                  {customer.pedidosBloqueados ? <MdBlock /> : <MdLockOpen />}
                </span>
                <div className="customer-access-identity">
                  <strong>{toTitleCase(customer.nome || customer.telefone)}</strong>
                  <span>{formatPhone(customer.telefone)}</span>
                </div>
                <span className={`customer-access-status${customer.pedidosBloqueados ? " blocked" : ""}`}>
                  {customer.pedidosBloqueados ? "Bloqueado" : "Liberado"}
                </span>

                {isConfirming ? (
                  <div className="customer-access-confirm">
                    <p>Este cliente não conseguirá finalizar novos pedidos.</p>
                    <button
                      type="button"
                      onClick={() => setConfirmingPhone(null)}
                      disabled={isUpdating}
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void setBlocked(customer, true)}
                      disabled={isUpdating}
                    >
                      {isUpdating ? "Bloqueando…" : "Confirmar"}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`customer-access-action${customer.pedidosBloqueados ? " release" : ""}`}
                    onClick={() => {
                      if (customer.pedidosBloqueados) {
                        void setBlocked(customer, false);
                      } else {
                        setConfirmingPhone(customer.telefone);
                      }
                    }}
                    disabled={isUpdating}
                  >
                    {isUpdating
                      ? "Salvando…"
                      : customer.pedidosBloqueados
                        ? "Liberar pedidos"
                        : "Bloquear pedidos"}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
