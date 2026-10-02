// src/components/Dashboard/Dashboard.tsx
import { lazy, Suspense, useEffect, useState } from "react";
import "./Dashboard.css";
import logow from "../../assets/images/logof-white.svg";
import logob from "../../assets/images/logof-bluelight.svg";

import OrderDashboard    from "../OrderDashboard/OrderDashboard";
import MotoboyDashboard  from "../MotoboyDashboard/MotoboyDashboard";

// Carregadas sob demanda: só uma tela aparece por vez (dashboardType), mas
// antes as 4 eram baixadas e processadas todas juntas no carregamento inicial
// — o build gerava um único arquivo de ~1.8MB. Cada uma agora vira seu
// próprio pedaço, baixado só quando o usuário realmente abre aquela aba.
const MotoboyAnalytics  = lazy(() => import("../MotoboyAnalytics/MotoboyAnalytics"));
const CaixaDashboard    = lazy(() => import("../CaixaDashboard/CaixaDashboard"));
const FriturasDashboard = lazy(() => import("../FriturasDashboard/FriturasDashboard"));
const ChatDashboard     = lazy(() => import("../ChatDashboard/ChatDashboard")); // ✅ NOVO MÓDULO DE CHAT
const CozinhaDashboard  = lazy(() => import("../CozinhaDashboard/CozinhaDashboard")); // ✅ TELA DA COZINHA
const PDVDashboard      = lazy(() => import("../PDVDashboard/PDVDashboard")); // Cardápio + Cupons do app cliente
const ClientesDashboard = lazy(() => import("../ClientesDashboard/ClientesDashboard")); // Resumo de clientes/itens

import {
  MdOutlineDeliveryDining,
  MdOutlineStorefront,
  MdOutlineAnalytics,
  MdOutlineDoneAll,
  MdOutlineWhatshot,
  MdOutlineChat, // ✅ ÍCONE DO CHAT
  MdOutlineRestaurant, // ✅ ÍCONE DA COZINHA
  MdOutlinePointOfSale, // Ícone do PDV
  MdOutlinePeopleAlt, // Ícone da tela de Clientes
  MdOutlineNightlight,
  MdOutlineLightMode,
  MdLogout,
  MdMenu,
  MdMenuOpen,
} from "react-icons/md";

import { auth, signOut, db, doc, onSnapshot } from "../../services/firebase";
import { useToast }      from "../../contexts/ToastContext";
import { useTheme }      from "../../contexts/ThemeContext";

// ------------------------------------
// Types
// ------------------------------------

// ✅ ADICIONADO O TIPO 6 PARA O CHAT, 7 PARA A COZINHA, 8 PARA O PDV (cardápio + cupons) E 9 PARA CLIENTES
type DashboardType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

interface NavItem {
  type: DashboardType;
  icon: React.ReactNode;
  label: string;
  group?: string;
}

// ------------------------------------
// Constants
// ------------------------------------

// O menu acompanha o fluxo real do trabalho: operação, gestão, produção e venda.
const NAV_ITEMS: NavItem[] = [
  { type: 1, icon: <MdOutlineStorefront />,     label: "Pedidos", group: "Operação" },
  { type: 2, icon: <MdOutlineDeliveryDining />, label: "Motoboys"   },
  { type: 6, icon: <MdOutlineChat />,           label: "Chat"       },
  { type: 5, icon: <MdOutlineWhatshot />,       label: "Frituras"   },
  { type: 4, icon: <MdOutlineDoneAll />,        label: "Caixa", group: "Gestão" },
  { type: 9, icon: <MdOutlinePeopleAlt />,      label: "Clientes"   },
  { type: 3, icon: <MdOutlineAnalytics />,      label: "Resumo"     },
  { type: 7, icon: <MdOutlineRestaurant />,     label: "Cozinha", group: "Produção" },
  { type: 8, icon: <MdOutlinePointOfSale />,    label: "PDV", group: "Venda" },
];

