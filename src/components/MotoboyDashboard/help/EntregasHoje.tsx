import { useEffect, useState } from "react";
import "../MotoboyDashboard.css"
import { collection, query, where, getDocs, updateDoc, doc, db } from "../../../services/firebase";

// ✅ 1. Importando os ícones que faltavam
import { 
  MdOutlinePayments, 
  MdOutlineAccountBalanceWallet, 
  MdMonetizationOn 
} from "react-icons/md";

import AnimatedIconButtonCSS from "./AnimatedButtonCSS";
import AddOrderButtom from "./AddOrderButtom"; // ✅ Importando o botão de extra
import type { Pedido } from "../../../types/Pedido";

// ✅ 2. Atualizando a interface para o TypeScript não reclamar do m.taxas
interface Motoboy {
  id?: string;
  nome: string;
  lastDelivery?: string;
  taxas?: number; 
  entregas?: number;
}

const EntregasHoje = ({ motoboys }: { motoboys: Motoboy[] }) => {
  const [motoboySelecionado, setMotoboySelecionado] = useState<string>("");
  const [motoboysHoje, setMotoboysHoje] = useState<Motoboy[]>([]);
  const [index, setIndex] = useState<number>(0);

  const handleClick = () => {
    setIndex((prev) => (prev + 1) % 2);
  };

  useEffect(() => {
    const hojeStr = new Date().toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    });

    const motoboysFiltrados = motoboys.filter((m) => {
      if (!m.lastDelivery) return false;
      const dataDelivery = m.lastDelivery.split(" às ")[0]; 
      return dataDelivery === hojeStr;
    });

    setMotoboysHoje(motoboysFiltrados);
  }, [motoboys]);

  const handleCalcularEntregas = async () => {
    if (!motoboySelecionado) return;

    const pedidosRef = collection(db, "pedidos");
    const q = query(
      pedidosRef,
      where("status", "==", 5),
      where("motoboy_id", "==", motoboySelecionado)
    );

    const snapshot = await getDocs(q);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    let entregas = 0;
    let taxaTotal = 0;

    snapshot.docs.forEach((doc) => {
      const pedido = doc.data() as Pedido;
      if (!pedido.data_saida) return;

      const dataEntrega = parseDataPedido(pedido.data_saida);
      dataEntrega.setHours(0, 0, 0, 0);

      if (dataEntrega.getTime() === hoje.getTime()) {
        entregas += 1;
        taxaTotal += Number(pedido.valor_taxa);
      }
    });

    try {
      const motoboyRef = doc(db, "motoboys", motoboySelecionado);
      await updateDoc(motoboyRef, {
        entregas,
        taxas: taxaTotal
      });
      alert(`Motoboy atualizado: ${entregas} entregas e taxa total R$ ${taxaTotal.toFixed(2)}`);
    } catch (error) {
      console.error("Erro ao atualizar motoboy:", error);
      alert("Erro ao atualizar motoboy, veja o console.");
    }
  };

  // Função vazia só para preencher a prop 'att' que o AddOrderButtom exige
  const handleReload = () => {
    console.log("Recarregando dados do motoboy...");
  };


  return (
    // ✅ 3. Removido o activeOption que estava quebrando
    <div className={`help-btn ${index ? 'u' : 'z'}`}>
      
      <AnimatedIconButtonCSS 
        handleClick={handleClick} 
        index={index} 
      />

      <div className={`closure-panel ${index ? "show" : ""}`}>
        <header>
          <div>
            <h2>Fechamento do dia</h2>
            <p>Recalcule, lance extras ou finalize o acerto.</p>
          </div>
          <MdOutlinePayments size={20} color="var(--sys-color-accent)" />
        </header>

        <section>
          <div className="input-group">
            <label htmlFor="motoboy-sel">Motoboy ativo</label>
            <select
              id="motoboy-sel"
              value={motoboySelecionado}
              onChange={(e) => setMotoboySelecionado(e.target.value)}
            >
              <option value="">Selecione um motoboy</option>
              {motoboysHoje.map((m) => (
                <option key={m.id} value={m.id || ""}>
                  {m.nome}
                </option>
              ))}
            </select>
          </div>

          {motoboySelecionado && (
            <div className="closure-details">
              <div className="money-info">
                <span>Total em aberto</span>
                <strong>
                  {motoboys.find(m => m.id === motoboySelecionado)?.taxas?.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) || 'R$ 0,00'}
                </strong>
              </div>

              <div className="action-buttons">
                <button 
                  onClick={handleCalcularEntregas} 
                  className="secondary-btn"
                  title="Recalcula as taxas de hoje usando os dados brutos de pedidos."
                >
                  <MdOutlineAccountBalanceWallet size={16} />
                  Recalcular
                </button>

                {/* ✅ 4. Props do AddOrderButtom corrigidas */}
                <AddOrderButtom
                  motoboyId={motoboySelecionado}
                  att={handleReload}
                />
              </div>

              <div className="process-payment-area">
                <button 
  className="primary-btn payment-btn"
  // Quando clicado, atualiza o motoboy para entregas: 0 e zera as taxas de hoje.
  onClick={async () => {
    if (!motoboySelecionado) return;
    if (confirm("Isto irá zerar o saldo do motoboy e fechar o caixa dele. Confirmar?")) {
      try {
        await updateDoc(doc(db, "motoboys", motoboySelecionado), {
          entregas: 0,
          taxas: 0,
          // Recua a data em 3 dias para desaparecer da lista de "Trabalharam Hoje"
          lastDelivery: new Date(Date.now() - 3 * 86400000).toLocaleString('pt-BR'),
          lastPayment: new Date().toLocaleString('pt-BR')
        });
        alert("Pagamento processado e caixa zerado com sucesso!");
        // Opcional: fechar o menu flutuante
        setIndex(0); 
      } catch (err) {
        console.log("Erro ao processar pagamento:", err);
        alert("Erro ao processar o pagamento.");
      }
    }
  }}
>
  <MdMonetizationOn size={18} />
  Finalizar e zerar
</button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

function parseDataPedido(dataStr: string): Date {
  const [data, hora] = dataStr.split(" às ");
  const [dia, mes, ano] = data.split("/").map(Number);
  const [h, m] = hora.split(":").map(Number);
  return new Date(ano, mes - 1, dia, h, m);
}

export default EntregasHoje;
