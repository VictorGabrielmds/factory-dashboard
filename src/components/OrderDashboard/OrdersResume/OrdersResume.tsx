import type { Pedido } from "../../../types/Pedido";
import { parseAgendamentoDate, parseISODateTime } from "../../../utils/dateUtils"; 

export default function OrdersResume({ data, selectedDate }: { data: Pedido[]; selectedDate: Date }) {
  
  const today = new Date(selectedDate);
  today.setHours(0, 0, 0, 0);

  const ordersScheduledForToday = data.filter(p => {
    const parsed = parseAgendamentoDate(p.agendamento);
    const createdAt = parseISODateTime(p.data_venda); 
    const isValidCreatedAt = !isNaN(createdAt.getTime());

    return (
      parsed !== null &&
      parsed.getTime() === today.getTime() &&
      isValidCreatedAt &&
      createdAt.getTime() < today.getTime()
    );
  });

  const deliveryOrders = ordersScheduledForToday.filter(p => p.status === 2);
  const total = ordersScheduledForToday.length;
  const feitos = total - deliveryOrders.length;
  
  // Lógica de progresso
  const percentual = total === 0 ? 0 : Math.round((feitos / total) * 100);
  const concluido = total > 0 && feitos === total;

  if (total === 0) return null; // Limpa a tela se não houver agendamentos

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "16px",
      background: concluido ? "var(--sys-color-success-soft, #edf7ed)" : "var(--sys-color-input-bg, #f8f9fa)",
      padding: "8px 16px",
      borderRadius: "12px",
      border: concluido ? "1px solid var(--sys-color-success, #c8e6c9)" : "1px solid transparent",
      transition: "all 0.3s ease"
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <span style={{ fontSize: "0.75rem", color: "var(--sys-color-text-muted, #666)", fontWeight: 600, textTransform: "uppercase" }}>
          Meta de Agendamentos
        </span>
        <span style={{ fontSize: "0.9rem", color: concluido ? "var(--sys-color-success-ink, #2e7d32)" : "var(--sys-color-text-main, #333)", fontWeight: 700 }}>
          {feitos} de {total} finalizados
        </span>
      </div>

      {/* Barrinha de progresso estilo "Streak" */}
      <div style={{ width: "80px", height: "6px", background: "var(--sys-color-line, #e0e0e0)", borderRadius: "4px", overflow: "hidden" }}>
        <div style={{
          height: "100%",
          width: `${percentual}%`,
          background: concluido ? "var(--sys-color-success-ink, #2e7d32)" : "var(--sys-color-accent, #32378E)",
          transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)"
        }} />
      </div>
    </div>
  );
}