const SUBTITLES: Record<DashboardType, string> = {
  1: "Pedidos da Fábrica de Salgados",
  7: "Fila de preparo da Cozinha", // ✅ SUBTÍTULO DA COZINHA
  2: "Equipe, entregas e acertos do dia",
  3: "Resumo da Fábrica de Salgados",
  6: "Central de Atendimento via WhatsApp", // ✅ SUBTÍTULO DO CHAT
  5: "Agenda de Frituras no Local",
  4: "Financeiro da Fábrica de Salgados",
  8: "Gestão do App Cliente",
  9: "Resumo de clientes, itens e recompra",
};

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

// O robô de impressão (RoboImpressaoDelivery, PC físico ao lado da
// impressora) grava heartbeat em sistema/robo_impressao a cada ~1 min.
// Sem checar a idade do heartbeat aqui, um robô travado (não fechado
// normalmente) ficaria com online:true parado no Firestore para sempre.
const TOLERANCIA_HEARTBEAT_MS = 4 * 60 * 1000;

interface RoboStatus {
  online: boolean;
  ultimoHeartbeat: number | null;
}

// ------------------------------------
// Component
// ------------------------------------

const KitchenStandalone = () => {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Cozinha · Fábrica";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <main className="cozinha-standalone">
      <Suspense fallback={<div className="dashboard-loading"><div className="spinner" /></div>}>
        <CozinhaDashboard />
      </Suspense>
    </main>
  );
};

const ChatStandalone = () => {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Chat · Fábrica";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <main className="chat-standalone">
      <Suspense fallback={<div className="dashboard-loading"><div className="spinner" /></div>}>
        <ChatDashboard />
      </Suspense>
    </main>
  );
};

