// src/types/ZonaEntrega.ts

export interface ZonaEntrega {
  id?: string;
  bairro: string;
  taxa: number;
  ativo: boolean;
  // Tempo estimado de moto até esse bairro (partindo da loja) — usado como
  // antecedência mínima de agendamento no app cliente: um bairro a 40min não
  // pode ficar disponível pra daqui 10min. Opcional: cai no tempo padrão
  // (configuracoes/entrega.tempoEntregaPadraoMinutos) quando ausente.
  tempoEntregaMinutos?: number;
}
