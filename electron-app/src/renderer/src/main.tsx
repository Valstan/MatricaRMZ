/// <reference path="./types/matrica.d.ts" />
import React from 'react';
import ReactDOM from 'react-dom/client';

import 'react-datepicker/dist/react-datepicker.css';
import './ui/global.css';
import { App } from './ui/App.js';

if (!('workOrderId' in globalThis)) {
  (globalThis as any).workOrderId = null;
}

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

const root = document.getElementById('root');
if (!root) {
  safeLog('error', 'renderer boot failed: #root not found');
} else if (!(window as any).matrica) {
  // Если preload не поднялся, UI не сможет работать — показываем понятную ошибку вместо белого экрана.
  root.innerHTML =
    '<div style="font-family:system-ui;padding:16px;color:#b91c1c">' +
    '<h2 style="margin:0 0 8px 0">Ошибка запуска интерфейса</h2>' +
    '<div>Не загружен preload (IPC мост). Проверьте файл лога matricarmz.log и обновитесь до последней версии.</div>' +
    '</div>';
  safeLog('error', 'window.matrica is undefined (preload not loaded)');
} else {
  ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
  safeLog('info', 'renderer boot mounted');
}


