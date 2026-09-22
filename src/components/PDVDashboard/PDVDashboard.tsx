// src/components/PDVDashboard/PDVDashboard.tsx
import { lazy, Suspense, useState } from "react";
import "./PDVDashboard.css";
import {
  MdOutlineFastfood,
  MdOutlineLocalOffer,
  MdOutlineLocalShipping,
  MdOutlineAccessTime,
  MdOutlineStorefront,
  MdManageAccounts,
  MdOutlineReceiptLong,
} from "react-icons/md";

const ProdutosDashboard     = lazy(() => import("../ProdutosDashboard/ProdutosDashboard"));
const CuponsDashboard       = lazy(() => import("../CuponsDashboard/CuponsDashboard"));
const ZonasEntregaDashboard = lazy(() => import("../PDVDashboard/ZonasEntregaDashboard"));
const HorarioDashboard      = lazy(() => import("../PDVDashboard/HorarioDashboard"));
const ConfiguracoesGeraisDashboard = lazy(() => import("../PDVDashboard/ConfiguracoesGeraisDashboard"));
const ClientesBloqueioDashboard = lazy(() => import("../PDVDashboard/ClientesBloqueioDashboard"));
const FiscalDashboard = lazy(() => import("../FiscalDashboard/FiscalDashboard"));

type AbaPDV = "cardapio" | "cupons" | "entrega" | "horario" | "clientes" | "geral" | "fiscal";

const ABAS: { id: AbaPDV; label: string; icon: React.ReactNode }[] = [
  { id: "cardapio", label: "Cardápio", icon: <MdOutlineFastfood /> },
  { id: "entrega",  label: "Entrega",  icon: <MdOutlineLocalShipping /> },
  { id: "horario",  label: "Horário",  icon: <MdOutlineAccessTime /> },
  { id: "cupons",   label: "Cupons",   icon: <MdOutlineLocalOffer /> },
  { id: "clientes", label: "Clientes", icon: <MdManageAccounts /> },
  { id: "geral",    label: "Loja",     icon: <MdOutlineStorefront /> },
  { id: "fiscal",   label: "Fiscal",   icon: <MdOutlineReceiptLong /> },
];

export default function PDVDashboard() {
  const [aba, setAba] = useState<AbaPDV>("cardapio");

  return (
    <div className="pdv-container">
      <div className="pdv-abas-wrap">
        <div className="pdv-abas" role="tablist" aria-label="Seções do PDV">
          {ABAS.map(({ id, label, icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={aba === id}
              className={`pdv-aba${aba === id ? " active" : ""}`}
              onClick={() => setAba(id)}
            >
              <span className="pdv-aba-icon" aria-hidden="true">{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="pdv-content">
        <Suspense fallback={<div className="dashboard-loading"><div className="spinner" /></div>}>
          {aba === "cardapio" && <ProdutosDashboard />}
          {aba === "cupons" && <CuponsDashboard />}
          {aba === "entrega" && <ZonasEntregaDashboard />}
          {aba === "horario" && <HorarioDashboard />}
          {aba === "clientes" && <ClientesBloqueioDashboard />}
          {aba === "geral" && <ConfiguracoesGeraisDashboard />}
          {aba === "fiscal" && <FiscalDashboard />}
        </Suspense>
      </div>
    </div>
  );
}
