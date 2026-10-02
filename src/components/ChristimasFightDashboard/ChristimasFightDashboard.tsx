import { useState, useMemo, useEffect } from "react";
import { 
  MdCheckCircle, 
  MdRadioButtonUnchecked, 
  MdDateRange, 
  MdCalendarMonth, 
  MdSummarize, 
  MdList,
  MdDoneAll, // Ícone para marcar tudo
  MdRemoveDone // Ícone para desmarcar tudo
} from "react-icons/md";
import "./ChristimasFightDashboard.css";
import type { Pedido } from "../../types/Pedido";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../../services/firebase";

import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { ptBR } from 'date-fns/locale/pt-BR'; 

const ITENS_ANTECIPADOS = [
  "PÃO DE METRO",
  "MINI PIZZA",
  "PÃO DELÍCIA",
  "PÃO DE QUEIJO",
  "BOLINHO DE TAPIOCA",
  "FOLHADO",
  "TAPIOCA"
];

interface ProductionItem {
  id_unico: string;
  pedido_id: string;
  nome_cliente: string;
  item_nome: string;
  data_entrega: string;
  quantidade: number;
  feito: boolean;
}

interface SummaryItem {
  item_nome: string;
  total_quantidade: number;
  total_pedidos: number;
  quantidade_feita: number;
}

