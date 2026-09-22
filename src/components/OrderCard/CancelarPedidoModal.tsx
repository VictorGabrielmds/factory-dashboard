// src/components/OrderCard/CancelarPedidoModal.tsx
import { useState } from "react";
import type { Pedido } from "../../types/Pedido";
import { apiFetch, BASE_URL } from "../../services/api";
import ModalBase from "../ModalBase/ModalBase";
import { useToast } from "../../contexts/ToastContext";
import { toTitleCase } from "../../utils/dateUtils";
import "./CancelarPedidoModal.css";

interface CancelarPedidoModalProps {
  orderId: string;
  pedido: Pedido;
  onClose: () => void;
}

export default function CancelarPedidoModal({ orderId, pedido, onClose }: CancelarPedidoModalProps) {
  const { addToast } = useToast();
  const [cancelando, setCancelando] = useState(false);

  async function handleConfirmar() {
    setCancelando(true);
    try {
      // Cancelar é um comando do servidor: ele lê o estado atual dentro de
      // transação, registra o operador e mantém uma repetição de rede
      // idempotente. A mudança de status ainda aciona o gatilho já existente
      // de aviso ao cliente — mas só uma vez, se o pedido não estava cancelado.
      const response = await apiFetch(`${BASE_URL}/pedidos`, {
        method: "POST",
        body: JSON.stringify({ action: "cancelar", orderId }),
      });
      const payload = await response.json().catch(() => null) as {
        error?: string;
        jaCancelado?: boolean;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error || "Não foi possível cancelar o pedido.");
      }
      addToast(
        payload?.jaCancelado
          ? "Este pedido já estava cancelado."
          : "Pedido cancelado. O aviso no WhatsApp foi colocado na fila de envio.",
        "success"
      );
      onClose();
    } catch (erro) {
      console.error("Erro ao cancelar pedido:", erro);
      addToast(
        erro instanceof Error ? erro.message : "Erro ao cancelar — tente novamente.",
        "error"
      );
    } finally {
      setCancelando(false);
    }
  }

  return (
    <ModalBase isOpen onClose={onClose} title={`Cancelar pedido #${orderId}`}>
      <div className="cp-container">
        <p className="cp-pergunta">
          Cancelar o pedido de <strong>{toTitleCase(pedido.nome_destinatario)}</strong>?
        </p>
        <p className="cp-aviso">
          O sistema coloca um aviso de cancelamento na fila do WhatsApp e acompanha o resultado.
        </p>

        {pedido.pix_confirmado === true && (
          <div className="cp-aviso-pix">
            ⚠️ O PIX desse pedido já foi confirmado. Cancelar <strong>não estorna o pagamento
            automaticamente</strong> — o estorno precisa ser feito manualmente pelo Asaas.
          </div>
        )}

        <div className="cp-acoes">
          <button type="button" className="cp-btn-voltar" onClick={onClose} disabled={cancelando}>
            Voltar
          </button>
          <button type="button" className="cp-btn-confirmar" onClick={handleConfirmar} disabled={cancelando}>
            {cancelando ? "Cancelando..." : "Cancelar pedido"}
          </button>
        </div>
      </div>
    </ModalBase>
  );
}
