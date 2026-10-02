// src/contexts/ThemeContext.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// ------------------------------------
// Types
// ------------------------------------

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

// ------------------------------------
// Context
// ------------------------------------

const STORAGE_KEY = "fs-theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme deve ser usado dentro de <ThemeProvider>");
  return ctx;
}

function lerTemaAtual(): Theme {
  const atributo = document.documentElement.getAttribute("data-theme");
  return atributo === "dark" ? "dark" : "light";
}

// ------------------------------------
// Provider
// ------------------------------------

// A escolha inicial já é aplicada de forma síncrona em index.html (evita
// flash de tema errado); aqui só sincronizamos o estado do React com ela.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(lerTemaAtual);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(STORAGE_KEY, theme);
    // Cor da status bar do navegador/app instalado — mesma lógica do
    // script inline em index.html, que só cobre o primeiro paint.
    const meta = document.getElementById("theme-color-meta");
    meta?.setAttribute("content", theme === "dark" ? "#0F1017" : "#F4F5F9");
  }, [theme]);

  const toggleTheme = () => setTheme((atual) => (atual === "dark" ? "light" : "dark"));

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
