// src/services/firebase.ts
import { initializeApp } from "firebase/app";
import type { Messaging } from "firebase/messaging";
import type { FirebaseStorage } from "firebase/storage";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  onSnapshot,
  query,
  doc,
  getDocs,
  updateDoc,
  getDoc,
  addDoc,
  QuerySnapshot,
  setDoc,
  deleteDoc,
  increment,
  where,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import type { DocumentData, CollectionReference } from "firebase/firestore";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";
import type { User } from "firebase/auth";

// ✅ CORRIGIDO: Puxando as variáveis de forma segura através do Vite
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
// Persistência local (IndexedDB) com suporte a múltiplas abas — sem isso,
// uma escrita feita offline (ex.: outbox/ do chat) só sobrevive enquanto a
// aba fica aberta; com fechar/recarregar a página no meio de uma queda de
// internet, a gravação enfileirada se perdia. multiTabManager evita que só
// a primeira aba aberta "vença" a persistência e as outras caiam pra memória.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const auth = getAuth(app);

// firebase/storage e firebase/messaging (~120KB) só são usados dentro do
// Chat e do upload de imagem de produto — telas já lazy. Carregá-los aqui
// eager fazia esses bytes entrarem no bundle que toda tela paga, mesmo quem
// nunca abre o chat. Os getters abaixo só importam a lib na primeira vez
// que alguém realmente precisa, e guardam o resultado (uma promise só).
let storagePromise: Promise<FirebaseStorage> | null = null;
export function getStorageLazy(): Promise<FirebaseStorage> {
  if (!storagePromise) {
    storagePromise = import("firebase/storage").then(({ getStorage }) => getStorage(app));
  }
  return storagePromise;
}

// getMessaging() lança exceção em navegadores sem suporte a push (Safari em
// certos modos, contexto sem HTTPS, etc.) — por isso o isSupported() antes.
let messagingPromise: Promise<Messaging | null> | null = null;
export function getMessagingLazy(): Promise<Messaging | null> {
  if (!messagingPromise) {
    messagingPromise = import("firebase/messaging").then(async ({ getMessaging, isSupported }) => {
      const suportado = await isSupported().catch(() => false);
      return suportado ? getMessaging(app) : null;
    });
  }
  return messagingPromise;
}

export {
  db,
  auth,
  // Firestore
  collection,
  onSnapshot,
  query,
  doc,
  updateDoc,
  getDoc,
  addDoc,
  setDoc,
  deleteDoc,
  increment,
  where,
  getDocs,
  writeBatch,
  QuerySnapshot,
  Timestamp,
  // Auth
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  type User,
  type DocumentData,
  type CollectionReference,
};