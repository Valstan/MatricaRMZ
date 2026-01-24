import React from 'react';

type ErrorBoundaryState = { error: Error | null; info: React.ErrorInfo | null };

export class ErrorBoundary extends React.Component<{ onError?: (error: Error, info: React.ErrorInfo) => void }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error) {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ error, info });
    this.props.onError?.(error, info);
  }

  render() {
    return this.props.children;
  }
}
