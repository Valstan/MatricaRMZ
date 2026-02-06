import React from 'react';

type Props = {
  title?: string;
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  errorMessage: string;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, errorMessage: '' };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    return { hasError: true, errorMessage: message };
  }

  componentDidCatch(error: unknown) {
    console.error('[web-admin] UI crashed', error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="card" style={{ border: '1px solid #fecaca', background: '#fff1f2', padding: 16 }}>
        <div style={{ fontWeight: 800, color: '#7f1d1d' }}>{this.props.title ?? 'Ошибка интерфейса'}</div>
        <div style={{ marginTop: 8, color: '#991b1b', fontSize: 13 }}>
          {this.state.errorMessage || 'Не удалось отрисовать раздел.'}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            onClick={() => this.setState({ hasError: false, errorMessage: '' })}
            style={{
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid #fecaca',
              background: '#fff',
              color: '#7f1d1d',
              cursor: 'pointer',
            }}
          >
            Повторить
          </button>
        </div>
      </div>
    );
  }
}
