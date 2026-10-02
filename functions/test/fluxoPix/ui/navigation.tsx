import { useSyncExternalStore } from 'react';
const subscribe = (callback: () => void) => { addEventListener('popstate', callback); return () => removeEventListener('popstate', callback); };
export const usePathname = () => useSyncExternalStore(subscribe, () => location.pathname);
export const useRouter = () => ({ push: (url: string) => { history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate')); }, replace: (url: string) => { history.replaceState({}, '', url); dispatchEvent(new PopStateEvent('popstate')); }, back: () => history.back() });
export const useParams = () => ({ orderId: usePathname().split('/').pop() });
export const useSearchParams = () => new URLSearchParams(location.search);
