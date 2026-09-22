// src/types/Produto.ts

export interface Produto {
  id?: string;
  nome: string;
  descricao: string;
  preco: number;
  categoria: string;
  imagemUrl: string;
  disponivel: boolean;
  // Diferente de "disponivel" (esconde do cardápio de vez): esgotado ainda
  // mostra o item pro cliente, só sem poder comprar — pra ele saber que a
  // loja tem esse produto, só não tem agora.
  esgotado?: boolean;
  // Minutos médios pra preparar ESTE item — somado ao tempo de entrega pra
  // formar a antecedência mínima de agendamento (ver services/produtos.js no
  // app cliente/functions). Em branco = usa o padrão de configuracoes/geral.
  tempoPreparoMinutos?: number;
  // Item especial "fritura no local" (evento com data/hora e endereço
  // marcados, em vez de disponibilidade contínua) — quando true, o
  // ProdutosDashboard mostra os dois campos extra abaixo.
  friturasNoLocal?: boolean;
  // Data + hora aproximada do evento — "datetime-local" (calendário nativo
  // do navegador), guardado como string no formato do próprio input
  // (ex.: "2026-08-10T14:30").
  dataHoraFritura?: string;
  // Endereço do evento — texto livre, sem busca de CEP por enquanto.
  localFritura?: string;
  // Produtos permanentes do sistema usam um identificador estável. Eles
  // podem ser personalizados no painel, mas não convertidos ou excluídos.
  tipoSistema?: "agendamento_fritura";
  itemSistema?: boolean;
}
