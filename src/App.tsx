// src/App.tsx
import "./util.css";
import "./App.css";

import { useAuth }       from "./hooks/useAuth";
import { ToastProvider } from "./contexts/ToastContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import ErrorBoundary     from "./components/ErrorBoundary/ErrorBoundary";
import Dashboard         from "./components/Dashboard/Dashboard";
import Login             from "./components/Login/Login";

function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <ThemeProvider>
        <div className="app-boot" role="status" aria-live="polite">
          <div className="app-boot-spinner" aria-hidden="true" />
          <span className="app-boot-label">Entrando…</span>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <ToastProvider>
        <ErrorBoundary>
          {user ? <Dashboard /> : <Login />}
        </ErrorBoundary>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;