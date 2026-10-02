import { initializeApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
if (!['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('Harness somente local');
export const app = initializeApp({ projectId: 'demo-fluxo-pix', apiKey: 'fake-local-key', appId: 'local-test-app' });
export const db = getFirestore(app);
export const auth = getAuth(app);
export const functions = getFunctions(app, 'southamerica-east1');
connectFirestoreEmulator(db, '127.0.0.1', 8085);
connectAuthEmulator(auth, 'http://127.0.0.1:9098', { disableWarnings: true });
connectFunctionsEmulator(functions, '127.0.0.1', 5057);
export * from 'firebase/firestore';
export * from 'firebase/auth';
export async function getStorageLazy() { throw new Error('Storage fora do teste de checkout'); }
export async function getMessagingLazy() { return null; }
