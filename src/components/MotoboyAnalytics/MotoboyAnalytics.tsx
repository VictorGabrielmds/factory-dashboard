// src/components/MotoboyAnalytics/MotoboyAnalytics.tsx
import { useEffect, useState, useCallback, useMemo } from "react";
import "./MotoboyAnalytics.css";
import { db } from "../../services/firebase";
import { collection, getDocs, query, where } from "firebase/firestore";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import {
  BsCalendarWeek as CalendarWeek,
  BsCashCoin as CashCoin,
  BsClockHistory as ClockHistory,
  BsGraphUpArrow as GraphUpArrow,
  BsMap as Map,
  BsEye as Eye,
  BsEyeSlash as EyeSlash,
} from "react-icons/bs";
import { useToast } from "../../contexts/ToastContext";

import { WeeklyBarChart } from "./boards/WeeklyBarChart";
import { RankingPieChart } from "./boards/RankingPieChart";
import { HourlyChart } from "./boards/HourlyChart"; 

const ORDEM_DIAS = ["seg.", "ter.", "qua.", "qui.", "sex.", "sáb.", "dom."];

// Dicionário de pagamentos para legibilidade
const PAYMENT_LABELS: Record<string, string> = {
  "01": "Dinheiro", "03": "Cartão de crédito", "04": "Cartão de débito",
  "10": "Vale Refeição / Alimentação", "17": "PIX", "42": "Crédito online",
  "43": "iFood pago", "47": "Fiado", "48": "Ticket Online", "99": "Outras",
};

interface PedidoData {
  valor_taxa?: string;
  valor_venda?: string | number;
  data_saida?: string;
  data_venda?: string;
  motoboy_id?: string;
  agendamento?: string;
  bairro_destinatario?: string;
  forma_pagamento?: string | string[];
}

function getSemanaDe(dataBase: Date): Date[] {
  const diaDaSemana     = dataBase.getDay();
  const diasDesdeSegunda = diaDaSemana === 0 ? 6 : diaDaSemana - 1;
  const segunda         = new Date(dataBase);
  segunda.setDate(dataBase.getDate() - diasDesdeSegunda);
  segunda.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const dia = new Date(segunda);
    dia.setDate(segunda.getDate() + i);
    return dia;
  });
}

function toQueryDateStr(date: Date, endOfDay = false): string {
  const y  = date.getFullYear();
  const m  = String(date.getMonth() + 1).padStart(2, "0");
  const d  = String(date.getDate()).padStart(2, "0");
  const time = endOfDay ? "23:59:59" : "00:00:00";
  return `${y}-${m}-${d} ${time}`;
}

