import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, updateDoc, doc, query, limit, orderBy, where } from "firebase/firestore";
import { db } from "../../services/firebase";
import "./CaixaDashboard.css";

import type { Pedido } from "../../types/Pedido";
import { MdCalendarMonth, MdDateRange, MdOutlinePayments, MdOutlineSportsMotorsports, MdShoppingBag, MdCheckCircle, MdPendingActions } from "react-icons/md";
import { PiMotorcycleFill } from "react-icons/pi";
import { BsCashCoin as CashCoin } from "react-icons/bs";
import DatePicker from "react-datepicker";

const PAYMENT_TYPE: Record<string, string> = {
  "01": "Dinheiro", "03": "Cartão de Crédito", "04": "Cartão de Débito",
  "10": "Vale Refeição / Alimentação", "17": "PIX", "43": "iFood Pago",
  "42": "Cartão de Crédito Online", "47": "Fiado", "48": "Ticket Online", "99": "Outras",
};

export default function CaixaDashboard() {
  const today = new Date();
  const [orders, setOrders] = useState<Pedido[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date>(today);
  const [filterName, setFilterName] = useState<string>("");

  useEffect(() => {
    async function fetchOrders() {
      setLoading(true);
      const pedidosRef = collection(db, "pedidos");
      const pedidosQuery = query(
        pedidosRef,
        where("status", "==", 2),
        orderBy("data_venda", "desc"),
        limit(200)
      );
      const snapshot = await getDocs(pedidosQuery);
      const data = snapshot.docs.map((d) => ({
        order_id: d.id,
        ...d.data(),
      })) as Pedido[];
      setOrders(data);
      setLoading(false);
    }
    fetchOrders();
  }, []);

  const filteredOrders = useMemo(() => {
    return orders.filter((order) => {
      const dateMatch = selectedDay
        ? toLocalDateString(parseDateHoraII(order.data_venda)) === toLocalDateString(selectedDay)
        : true;
      const nameMatch = filterName
        ? order.nome_destinatario.toLowerCase().includes(filterName.toLowerCase())
        : true;
      return dateMatch && nameMatch;
    });
  }, [orders, selectedDay, filterName]);

  const okOrders = useMemo(() => filteredOrders.filter((o) => o.isOk === true), [filteredOrders]);
  const pendingOrders = useMemo(() => filteredOrders.filter((o) => !o.isOk), [filteredOrders]);

  // KPIs de Auditoria Financeira
  const { totalCaixa, totalPendente, totalOk } = useMemo(() => {
    let caixa = 0, pendente = 0, ok = 0;
    filteredOrders.forEach(o => {
      const val = parseFloat(String(o.valor_venda || "0").replace(",", "."));
      if (!isNaN(val)) {
        caixa += val;
        if (o.isOk) ok += val;
        else pendente += val;
      }
    });
    return { totalCaixa: caixa, totalPendente: pendente, totalOk: ok };
  }, [filteredOrders]);

  async function markAsOk(id: string | number) {
    const ref = doc(db, "pedidos", String(id));
    await updateDoc(ref, { isOk: true });
    setOrders((prev) => prev.map((o) => (o.order_id === id ? { ...o, isOk: true } : o)));
  }

  async function markAsNotOk(id: string | number) {
    const ref = doc(db, "pedidos", String(id));
    await updateDoc(ref, { isOk: false });
    setOrders((prev) => prev.map((o) => (o.order_id === id ? { ...o, isOk: false } : o)));
  }

  // ✅ BLINDAGEM: Processa pagamentos múltiplos sem quebrar o ecrã
  // ✅ FIX: Dizemos exatamente o que pode chegar do banco
  const renderPayment = (forma_pagamento: string | string[] | undefined) => {
    if (!forma_pagamento) return "Não informado";
    const formas = Array.isArray(forma_pagamento) ? forma_pagamento : [forma_pagamento];
    return formas.map(f => PAYMENT_TYPE[String(f)] || f).join(" + ");
  };

  const moeda = (valor: number) => valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  return (
    <div className="caixa-dashboard">
      {/* ─── MENU DE FILTROS ─── */}
      <div className="caixa-header-actions">
        <div className="date-picker">
          <button onClick={() => setIsCalendarOpen((prev) => !prev)}>
            <MdCalendarMonth size={18} /> {toLocalDateString(selectedDay).split('-').reverse().join('/')}
          </button>
          {isCalendarOpen && (
            <div className="calendar">
              <DatePicker selected={selectedDay} onChange={(date: Date | null) => { if (date) { setSelectedDay(date); setIsCalendarOpen(false); } }} inline />
            </div>
          )}
        </div>
        <div className="search-box">
          <input type="text" placeholder="Procurar cliente..." value={filterName} onChange={(e) => setFilterName(e.target.value)} />
        </div>
      </div>

      {/* ─── KPIs DO CAIXA ─── */}
      <div className="kpi-row">
        <div className="kpi-card">
          <span>Movimento do Dia</span>
          <h2 style={{ color: 'var(--sys-color-primary)' }}><CashCoin /> {moeda(totalCaixa)}</h2>
        </div>
        <div className="kpi-card">
          <span>Falta Auditar</span>
          <h2 style={{ color: 'var(--sys-color-danger)' }}><MdPendingActions /> {moeda(totalPendente)}</h2>
        </div>
        <div className="kpi-card">
          <span>Auditado (OK)</span>
          <h2 style={{ color: 'var(--sys-color-success)' }}><MdCheckCircle /> {moeda(totalOk)}</h2>
        </div>
      </div>

      {loading && <p className="loading-text">A carregar a tesouraria...</p>}
      {!loading && filteredOrders.length === 0 && <p className="loading-text">Nenhum registo financeiro encontrado.</p>}

      {/* ─── KANBAN DE AUDITORIA ─── */}
      <div className="caixa-kanban">
        {/* COLUNA PENDENTES */}
        <div className="kanban-column pending-column">
          <div className="column-header">
            <h3>Pendentes <span>{pendingOrders.length}</span></h3>
          </div>
          <div className="column-body">
            {pendingOrders.map((order) => (
              <div key={order.order_id} className="audit-card">
                <div className="card-top">
                  <span className="order-id">#{order.order_id}</span>
                  <div className="type-badge">
                    {order.bairro_destinatario ? <PiMotorcycleFill size={16} title="Delivery" /> : <MdShoppingBag size={16} title="Retirada" />}
                  </div>
                </div>
                <h4>{order.nome_destinatario}</h4>
                <div className="price-tag">{moeda(parseFloat(String(order.valor_venda || "0").replace(",", ".")))}</div>
                
                <div className="info-list">
                  <p><MdOutlinePayments /> {renderPayment(order.forma_pagamento)}</p>
                  {order.motoboy_id && <p><MdOutlineSportsMotorsports /> {order.motoboy_id.replace(/_/g, " ")}</p>}
                  <p><MdDateRange /> {order.data_saida || order.data_venda}</p>
                </div>
                
                <button className="btn-ok" onClick={() => markAsOk(order.order_id)}>
                  <MdCheckCircle size={18} /> Confirmar Recebimento
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* COLUNA OK (AUDITADOS) */}
        <div className="kanban-column ok-column">
          <div className="column-header">
            <h3>Auditados (OK) <span>{okOrders.length}</span></h3>
          </div>
          <div className="column-body">
            {okOrders.map((order) => (
              <div key={order.order_id} className="audit-card is-audited">
                <div className="card-top">
                  <span className="order-id">#{order.order_id}</span>
                  <div className="type-badge">
                    {order.bairro_destinatario ? <PiMotorcycleFill size={16} /> : <MdShoppingBag size={16} />}
                  </div>
                </div>
                <h4>{order.nome_destinatario}</h4>
                <div className="price-tag">{moeda(parseFloat(String(order.valor_venda || "0").replace(",", ".")))}</div>
                
                <div className="info-list">
                  <p><MdOutlinePayments /> {renderPayment(order.forma_pagamento)}</p>
                  <p><MdDateRange /> {order.data_venda}</p>
                </div>
                
                <button className="btn-undo" onClick={() => markAsNotOk(order.order_id)}>
                  Desfazer Auditoria
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function toLocalDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDateHoraII(dataStr: string): Date {
  if (!dataStr) return new Date();
  return new Date(dataStr.replace(" ", "T"));
}