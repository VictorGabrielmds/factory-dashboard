// src/types/Cupom.ts
import type { Timestamp } from "firebase/firestore";

export interface Cupom {
  id?: string;
  codigo: string;
  tipo: "fixo" | "percentual";
  valor: number;
  ativo: boolean;
  expiraEm: Timestamp | null;
  limiteUsos: number | null;
  usosCount: number;
}