export default function MotoboyAnalytics() {
  const { addToast } = useToast();

  const [loading,        setLoading]        = useState(true);
  const [selectedDate,   setSelectedDate]   = useState(new Date());
  const [mostrarCalendario, setMostrarCalendario] = useState(false);
  const [pedidosBrutos,  setPedidosBrutos]  = useState<PedidoData[]>([]);
  const [filter,         setFilter]         = useState<'todos' | 'delivery' | 'retirada'>('todos');
  const [hourlyMode,     setHourlyMode]     = useState<'semana' | 'dia'>('semana');
  
  // ✅ Estado para controlar a visibilidade da receita
  const [mostrarReceita, setMostrarReceita] = useState(false);

  // Parser robusto contra viradas de ano
  const parseDataPedido = useCallback((dataStr: string): Date | null => {
    try {
      const semPrefixo = dataStr.replace("Dia ", "").trim();
      const [parteData, parteHora] = semPrefixo.split(" - ");
      if (!parteData || !parteHora) return null;
      
      const [dia, mes] = parteData.split("/").map(Number);
      const horaLimpa  = parteHora.split(" ")[0];
      const [h, m]     = horaLimpa.split(":").map(Number);
      if (isNaN(dia) || isNaN(mes) || isNaN(h) || isNaN(m)) return null;

      let ano = selectedDate.getFullYear();
      if (mes === 12 && selectedDate.getMonth() === 0) ano -= 1;
      if (mes === 1 && selectedDate.getMonth() === 11) ano += 1;

      return new Date(ano, mes - 1, dia, h, m);
    } catch {
      return null;
    }
  }, [selectedDate]);

  // Fetch 
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const semana = getSemanaDe(selectedDate);
        const windowStart = new Date(semana[0]);
        windowStart.setDate(windowStart.getDate() - 14); // Pega agendados antes
        const windowEnd = semana[6];

        const startStr = toQueryDateStr(windowStart, false);
        const endStr   = toQueryDateStr(windowEnd,   true);

        const q = query(
          collection(db, "pedidos"),
          where("data_venda", ">=", startStr),
          where("data_venda", "<=", endStr)
        );

        const pedidosSnap = await getDocs(q);
        const pedidos: PedidoData[] = [];

        pedidosSnap.forEach((doc) => {
          pedidos.push(doc.data() as PedidoData);
        });

        setPedidosBrutos(pedidos);
      } catch (error) {
        console.error("Erro ao buscar dados:", error);
        addToast("Erro ao carregar dados analytics.", "error");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [selectedDate, addToast]);

  // Motor de Inteligência Analítica
  const { 
    weeklyData, ranking, hourlyData, hourlyDataDia, totalEntregas, 
    receitaTotal, ticketMedio, taxaPontualidade, topBairros, pagamentosData 
  } = useMemo(() => {
    if (!pedidosBrutos.length) {
      return { 
        weeklyData: [], ranking: [], hourlyData: [], hourlyDataDia: [], totalEntregas: 0, 
        receitaTotal: 0, ticketMedio: 0, taxaPontualidade: 0, topBairros: [], pagamentosData: [] 
      };
    }

    const semana       = getSemanaDe(selectedDate);
    const inicioSemana = semana[0];
    const fimSemana    = new Date(semana[6]);
    fimSemana.setHours(23, 59, 59, 999);

    const contagens = {
      porDia: {} as Record<string, number>,
      porHora: {} as Record<string, number>,
      porHoraDia: {} as Record<string, number>, // apenas o dia selecionado
      porMotoboy: {} as Record<string, number>,
      porBairro: {} as Record<string, number>,
      porPagamento: {} as Record<string, number>,
    };

    const diaInicioSelecionado = new Date(selectedDate);
    diaInicioSelecionado.setHours(0, 0, 0, 0);
    const diaFimSelecionado = new Date(selectedDate);
    diaFimSelecionado.setHours(23, 59, 59, 999);

    let totalCalculado = 0;
    let receita = 0;
    let noPrazoCount = 0;
    let pontualidadeValidosCount = 0;

    pedidosBrutos.forEach((data) => {
      // Aplica os filtros de aba
      if (filter === "delivery" && !data.valor_taxa) return;
      if (filter === "retirada" && data.valor_taxa)  return;

      let dataAlvo: Date | null = null;
      if (data.agendamento) {
        dataAlvo = parseDataPedido(data.agendamento);
      } else if (data.data_venda) {
        dataAlvo = new Date(data.data_venda.replace(" ", "T"));
      }
      
      if (!dataAlvo) return;

      if (dataAlvo >= inicioSemana && dataAlvo <= fimSemana) {
        totalCalculado++;

        const dayIndex = dataAlvo.getDay();
        const nomeDia  = ORDEM_DIAS[dayIndex === 0 ? 6 : dayIndex - 1];
        contagens.porDia[nomeDia] = (contagens.porDia[nomeDia] || 0) + 1;
        
        const horaStr = `${String(dataAlvo.getHours()).padStart(2, '0')}:00`;
        contagens.porHora[horaStr] = (contagens.porHora[horaStr] || 0) + 1;

        if (dataAlvo >= diaInicioSelecionado && dataAlvo <= diaFimSelecionado) {
          contagens.porHoraDia[horaStr] = (contagens.porHoraDia[horaStr] || 0) + 1;
        }

        if (data.motoboy_id) {
          const nomeMotoboy = data.motoboy_id.replace(/_/g, " ");
          contagens.porMotoboy[nomeMotoboy] = (contagens.porMotoboy[nomeMotoboy] || 0) + 1;
        }

        const valorReal = parseFloat(String(data.valor_venda || "0").replace(",", "."));
        if (!isNaN(valorReal)) receita += valorReal;

        if (data.bairro_destinatario) {
          const bairro = data.bairro_destinatario.toUpperCase();
          contagens.porBairro[bairro] = (contagens.porBairro[bairro] || 0) + 1;
        }

        if (data.forma_pagamento) {
          const formas = Array.isArray(data.forma_pagamento) ? data.forma_pagamento : [data.forma_pagamento];
          formas.forEach(codigo => {
            const label = PAYMENT_LABELS[codigo] || "Outros";
            contagens.porPagamento[label] = (contagens.porPagamento[label] || 0) + 1;
          });
        }

        // Taxa de Pontualidade
        if (data.agendamento && data.data_saida) {
          const dAgendado = parseDataPedido(data.agendamento);
          const [dStr, tStr] = data.data_saida.split(" às ");
          
          if (dAgendado && dStr && tStr) {
            const [dia, mes, ano] = dStr.split("/").map(Number);
            const [h, m] = tStr.split(":").map(Number);
            const dSaida = new Date(ano, mes - 1, dia, h, m);
            
            if (!isNaN(dSaida.getTime())) {
              const diffMinutos = (dSaida.getTime() - dAgendado.getTime()) / 60000;
              pontualidadeValidosCount++;
              
              if (diffMinutos <= 15) { 
                noPrazoCount++;
              }
            }
          }
        }
      }
    });

    return { 
      totalEntregas: totalCalculado,
      receitaTotal: receita,
      ticketMedio: totalCalculado > 0 ? (receita / totalCalculado) : 0,
      taxaPontualidade: pontualidadeValidosCount > 0 ? Math.round((noPrazoCount / pontualidadeValidosCount) * 100) : 0,
      weeklyData: ORDEM_DIAS.map((dia) => ({ dia, entregas: contagens.porDia[dia] || 0 })),
      hourlyData: Array.from({ length: 24 }, (_, i) => {
        const h = `${String(i).padStart(2, '0')}:00`;
        return { hora: h, quantidade: contagens.porHora[h] || 0 };
      }),
      hourlyDataDia: Array.from({ length: 24 }, (_, i) => {
        const h = `${String(i).padStart(2, '0')}:00`;
        return { hora: h, quantidade: contagens.porHoraDia[h] || 0 };
      }),
      ranking: Object.entries(contagens.porMotoboy)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value).slice(0, 8),
      topBairros: Object.entries(contagens.porBairro)
        .map(([nome, qtd]) => ({ nome, qtd }))
        .sort((a, b) => b.qtd - a.qtd).slice(0, 5),
      pagamentosData: Object.entries(contagens.porPagamento)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
    };
  }, [pedidosBrutos, filter, selectedDate, parseDataPedido]);

  const formatDate = (date: Date) => {
    const dd   = String(date.getDate()).padStart(2, '0');
    const mm   = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };

  const moeda = (valor: number) => valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // ✅ Função para desbloquear a visualização
  const handleToggleReceita = () => {
    if (mostrarReceita) {
      setMostrarReceita(false);
    } else {
      const senha = window.prompt("Digite a senha gerencial:");
      if (senha === "nil123@") {
        setMostrarReceita(true);
      } else if (senha !== null) {
        addToast("Senha incorreta!", "error");
      }
    }
  };

  return (
    <div className="analytics-container">
      <div className="date-picker">
        <button onClick={() => setMostrarCalendario(!mostrarCalendario)}>
          <CalendarWeek /> {formatDate(selectedDate)}
        </button>
        {mostrarCalendario && (
          <div className="calendar">
            <DatePicker
              selected={selectedDate}
              onChange={(date: Date | null) => {
                if (date) { setSelectedDate(date); setMostrarCalendario(false); }
              }}
              inline
            />
          </div>
        )}
      </div>

      {loading ? (
        <p>Carregando dados executivos...</p>
      ) : (
        <div className="ops">
          {/* ─── KPIS EXECUTIVOS ─── */}
          <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <div className="analytics-card" style={{ flex: '1', minWidth: '150px' }}>
              <div style={{ color: 'var(--sys-color-text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Volume de Vendas</div>
              <h2 style={{ margin: '4px 0', color: 'var(--sys-color-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <GraphUpArrow size={18} /> {totalEntregas}
              </h2>
            </div>
            
            <div 
              className="analytics-card" 
              style={{ flex: '1', minWidth: '150px', cursor: 'pointer' }}
              onClick={handleToggleReceita}
              title="Clique para visualizar a receita"
            >
              <div style={{ color: 'var(--sys-color-text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between' }}>
                Receita Bruta
                {mostrarReceita ? <EyeSlash size={14} /> : <Eye size={14} />}
              </div>
              <h2 style={{ margin: '4px 0', color: 'var(--sys-color-success)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <CashCoin size={18} /> 
                {mostrarReceita ? moeda(receitaTotal) : "R$ *******"}
              </h2>
            </div>

            <div className="analytics-card" style={{ flex: '1', minWidth: '150px' }}>
              <div style={{ color: 'var(--sys-color-text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Ticket Médio</div>
              <h2 style={{ margin: '4px 0', color: 'var(--sys-color-success)' }}>{moeda(ticketMedio)}</h2>
            </div>
            <div className="analytics-card" style={{ flex: '1', minWidth: '150px' }}>
              <div style={{ color: 'var(--sys-color-text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Pontualidade da Expedição</div>
              <h2 style={{ margin: '4px 0', color: taxaPontualidade >= 90 ? 'var(--sys-color-success)' : 'var(--sys-color-danger)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ClockHistory size={18} /> {taxaPontualidade}%
              </h2>
            </div>
          </div>

          <div className="analytics-row">
            <div className="analytics-card" style={{ flex: '1', minWidth: 0 }}>
              <ul className="data-button-list eita" style={{ marginBottom: '16px' }}>
                <button className={filter === "todos"    ? "active" : ""} onClick={() => setFilter("todos")}>Geral</button>
                <button className={filter === "delivery" ? "active" : ""} onClick={() => setFilter("delivery")}>Delivery</button>
                <button className={filter === "retirada" ? "active" : ""} onClick={() => setFilter("retirada")}>Retirada</button>
              </ul>
              <h3>Volume Diário ({formatDate(getSemanaDe(selectedDate)[0])})</h3>
              <WeeklyBarChart data={weeklyData} />
            </div>
            
            <div className="analytics-card" style={{ flex: '1', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ margin: 0 }}>Picos de Demanda (Horário)</h3>
                <ul className="data-button-list" style={{ margin: 0 }}>
                  <button className={hourlyMode === "semana" ? "active" : ""} onClick={() => setHourlyMode("semana")}>Semana</button>
                  <button className={hourlyMode === "dia"    ? "active" : ""} onClick={() => setHourlyMode("dia")}>Dia</button>
                </ul>
              </div>
              <HourlyChart data={hourlyMode === "semana" ? hourlyData : hourlyDataDia} />
            </div>
          </div>

          <div className="analytics-row" style={{ marginTop: '16px' }}>
            <div className="analytics-card" style={{ flex: '1', minWidth: 0 }}>
              <h3>Ranking de Motoboys</h3>
              <RankingPieChart data={ranking} />
            </div>
            <div className="analytics-card" style={{ flex: '1', minWidth: 0 }}>
              <h3>Métodos de Pagamento</h3>
              <RankingPieChart data={pagamentosData} />
            </div>
            <div className="analytics-card" style={{ flex: '1', minWidth: 0 }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Map size={18} /> Bairros Mais Quentes
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '24px' }}>
                {topBairros.map((b, index) => {
                  const percent = Math.round((b.qtd / totalEntregas) * 100);
                  return (
                    <div key={b.nome}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 600, color: 'var(--sys-color-text-main)' }}>
                        <span>{index + 1}. {b.nome}</span>
                        <span>{b.qtd} unid.</span>
                      </div>
                      <div style={{ width: '100%', height: '8px', background: 'var(--sys-color-input-bg)', borderRadius: '4px', marginTop: '4px', overflow: 'hidden' }}>
                        <div style={{ width: `${percent}%`, height: '100%', background: 'var(--sys-color-primary)', borderRadius: '4px' }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}