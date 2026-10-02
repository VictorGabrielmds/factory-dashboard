import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "../services/firebase";
import { db } from "../services/firebase";

const PIX_CONFLICT_TYPES = new Set([
  "pix_colisao",
  "pix_sem_vinculo_exato",
  "payment_id_duplicado",
  "pagamento_ja_usado",
  "vinculo_pix_invalido",
]);

type UnknownRecord = Record<string, unknown>;

export interface PixConflictAlert {
  id: string;
  tipo: string;
  descricao: string;
  pagamentoId: string | null;
  orderIds: string[];
  criadaEmMs: number;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function addOrderId(target: Set<string>, value: unknown) {
  const normalized = String(value ?? "").trim();
  if (/^\d{6,}$/.test(normalized)) target.add(normalized);
}

function extractOrderIds(data: UnknownRecord): string[] {
  const ids = new Set<string>();
  const detalhes = asRecord(data.detalhes);

  const candidatos = Array.isArray(detalhes?.candidatos)
    ? detalhes.candidatos
    : [];
  for (const candidato of candidatos) {
    addOrderId(ids, asRecord(candidato)?.id);
  }

  const pedidos = Array.isArray(detalhes?.pedidos) ? detalhes.pedidos : [];
  for (const pedidoId of pedidos) addOrderId(ids, pedidoId);

  addOrderId(ids, data.pedidoId);
  addOrderId(ids, detalhes?.pedidoAtual);
  addOrderId(ids, detalhes?.pedidoJaVinculado);

  const descricao = String(data.descricao || "");
  for (const match of descricao.matchAll(/#(\d{6,})\b/g)) {
    addOrderId(ids, match[1]);
  }

  return Array.from(ids);
}

function timestampToMillis(value: unknown): number {
  const timestamp = asRecord(value);
  const toMillis = timestamp?.toMillis;
  return typeof toMillis === "function"
    ? Number(toMillis.call(value))
    : 0;
}

export function usePixConflictAlerts() {
  const [alerts, setAlerts] = useState<PixConflictAlert[]>([]);

  useEffect(() => {
    const openPendencies = query(
      collection(db, "pendencias"),
      where("resolvida", "==", false),
    );

    return onSnapshot(
      openPendencies,
      (snapshot) => {
        const next = snapshot.docs
          .map((document) => {
            const data = document.data() as UnknownRecord;
            const tipo = String(data.tipo || "");
            if (!PIX_CONFLICT_TYPES.has(tipo)) return null;

            return {
              id: document.id,
              tipo,
              descricao: String(data.descricao || "Conflito na confirmação do PIX."),
              pagamentoId: data.pagamentoId ? String(data.pagamentoId) : null,
              orderIds: extractOrderIds(data),
              criadaEmMs: timestampToMillis(data.criadaEmTimestamp),
            } satisfies PixConflictAlert;
          })
          .filter((alert): alert is PixConflictAlert => alert !== null)
          .sort((a, b) => b.criadaEmMs - a.criadaEmMs);

        setAlerts(next);
      },
      (error) => {
        console.error("Erro ao acompanhar conflitos PIX:", error);
      },
    );
  }, []);

  const orderIds = useMemo(
    () => new Set(alerts.flatMap((alert) => alert.orderIds)),
    [alerts],
  );

  return { alerts, orderIds };
}
