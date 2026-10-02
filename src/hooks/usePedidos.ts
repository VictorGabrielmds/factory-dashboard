// src/hooks/usePedidos.ts
import { useEffect, useState } from "react";
import { db } from "../services/firebase";
import { collection, onSnapshot, query, where, orderBy } from "firebase/firestore";
import type { Pedido } from "../types/Pedido";

export function usePedidos(dataSelecionada?: Date, enabled = true) {
  const [pedidos, setPedidos] = useState<Pedido[]>([]);

  useEffect(() => {
    if (!enabled) return;

    // 1. Usa a data passada pelo calendário ou o dia de hoje
    const baseDate = dataSelecionada || new Date();

    // 2. Volta 1 dia para pegar vendas da madrugada (vendidas às 23:50, entregues à 00:15)
    const dataInicio = new Date(baseDate);
    dataInicio.setDate(dataInicio.getDate() - 1);
    
    const anoInicio = dataInicio.getFullYear();
    const mesInicio = String(dataInicio.getMonth() + 1).padStart(2, '0');
    const diaInicio = String(dataInicio.getDate()).padStart(2, '0');
    const dataInicioString = `${anoInicio}-${mesInicio}-${diaInicio} 00:00:00`;

    // 3. Avança 1 dia para a margem superior (agendamentos do dia seguinte)
    const dataFim = new Date(baseDate);
    dataFim.setDate(dataFim.getDate() + 1);
    
    const anoFim = dataFim.getFullYear();
    const mesFim = String(dataFim.getMonth() + 1).padStart(2, '0');
    const diaFim = String(dataFim.getDate()).padStart(2, '0');
    const dataFimString = `${anoFim}-${mesFim}-${diaFim} 23:59:59`;

    // 4. Busca dinamicamente os pedidos DESSA janela de tempo
    const q = query(
      collection(db, "pedidos"),
      where("status", "in", [1, 2, 3, 5]),
      where("data_venda", ">=", dataInicioString),
      where("data_venda", "<=", dataFimString),
      orderBy("data_venda", "desc") 
    );

    const unsub = onSnapshot(q, (snap) => {
      const lista = snap.docs.map(doc => ({
        order_id: doc.id,
        ...doc.data(),
      } as Pedido));
      setPedidos(lista);
    });

    return () => unsub();
  }, [dataSelecionada, enabled]); // 🔄 Refaz a busca sempre que você muda de dia!

  return pedidos;
}

/**
 * Pedidos ainda em operação não podem depender da data em que foram criados:
 * um agendamento para hoje pode ter sido comprado vários dias atrás. A lista
 * costuma ser pequena (somente recebidos/aceitos/prontos) e é filtrada por dia
 * no cliente junto com a consulta legada por `data_venda`.
 */
export function usePedidosAbertos(enabled = true) {
  const [pedidos, setPedidos] = useState<Pedido[]>([]);

  useEffect(() => {
    if (!enabled) {
      setPedidos([]);
      return;
    }

    const q = query(
      collection(db, "pedidos"),
      where("status", "in", [1, 2, 3])
    );
    return onSnapshot(q, (snap) => {
      setPedidos(snap.docs.map((documento) => ({
        order_id: documento.id,
        ...documento.data(),
      } as Pedido)));
    });
  }, [enabled]);

  return pedidos;
}

/** Consulta indexável para pedidos novos, baseada no dia operacional salvo
 * pelo backend. Mantemos `usePedidos` em paralelo durante a transição para os
 * documentos antigos que ainda não possuem o campo. */
export function usePedidosPorDataOperacional(dataSelecionada?: Date, enabled = true) {
  const [pedidos, setPedidos] = useState<Pedido[]>([]);

  useEffect(() => {
    if (!enabled) {
      setPedidos([]);
      return;
    }
    const baseDate = dataSelecionada || new Date();
    const dataISO = [
      baseDate.getFullYear(),
      String(baseDate.getMonth() + 1).padStart(2, "0"),
      String(baseDate.getDate()).padStart(2, "0"),
    ].join("-");
    const q = query(
      collection(db, "pedidos"),
      where("data_operacional", "==", dataISO)
    );
    return onSnapshot(q, (snap) => {
      setPedidos(snap.docs.map((documento) => ({
        order_id: documento.id,
        ...documento.data(),
      } as Pedido)));
    });
  }, [dataSelecionada, enabled]);

  return pedidos;
}

/**
 * Fonte dedicada da mesa de rotas.
 *
 * A consulta por período de `usePedidos` é ideal para as colunas visuais do
 * dashboard, mas não pode ser usada para montar rotas: um pedido pode ter
 * sido criado vários dias antes da data em que será entregue. Aqui ouvimos
 * somente os pedidos ainda aceitos; o RouteKaban aplica a data operacional
 * (`agendamento`, com fallback para `data_venda`) do dia selecionado.
 */
export function usePedidosParaRotas(enabled = true) {
  const [pedidos, setPedidos] = useState<Pedido[]>([]);

  useEffect(() => {
    if (!enabled) {
      setPedidos([]);
      return;
    }

    const q = query(
      collection(db, "pedidos"),
      where("status", "==", 2)
    );

    const unsub = onSnapshot(q, (snap) => {
      const lista = snap.docs.map(doc => ({
        order_id: doc.id,
        ...doc.data(),
      } as Pedido));
      setPedidos(lista);
    });

    return () => unsub();
  }, [enabled]);

  return pedidos;
}
