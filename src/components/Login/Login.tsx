// src/components/Login/Login.tsx
import { useState } from "react";
import { auth, signInWithEmailAndPassword } from "../../services/firebase";
import "./Login.css";
import logo from "../../assets/images/logof-blue.svg";
// ✅ IMPORTADO: Ícones para o botão de ver senha
import { MdLockOutline, MdVisibility, MdVisibilityOff } from "react-icons/md"; 

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false); // ✅ NOVO ESTADO

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
        setError("E-mail ou senha incorretos.");
      } else if (code === "auth/too-many-requests") {
        setError("Muitas tentativas. Aguarde alguns minutos.");
      } else if (code === "auth/invalid-email") {
        setError("E-mail inválido.");
      } else {
        setError("Erro ao entrar. Tente novamente.");
        console.error(err);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-access-label"><MdLockOutline size={14} /> Acesso interno</div>
        <div className="login-logo">
          <img src={logo} alt="Fábrica de Salgados" />
        </div>

        <h1 className="login-title">Bem-vindo</h1>
        <p className="login-subtitle">Entre para acessar o painel de operação.</p>

        <form className="login-form" onSubmit={handleLogin}>
          <div className="login-field">
            <label htmlFor="login-email">E-mail</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              placeholder="seu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="login-field">
            <label htmlFor="login-password">Senha</label>
            {/* ✅ ENVOLVIDO EM UMA DIV PARA POSICIONAR O BOTÃO DO OLHO */}
            <div className="password-input-wrapper">
              <input
                id="login-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                required
              />
              <button
                type="button"
                className="toggle-password-btn"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
              >
                {showPassword ? <MdVisibilityOff /> : <MdVisibility />}
              </button>
            </div>
          </div>

          {/* ✅ aria-live="assertive" FAZ O NAVEGADOR AVISAR O ERRO IMEDIATAMENTE */}
          {error && <p className="login-error" aria-live="assertive">{error}</p>}

          <button
            type="submit"
            className="login-button"
            disabled={loading || !email || !password}
          >
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
