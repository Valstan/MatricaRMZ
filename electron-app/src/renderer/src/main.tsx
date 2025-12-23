import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './ui/App.js';

function safeLog(level: 'debug' | 'info' | 'warn' | 'error', message: string) {
  try {
    void window.matrica?.log?.send(level, message);
  } catch {
    // ignore
  }
}

window.addEventListener('error', (e) => {
  safeLog('error', `window.error: ${String(e.message)} @ ${String((e as any).filename)}:${String((e as any).lineno)}`);
});

window.addEventListener('unhandledrejection', (e) => {
  safeLog('error', `unhandledrejection: ${String((e as any).reason)}`);
});

safeLog('info', 'renderer boot start');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

safeLog('info', 'renderer boot mounted');