const DashboardShell = () => {
  const [dashboardType, setDashboardType] = useState<DashboardType>(1);
  const [logoHovered, setLogoHovered]     = useState(false);
  const [roboStatus, setRoboStatus]       = useState<RoboStatus | null>(null);
  const [agora, setAgora]                 = useState(() => Date.now());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("factoryDashboard:sidebarCollapsed") === "true";
    } catch {
      return false;
    }
  });
  const { addToast }                      = useToast();
  const { theme, toggleTheme }            = useTheme();

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "sistema", "robo_impressao"), (snap) => {
      if (!snap.exists()) { setRoboStatus(null); return; }
      const dados = snap.data();
      setRoboStatus({
        online: dados.online === true,
        ultimoHeartbeat: dados.ultimoHeartbeat?.toMillis?.() ?? null,
      });
    });
    return () => unsub();
  }, []);

  // "Offline há Xmin" precisa envelhecer sozinho, mesmo sem novo snapshot.
  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("factoryDashboard:sidebarCollapsed", String(sidebarCollapsed));
    } catch {
      // Preferência visual não essencial.
    }
  }, [sidebarCollapsed]);

  const roboOnline = !!(
    roboStatus?.online &&
    roboStatus.ultimoHeartbeat &&
    agora - roboStatus.ultimoHeartbeat < TOLERANCIA_HEARTBEAT_MS
  );

  const roboLabel = !roboStatus
    ? "Robô de impressão: sem dados"
    : roboOnline
    ? "Robô de impressão: online"
    : roboStatus.ultimoHeartbeat
    ? `Robô de impressão: offline há ${Math.round((agora - roboStatus.ultimoHeartbeat) / 60000)} min`
    : "Robô de impressão: offline";
  const currentSection = NAV_ITEMS.find(item => item.type === dashboardType)?.label ?? "Painel";

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch {
      addToast("Erro ao sair. Tente novamente.", "error");
    }
  };

  const handleNavigation = (type: DashboardType) => {
    if (type !== 7 && type !== 6) {
      setDashboardType(type);
      return;
    }

    const standaloneName = type === 7 ? "Cozinha" : "Chat";
    const standaloneUrl = new URL(window.location.href);
    standaloneUrl.searchParams.set("view", type === 7 ? "cozinha" : "chat");
    standaloneUrl.hash = "";

    const standaloneWindow = window.open(standaloneUrl.toString(), "_blank");
    if (standaloneWindow) {
      standaloneWindow.opener = null;
    } else {
      addToast(`O navegador bloqueou a nova tela do ${standaloneName}. Permita pop-ups para este sistema.`, "warning");
    }
  };

  return (
    <div className={`dashboard-factory${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>

      {/* ── Sidebar / bottom nav ── */}
      <nav className="sidebar">
        <div className="nav-top">
          <div className="nav-brand">
            <img
              src={logoHovered ? logob : logow}
              onMouseEnter={() => setLogoHovered(true)}
              onMouseLeave={() => setLogoHovered(false)}
              alt=""
              className="nav-logo"
            />
            <div className="nav-brand-copy">
              <strong>Fábrica</strong>
              <span>Painel de operação</span>
            </div>
          </div>

          <ul className="buttons-list" role="list" aria-label="Navegação principal">
            {NAV_ITEMS.map(({ type, icon, label, group }) => (
              <li key={type} className={group ? "nav-group-start" : undefined}>
                {group && <span className="nav-group-label">{group}</span>}
                <button
                  className={`icon-button-filled${dashboardType === type ? " active" : ""}`}
                  onClick={() => handleNavigation(type)}
                  aria-label={type === 7 || type === 6 ? `${label} — abrir em nova tela` : label}
                  aria-pressed={type === 7 || type === 6 ? undefined : dashboardType === type}
                  title={type === 7 || type === 6 ? `Abrir ${label} em nova tela` : label}
                >
                  <span className="nav-item-icon">{icon}</span>
                  <span className="nav-item-label">{label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="nav-bottom">
          <button
            type="button"
            className="icon-button-filled sidebar-toggle-row"
            onClick={() => setSidebarCollapsed(value => !value)}
            aria-label={sidebarCollapsed ? "Expandir menu" : "Recolher menu"}
            title={sidebarCollapsed ? "Expandir menu" : "Recolher menu"}
          >
            <span className="nav-item-icon">
              {sidebarCollapsed ? <MdMenu size={18} /> : <MdMenuOpen size={18} />}
            </span>
            <span className="nav-item-label">Recolher menu</span>
          </button>
          <button
            className="icon-button-filled"
            onClick={handleLogout}
            aria-label="Sair"
            title="Sair"
          >
            <span className="nav-item-icon"><MdLogout /></span>
            <span className="nav-item-label">Sair</span>
          </button>
          <p className="nav-version">v 1.80</p>
        </div>
      </nav>

      {/* ── Conteúdo principal ── */}
      <div className="content">
        <header>
          <div className="title">
            <span className="dashboard-greeting">{getGreeting()}, Nilton</span>
            <div className="dashboard-title-row">
              <h1 className="md-title-large">{currentSection}</h1>
              <span className="md-title-medium">{SUBTITLES[dashboardType]}</span>
            </div>
          </div>
          <div className="header-actions">
            {roboStatus && (
              <div
                className={`robo-status-badge${roboOnline ? " online" : " offline"}`}
                title={roboLabel}
              >
                <span className="dot" />
                <span>{roboOnline ? "Robô online" : "Robô offline"}</span>
              </div>
            )}
            <button
              className="icon-button-outline"
              onClick={toggleTheme}
              aria-label="Alternar tema"
              title={theme === "dark" ? "Mudar para tema claro" : "Mudar para tema escuro"}
            >
              {theme === "dark" ? <MdOutlineLightMode /> : <MdOutlineNightlight />}
            </button>
          </div>
        </header>

        <main className="dashboard-view fade-in" key={dashboardType}>
          <Suspense fallback={<div className="dashboard-loading"><div className="spinner" /></div>}>
            {dashboardType === 1 && <OrderDashboard />}
            {dashboardType === 7 && <CozinhaDashboard />} {/* ✅ TELA DA COZINHA RENDERIZADA */}
            {dashboardType === 2 && <MotoboyDashboard />}
            {dashboardType === 3 && <MotoboyAnalytics />}
            {dashboardType === 6 && <ChatDashboard />} {/* ✅ TELA DE CHAT RENDERIZADA */}
            {dashboardType === 5 && <FriturasDashboard />}
            {dashboardType === 4 && <CaixaDashboard />}
            {dashboardType === 8 && <PDVDashboard />}
            {dashboardType === 9 && <ClientesDashboard />}
          </Suspense>
        </main>
      </div>

    </div>
  );
};

const Dashboard = () => {
  const standaloneView = new URLSearchParams(window.location.search).get("view");

  if (standaloneView === "cozinha") return <KitchenStandalone />;
  if (standaloneView === "chat") return <ChatStandalone />;
  return <DashboardShell />;
};

export default Dashboard;
