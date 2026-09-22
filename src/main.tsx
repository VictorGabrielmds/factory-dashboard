// src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hospedada em vez de Google Fonts — tirava 2 domínios externos
// (fonts.googleapis.com + fonts.gstatic.com) do caminho crítico de
// carregamento e era uma causa direta de layout shift (CLS) por causa da
// troca de fonte-padrão-do-sistema → Inter no meio do primeiro render.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter/wght-italic.css';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);