export default function ChristimasFightDashboard() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [isSummaryView, setIsSummaryView] = useState(false);
  
  const [itensConcluidos, setItensConcluidos] = useState<string[]>([]);
  const [pedidos, setPedidos] = useState<Pedido[]>([]);

  useEffect(() => {
    const q = query(collection(db, "pedidos"), where("status", "in", [2]));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const dados: Pedido[] = snapshot.docs.map((d) => d.data() as Pedido);
      setPedidos(dados);
    });
    return unsubscribe;
  }, []);

  // 1. Lista Detalhada
  const productionList = useMemo(() => {
    const lista: ProductionItem[] = [];
    const dia = String(selectedDate.getDate()).padStart(2, '0');
    const mes = String(selectedDate.getMonth() + 1).padStart(2, '0');
    const dataBusca = `${dia}/${mes}`; 

    pedidos.forEach((pedido) => {
      if (!pedido.agendamento || !pedido.agendamento.includes(dataBusca)) return;

      pedido.descricao_item.forEach((itemString, index) => {
        const ehAntecipado = ITENS_ANTECIPADOS.some((keyword) => 
          itemString.toUpperCase().includes(keyword)
        );

        if (ehAntecipado) {
          const idUnico = `${pedido.order_id}-${index}`;
          const quantidadeDoItem = pedido.quantidade_item[index]; 

          lista.push({
            id_unico: idUnico,
            pedido_id: String(pedido.order_id),
            nome_cliente: pedido.nome_destinatario,
            item_nome: itemString,
            data_entrega: pedido.agendamento || "Sem data", // ou "" se preferir vazio
            quantidade: quantidadeDoItem,
            feito: itensConcluidos.includes(idUnico)
          });
        }
      });
    });

    return lista;
  }, [pedidos, selectedDate, itensConcluidos]);

  // 2. Lista Resumida
  const summaryList = useMemo(() => {
    const map: Record<string, SummaryItem> = {};

    productionList.forEach((item) => {
      const key = item.item_nome.trim();
      if (!map[key]) {
        map[key] = {
          item_nome: key,
          total_quantidade: 0,
          total_pedidos: 0,
          quantidade_feita: 0
        };
      }
      map[key].total_quantidade += item.quantidade;
      map[key].total_pedidos += 1;
      if (item.feito) map[key].quantidade_feita += item.quantidade;
    });

    return Object.values(map).sort((a, b) => a.item_nome.localeCompare(b.item_nome));
  }, [productionList]);

  // Estatísticas Globais
  const total = productionList.length;
  const feitos = productionList.filter(i => i.feito).length;
  const progresso = total === 0 ? 0 : (feitos / total) * 100;

  // Toggle individual
  const toggleItem = (id: string) => {
    setItensConcluidos(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // --- NOVA FUNÇÃO: Toggle em Lote ---
  const toggleBatch = (nomeItem: string) => {
    // 1. Acha todos os IDs que tem esse nome na lista atual
    const idsDesteTipo = productionList
      .filter(p => p.item_nome.trim() === nomeItem.trim())
      .map(p => p.id_unico);

    // 2. Verifica se TODOS já estão concluídos
    const todosConcluidos = idsDesteTipo.every(id => itensConcluidos.includes(id));

    if (todosConcluidos) {
        // DESMARCAR TODOS (Remove os IDs do estado)
        setItensConcluidos(prev => prev.filter(id => !idsDesteTipo.includes(id)));
    } else {
        // MARCAR TODOS (Adiciona os que faltam)
        // Usamos Set para evitar duplicatas
        setItensConcluidos(prev => {
            const novoSet = new Set([...prev, ...idsDesteTipo]);
            return Array.from(novoSet);
        });
    }
  };

  const formatDateDisplay = (date: Date) => {
    return date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  };

  return (
    <div className="production-container">
      <header className="production-header">
        <div className="header-title">
            <h2>Controle de Produção</h2>
            <p>Itens antecipados para: <strong>{formatDateDisplay(selectedDate)}</strong></p>
        </div>
        
        <div className="header-actions">
            <button 
                className="view-toggle-btn"
                onClick={() => setIsSummaryView(!isSummaryView)}
                title={isSummaryView ? "Ver Detalhes" : "Ver Resumo"}
            >
                {isSummaryView ? <MdList size={24} /> : <MdSummarize size={24} />}
                <span>{isSummaryView ? "Detalhes" : "Resumo"}</span>
            </button>

            <div className="date-picker-wrapper">
                <button
                    onClick={() => setIsCalendarOpen(!isCalendarOpen)}
                    className={`calendar-btn ${isCalendarOpen ? "active" : ""}`}
                >
                    <MdCalendarMonth size={24} />
                    <span>Data</span>
                </button>
                {isCalendarOpen && (
                    <div className="calendar-popup">
                    <DatePicker
                        selected={selectedDate}
                        locale={ptBR}
                        onChange={(date: Date | null) => {
                            if (date) {
                                setSelectedDate(date);
                                setIsCalendarOpen(false);
                            }
                        }}
                        inline
                    />
                    </div>
                )}
            </div>
        </div>
      </header>

      <div className="progress-section">
        <div className="stats-text">
            <span>Produzido (Pedidos): <strong>{feitos}/{total}</strong></span>
            <span>{progresso.toFixed(0)}%</span>
        </div>
        <div className="progress-bar-bg">
            <div 
                className="progress-bar-fill" 
                style={{ 
                    width: `${progresso}%`, 
                    backgroundColor: progresso === 100 ? "#4caf50" : "#d32f2f" 
                }}
            ></div>
        </div>
      </div>

      <div className="production-grid">
        {productionList.length === 0 ? (
            <div className="empty-state">
                <p>Nenhum item antecipado encontrado para o dia <strong>{formatDateDisplay(selectedDate)}</strong>.</p>
            </div>
        ) : isSummaryView ? (
            // --- VISÃO RESUMIDA ---
            summaryList.map((summary) => {
                const progressoItem = (summary.quantidade_feita / summary.total_quantidade) * 100;
                const isComplete = summary.quantidade_feita === summary.total_quantidade;

                return (
                    <div key={summary.item_nome} className={`summary-card ${isComplete ? 'done' : ''}`}>
                        <div className="summary-header">
                            <span className="summary-title">{summary.item_nome}</span>
                            <span>{}</span>
                            {/* BOTÃO DE AÇÃO EM LOTE */}
                            <button 
                                className={`batch-action-btn ${isComplete ? 'undo' : 'do'}`}
                                onClick={() => toggleBatch(summary.item_nome)}
                                title={isComplete ? "Desmarcar todos" : "Concluir todos"}
                            >
                                {isComplete ? <MdRemoveDone size={20}/> : <MdDoneAll size={20}/>}
                                {isComplete ? "Desfazer" : "Concluir Todos"}
                            </button>
                        </div>
                        
                        <div className="summary-details">
                            <div className="summary-stat-row">
                                <span>Total Pedidos: <strong>{summary.total_pedidos}</strong></span>
                                <span className="summary-total-badge">{summary.total_quantidade} un.</span>
                            </div>
                            <p className="summary-progress-text">
                                Produzidos: <strong>{summary.quantidade_feita}</strong> de {summary.total_quantidade}
                            </p>
                        </div>

                        <div className="mini-progress-bg">
                            <div 
                                className="mini-progress-fill"
                                style={{ 
                                    width: `${progressoItem}%`,
                                    backgroundColor: isComplete ? "#4caf50" : "#ff9800"
                                }}
                            ></div>
                        </div>
                    </div>
                );
            })
        ) : (
            // --- VISÃO DETALHADA ---
            productionList.map((item) => (
            <div 
                key={item.id_unico} 
                className={`production-card ${item.feito ? "done" : ""}`}
                onClick={() => toggleItem(item.id_unico)}
            >
                <div className="check-icon">
                {item.feito ? <MdCheckCircle className="icon-done"/> : <MdRadioButtonUnchecked className="icon-todo"/>}
                </div>
                
                <div className="card-content">
                    <span className="item-name">{item.item_nome}</span>
                    <h3 className="item-quantity">{item.quantidade}x</h3>
                    <div className="card-footer">
                        <span className="client-info">
                            <strong>#{item.pedido_id}</strong> • {item.nome_cliente.split(" ")[0]}
                        </span>
                        <span className="delivery-time">
                           <MdDateRange /> {item.data_entrega.match(/(\d{2}:\d{2})/)?.[1]}
                        </span>
                    </div>
                </div>
            </div>
            ))
        )}
      </div>
    </div>
  );
}