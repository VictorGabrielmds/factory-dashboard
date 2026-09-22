// src/components/ErrorBoundary/ErrorBoundary.tsx
import { Component, type ReactNode, type ErrorInfo } from "react";
import "./ErrorBoundary.css";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary capturou:", error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, message: "" });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-box">
            <span className="error-boundary-icon">⚠️</span>
            <h2>Algo deu errado</h2>
            <p>Ocorreu um erro inesperado na aplicação.</p>
            {this.state.message && (
              <code className="error-boundary-detail">{this.state.message}</code>
            )}
            <button onClick={this.handleReload}>Recarregar página</button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;