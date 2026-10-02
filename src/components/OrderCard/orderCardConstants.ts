// Constantes compartilhadas do OrderCard.
// Ficam num arquivo à parte porque um arquivo que exporta componente(s) e
// outros valores ao mesmo tempo quebra o Fast Refresh — o arquivo do
// componente deve exportar só o componente.

export const PAYMENT_LABELS: Record<string, string> = {
  "01": "Dinheiro",
  "03": "Cartão de crédito",
  "04": "Cartão de débito",
  "10": "Vale Refeição / Alimentação",
  "17": "PIX",
  "42": "Cartão de crédito online",
  "43": "iFood pago",
  "47": "Fiado",
  "48": "Ticket Online",
  "99": "Outras",
};

export const OUT_OF_BOX_KEYWORDS = ["MINI PIZZA", "PÃO DE METRO"] as const;