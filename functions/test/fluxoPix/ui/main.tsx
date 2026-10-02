import React, { Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from './firebase';
import { usePathname } from './navigation';
import { CarrinhoProvider, useCarrinho } from '@cliente/contexts/CarrinhoContext';
import Carrinho from '@cliente/app/carrinho/page';
import Pedido from '@cliente/app/pedido/[orderId]/page';
import { ToastProvider } from '@painel/contexts/ToastContext';

const OrderDashboard = lazy(() => import('@painel/components/OrderDashboard/OrderDashboard'));

const painel = location.pathname.startsWith('/dashboard');
if (painel) {
  await import('@painel/index.css'); await import('@painel/App.css');
} else await import('@cliente/app/globals.css');

// Login exclusivo de fixtures; o fluxo OTP/WhatsApp de produção não é exercitado.
await signInWithEmailAndPassword(auth, `${painel ? 'operador-teste' : 'cliente-teste'}@fabrica.test`, 'Teste-local-123!');
(window as any).__test = {
  call: async (name: string, data: unknown) => (await httpsCallable(functions, name)(data)).data,
};
function Catalogo() {
  const c = useCarrinho();
  return <main><h1>Catálogo sintético para teste</h1>{c.produtos.filter(p => !p.itemSistema).map(p => <button key={p.id} onClick={() => c.adicionar(p.id)}>Adicionar {p.nome}</button>)}<a href="/carrinho">Ir para o carrinho</a></main>;
}
function SondaCheckout() {
  const { finalizarPedido } = useCarrinho();
  useEffect(() => { (window as any).__test.finalizar = finalizarPedido; }, [finalizarPedido]);
  return null;
}
function App() {
  const path = usePathname();
  return painel
    ? <Suspense fallback={<p>Carregando painel...</p>}><ToastProvider><OrderDashboard/></ToastProvider></Suspense>
    : <CarrinhoProvider><SondaCheckout/>{path.startsWith('/pedido/') ? <Pedido/> : path === '/carrinho' ? <Carrinho/> : <Catalogo/>}</CarrinhoProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
