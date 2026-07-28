import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div
          style={{ padding: "20px", color: "red", textAlign: "center" }}
          className="status-screen"
        >
          <h2>Something went wrong</h2>
          <pre>{this.state.error?.message}</pre>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }

    return this.props.children;
  }
}
