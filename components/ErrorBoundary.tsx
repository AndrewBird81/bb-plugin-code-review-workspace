import { Component, type ReactNode } from "react";

/**
 * What it wraps, until that throws while drawing: then `fallback`, which can try again, until a new `resetKey` does.
 * React logs the error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback: (retry: () => void) => ReactNode; resetKey?: unknown }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: { resetKey?: unknown }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  retry = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}
