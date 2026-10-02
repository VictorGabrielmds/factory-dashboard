// src/types/Robo.ts
import type { Pedido } from "./Pedido";

export type Neighborhood = {
  id: string;
  nome: string;
  setor_id: string; // Ex: 'turu', 'cohama'
  tags?: string[];
  nota?: string;
  // Coordenadas geocodificadas (opcional — nem todo bairro tem ainda).
  // Usadas pelo routeRobot para refinar a designação de rotas por
  // distância real, além de setor + horário.
  lat?: number;
  lng?: number;
};

// Interface simplificada apenas para uso interno no UI do Kanban
export type Order = {
  id: string;
  customerName: string;
  neighborhoodId: string;
  createdAt: Date;
};

export type Route = {
  id: string;
  title: string; // Ex: "Turu (~12:30)"
  sectorId: string;
  orders: Pedido[]; // Array com os pedidos originais para referência completa
  status: 'open' | 'transit' | 'finished';
  motoboy_id?: string;
  
  // Cache do horário médio (em minutos) para facilitar cálculo e ordenação
  // Ex: 750 (que seria 12:30)
  averageTimeMinutes: number; 
};