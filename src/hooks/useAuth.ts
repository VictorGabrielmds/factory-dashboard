// src/hooks/useAuth.ts
import { useState, useEffect } from "react";
import { auth, onAuthStateChanged, type User } from "../services/firebase";

interface AuthState {
  user: User | null;
  loading: boolean;
}

export function useAuth(): AuthState {
  const [user, setUser]       = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // onAuthStateChanged persiste o login via browserLocalPersistence
    // (padrão do Firebase Web SDK) — o usuário continua logado após fechar o browser.
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return { user, loading };
}