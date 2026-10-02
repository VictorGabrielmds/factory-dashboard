// src/components/Shared/LazyDatePicker.tsx
// react-datepicker + date-fns só entram no bundle quando o calendário é
// realmente aberto — em OrderDashboard/MotoboyDashboard (as únicas telas
// eager do app) isso tirava ~15% do chunk compartilhado que toda tela paga,
// mesmo pra quem nunca clica no calendário (usa só Hoje/Ontem/Amanhã).
import { lazy } from "react";

const LazyDatePicker = lazy(async () => {
  await import("react-datepicker/dist/react-datepicker.css");
  const mod = await import("react-datepicker");
  return { default: mod.default };
});

export default LazyDatePicker;
