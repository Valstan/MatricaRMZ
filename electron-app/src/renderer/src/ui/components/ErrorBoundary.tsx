import React from 'react';

type ErrorBoundaryState = { error: Error | null; info: React.ErrorInfo | null };

export class ErrorBoundary extends React.Component<
  { onError?: (error: Error, info: React.ErrorInfo) => void; children?: React.ReactNode },
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error) {
    return { error, info: null };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ error, info });
    this.props.onError?.(error, info);
  }

  override render() {
    return this.props.children;
  }
}
