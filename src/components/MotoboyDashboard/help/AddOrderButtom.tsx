import { doc, updateDoc, setDoc, increment, collection } from "firebase/firestore";
import { db } from "../../../services/firebase";

import { MdAdd, MdArrowRightAlt, MdCheck, MdClose } from "react-icons/md";
import "../MotoboyDashboard.css";
import { useState } from "react";

type AddOrderButtonProps = {
  att: () => void;
  // ⚠️ ID do documento do motoboy, NÃO o nome. Antes isto recebia o nome e
  // reconstruía o ID normalizando — o que passou a ser errado quando a tela
  // de motoboys ganhou "editar nome": o ID fica congelado como estava no
  // cadastro, então renomear faria o extra cair num doc inexistente.
  motoboyId?: string;
};

export default function AddOrderButton({ motoboyId, att }: AddOrderButtonProps) {
  const [index, setIndex] = useState(0);
  const [numberValue, setNumberValue] = useState("");
  const [reasonValue, setReasonValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [thereError, setThereError] = useState(false);

  // Handle input motivo
  const handleReasonChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setReasonValue(event.target.value);
    setThereError(false);
  };

  // Handle input valor em reais
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = event.target.value.replace(/\D/g, ""); // só números
    const numericValue = Number(inputValue);

    const formattedValue = (numericValue / 100).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      minimumFractionDigits: 2,
    });

    setNumberValue(formattedValue);
    setThereError(false);
  };

  // Função para avançar etapas
  async function nextStep(command: string | null): Promise<void> {
    if (command === null || command === "0") return;

    setIsLoading(true);
    setThereError(false);

    try {
      switch (command) {
        case "next":
          // validações
          if (index === 1 && (!numberValue || numberValue === "0")) {
            setThereError(true);
            return;
          }
          if (index === 2 && (!reasonValue || reasonValue === "0")) {
            setThereError(true);
            return;
          }

          if (index === 2) {
            const result = await addToBd();
            if (result === 0) {
              resetForm();
            }
          } else {
            setIndex((prev) => prev + 1);
          }
          break;

        case "cancel":
          resetForm();
          break;

        default:
          console.log("comando desconhecido");
      }
    } finally {
      setIsLoading(false);
    }
  }

  // Função que grava no Firebase
  async function addToBd(): Promise<number> {
    if (!motoboyId) {
      setThereError(true);
      console.error("Motoboy não definido");
      return 1;
    }

    try {
      const valorFloat = Number(numberValue.replace(/\D/g, "")) / 100;
      const pedidoRef = doc(collection(db, "pedidos")); 
      const pedidoId = pedidoRef.id;

      const timestamp = new Date();
      const dataFormatada = timestamp.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
      const horaFormatada = timestamp.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const resultado = `${dataFormatada} às ${horaFormatada}`;

      const ano = timestamp.getFullYear();
      const mes = String(timestamp.getMonth() + 1).padStart(2, "0");
      const dia = String(timestamp.getDate()).padStart(2, "0");
      const horas = String(timestamp.getHours()).padStart(2, "0");
      const minutos = String(timestamp.getMinutes()).padStart(2, "0");
      const segundos = String(timestamp.getSeconds()).padStart(2, "0");

      const resultadoVenda = `${ano}-${mes}-${dia} ${horas}:${minutos}:${segundos}`;

      const novoPedido = {
        valor_taxa: valorFloat.toString(),
        data_saida: resultado,
        data_venda: resultadoVenda,
        status: 5,
        order_id: pedidoId, // ✅ Usa o ID gerado
        descricao_item: [],
        nome_destinatario: reasonValue, // ✅ Salva o motivo aqui para aparecer na lista
        avulso: true,
        motoboy_id: motoboyId,
      };

      // cria/atualiza o pedido
      await setDoc(pedidoRef, novoPedido, { merge: true });
      console.log("Pedido adicionado com ID:", pedidoId);

      // atualiza dados do motoboy
      const motoboyRef = doc(db, "motoboys", motoboyId);
      await updateDoc(motoboyRef, {
        taxas: increment(valorFloat),
        entregas: increment(1),
      });

      att();
      return 0; // sucesso
    } catch (error) {
      console.error("Erro ao adicionar no Firebase:", error);
      setThereError(true);
      return 1; // erro
    }
  }

  function resetForm() {
    setIndex(0);
    setNumberValue("");
    setReasonValue("");
    setThereError(false);
  }

  return (
    <div className={`add-order-div${index > 0 ? " is-open" : ""}`}>
      {index === 0 ? (
        <button
          type="button"
          className="secondary-btn"
          onClick={() => setIndex(1)}
          disabled={isLoading}
        >
          <MdAdd size={18} /> Lançar extra
        </button>
      ) : (
        <div className="add-order-step">
          <div className="add-order-step-copy">
            <span>Etapa {index} de 2</span>
            <strong>{index === 1 ? "Qual é o valor do extra?" : "Qual é o motivo do lançamento?"}</strong>
          </div>

          <div className="add-order-form">
            {index === 1 ? (
              <input
                type="text"
                inputMode="numeric"
                autoFocus
                disabled={isLoading}
                value={numberValue}
                onChange={handleChange}
                placeholder="R$ 0,00"
                aria-label="Valor do lançamento extra"
                aria-invalid={thereError}
                className={`step-input input-true${thereError ? " error-class" : ""}`}
              />
            ) : (
              <input
                type="text"
                autoFocus
                disabled={isLoading}
                value={reasonValue}
                onChange={handleReasonChange}
                placeholder="Ex.: pedágio, retorno ou espera"
                aria-label="Motivo do lançamento extra"
                aria-invalid={thereError}
                className={`step-input input-true${thereError ? " error-class" : ""}`}
              />
            )}

            <button
              type="button"
              disabled={isLoading}
              className="index-button cancel input-true"
              onClick={() => nextStep("cancel")}
              aria-label="Cancelar lançamento"
              title="Cancelar"
            >
              <MdClose />
            </button>

            <button
              type="button"
              disabled={isLoading}
              className="index-button next input-true"
              onClick={() => nextStep("next")}
              aria-label={index === 1 ? "Continuar" : "Salvar lançamento"}
              title={index === 1 ? "Continuar" : "Salvar lançamento"}
            >
              {index === 1 ? <MdArrowRightAlt /> : <MdCheck />}
            </button>
          </div>

          {thereError && (
            <p className="add-order-error">
              {index === 1 ? "Informe um valor maior que zero." : "Descreva o motivo do lançamento."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
