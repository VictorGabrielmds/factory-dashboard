// src/types/Horario.ts
// Espelha functions/src/services/horario.js (DIAS_SEMANA/DIA_PADRAO) — o
// doc configuracoes/horario é lido/gravado direto pelo painel (staff-only
// nas firestore.rules) e consultado pelo app cliente via Cloud Function
// consultarHorarioFuncionamento.
//
// Um dia é uma LISTA DE TURNOS, não um único abre/fecha — isso cobre, com um
// conceito só: horário de almoço (dois turnos com vão entre eles) e dias em
// que delivery/retirada funcionam em janelas diferentes (cada turno liga
// delivery/retirada independentemente).

export const DIAS_SEMANA = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"] as const;

export type DiaSemana = (typeof DIAS_SEMANA)[number];

export const DIA_LABEL: Record<DiaSemana, string> = {
  domingo: "Domingo",
  segunda: "Segunda",
  terca: "Terça",
  quarta: "Quarta",
  quinta: "Quinta",
  sexta: "Sexta",
  sabado: "Sábado",
};

export interface Turno {
  id: string;
  abre: string; // "HH:MM"
  fecha: string; // "HH:MM"
  deliveryAtivo: boolean;
  retiradaAtivo: boolean;
}

export interface DiaHorario {
  ativo: boolean;
  turnos: Turno[];
}

export type HorarioFuncionamento = Record<DiaSemana, DiaHorario>;

// Doc configuracoes/horario completo: os 7 dias (com seus turnos) + duas
// configurações globais — até quantos dias à frente dá pra agendar, e o
// intervalo entre os horários mostrados no checkout (ex.: 9:00, 9:30, 10:00
// vs. 9:00, 9:20, 9:40).
export interface ConfiguracaoHorario {
  diasAntecedencia: number;
  intervaloMinutos: number;
  dias: HorarioFuncionamento;
}

export const DIAS_ANTECEDENCIA_PADRAO = 1;
export const INTERVALO_MINUTOS_PADRAO = 30;
export const OPCOES_INTERVALO_MINUTOS = [10, 15, 20, 30, 45, 60] as const;

export function configuracaoHorarioPadrao(): ConfiguracaoHorario {
  return {
    diasAntecedencia: DIAS_ANTECEDENCIA_PADRAO,
    intervaloMinutos: INTERVALO_MINUTOS_PADRAO,
    dias: horarioFuncionamentoPadrao(),
  };
}

function gerarId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `turno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function turnoPadrao(): Turno {
  return { id: gerarId(), abre: "18:00", fecha: "23:00", deliveryAtivo: true, retiradaAtivo: true };
}

export function diaHorarioVazio(): DiaHorario {
  return { ativo: false, turnos: [] };
}

export function horarioFuncionamentoPadrao(): HorarioFuncionamento {
  return DIAS_SEMANA.reduce((acc, dia) => {
    acc[dia] = diaHorarioVazio();
    return acc;
  }, {} as HorarioFuncionamento);
}

// Cópia profunda de um dia, com turnos ganhando IDs novos — usada tanto pra
// "copiar horário de outro dia" quanto pra normalizar o que vem do Firestore
// (nunca reaproveita a referência/array salva).
export function clonarDiaHorario(dia: DiaHorario): DiaHorario {
  return {
    ativo: dia.ativo,
    turnos: dia.turnos.map((turno) => ({ ...turno, id: gerarId() })),
  };
}
