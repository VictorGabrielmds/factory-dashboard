import { useState } from "react";
import {
  getDocs,
  collection,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { db } from "../../services/firebase"; // ajuste o caminho se necessário

function ExcluirPedidosAntigos() {
  const [data, setData] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [mensagem, setMensagem] = useState("");

  // Converte string "2025-06-04 06:06:50" para objeto Date
  const stringParaData = (dataStr: string): Date | null => {
    const partes = dataStr.split(" ");
    if (partes.length !== 2) return null;

    const [data, hora] = partes;
    return new Date(`${data}T${hora}`);
  };

  const handleExcluir = async () => {
    if (!data) {
      setMensagem("Selecione uma data.");
      return;
    }

    setCarregando(true);
    setMensagem("");

    try {
      const dataLimite = new Date(data + "T00:00:00");

      const pedidosRef = collection(db, "pedidos");
      const snapshot = await getDocs(pedidosRef);

      const docsAntigos = snapshot.docs.filter((docSnap) => {
        const dataVendaStr = docSnap.data().data_venda;
        const dataVenda = stringParaData(dataVendaStr);
        return dataVenda && dataVenda < dataLimite;
      });

      if (docsAntigos.length === 0) {
        setMensagem("Nenhum pedido antigo encontrado.");
        setCarregando(false);
        return;
      }

      await Promise.all(
        docsAntigos.map((docSnap) =>
          deleteDoc(doc(db, "pedidos", docSnap.id))
        )
      );

      setMensagem(`Excluídos ${docsAntigos.length} pedidos antigos.`);
    } catch (error) {
      console.error("Erro ao excluir pedidos:", error);
      setMensagem("Erro ao excluir pedidos.");
    } finally {
      setCarregando(false);
    }
  };

  return (
    <div className="excluir-pedidos">
      <label>Excluir pedidos com data de venda anterior a:</label>
      <input
        type="date"
        value={data}
        onChange={(e) => setData(e.target.value)}
      />
      <button onClick={handleExcluir} disabled={carregando || !data}>
        {carregando ? "Excluindo..." : "Excluir pedidos antigos"}
      </button>
      {mensagem && <p>{mensagem}</p>}
    </div>
  );
}

export default ExcluirPedidosAntigos;
