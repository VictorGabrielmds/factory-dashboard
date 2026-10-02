// src/utils/dateUtils.ts

/** "2025-06-04 14:30:00" ou "2025-06-04T14:30:00" → Date */
export function parseISODateTime(str?: string | null): Date {
  if (!str) return new Date(0);
  return new Date(str.replace(" ", "T"));
}

/** "04/06/2025 às 14:30" → Date. Retorna epoch se falhar. */
export function parseBRDateTime(str?: string | null): Date {
  if (!str) return new Date(0);
  const [datePart, timePart] = str.split(" às ");
  const [day, month, year] = (datePart ?? "").split("/").map(Number);
  const [hour, minute] = (timePart ?? "00:00").trim().split(":").map(Number);
  if (!day || !month || !year) return new Date(0);
  return new Date(year, month - 1, day, hour || 0, minute || 0);
}

/** "Dia 08/12 - 19:30" ou "Dia 08/12" → Date (ano atual). Retorna null se inválido. */
export function parseAgendamentoDate(input?: string | null): Date | null {
  if (!input) return null;
  const match = input.match(/Dia\s+(\d{2})\/(\d{2})/);
  if (!match) return null;
  
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (isNaN(day) || isNaN(month) || month < 1 || month > 12) return null;

  const now = new Date();
  let year = now.getFullYear();

  // Prevenção da "Bomba do Réveillon": 
  // Se estamos em Dezembro (mês 11 no JS) e o agendamento é para Janeiro (mês 1), é para o ano que vem!
  if (now.getMonth() === 11 && month === 1) {
    year += 1;
  }

  return new Date(year, month - 1, day);
}

/** Extrai "DD/MM" de uma string de agendamento ("Dia 08/12...") */
export function extractDayMonth(str?: string | null): string | null {
  if (!str) return null;
  const match = str.match(/Dia (\d{2}\/\d{2})/);
  return match ? match[1] : null;
}

/** Extrai "HH:MM" de qualquer string */
export function extractTime(str?: string | null): string | null {
  if (!str) return null;
  const match = str.match(/(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

/** Compara apenas a parte de data (sem hora), usando hora local */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** True se `a` é estritamente depois de `b` (comparação por dia calendário) */
export function isAfterDay(a: Date, b: Date): boolean {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return da.getTime() > db.getTime();
}

/** Date → "DD/MM/YYYY às HH:MM" */
export function formatDate(date: Date): string {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} às ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Date → "DD/MM/YYYY" */
export function formatDateDay(date: Date): string {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** Date → "HH:MM" */
export function formatDateHour(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Formata qualquer string de data para "DD/MM/YYYY às HH:MM".
 * Aceita ISO ("2024-03-15 14:30") e BR ("15/03/2024 às 14:30").
 * Nunca lança erro — retorna o valor original como fallback.
 */
export function formatToDDMMYYYY(input?: string | null): string {
  if (!input) return "—";

  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (isoMatch) {
    const [, year, month, day, hour, min] = isoMatch;
    return `${day}/${month}/${year} às ${hour}:${min}`;
  }

  const brMatch = input.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+às\s+(\d{2}):(\d{2})/);
  if (brMatch) return input; // já está no formato correto

  console.warn("[formatToDDMMYYYY] Formato não reconhecido:", input);
  return input;
}

/** "DD/MM/YYYY" → "YYYY-MM-DD" */
export function brDateToISO(dataBR: string): string {
  const parts = dataBR.split("/");
  if (parts.length !== 3) return "";
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

/** Date → "YYYY-MM-DD" usando hora local (sem bug de fuso horário) */
export function dateToISOString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Title-case em nomes ("JOÃO SILVA" → "João Silva") */
export function toTitleCase(text?: string | null): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Normaliza nome de motoboy para comparação (remove acentos, lowercase, underscores) */
export function normalizeName(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .trim();
}

/** Remove acentos de uma string */
export function removeAccents(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}