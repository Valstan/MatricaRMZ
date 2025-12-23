import React, { useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

export function SyncPage(props: { onAfterSync?: () => Promise<void> }) {
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [diag, setDiag] = useState<string>('');
  const [apiBaseUrl, setApiBaseUrl] = useState<string>('');
  const [apiSaveStatus, setApiSaveStatus] = useState<string>('');

  useEffect(() => {
    void (async () => {
      const r = await window.matrica.sync.configGet().catch(() => null);
      if (r?.ok && r.apiBaseUrl) setApiBaseUrl(r.apiBaseUrl);
    })();
  }, []);

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Синхронизация</h2>
      <div style={{ margin: '10px 0 12px' }}>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Адрес сервера (API base URL)</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="http://server:3001" />
          <Button
            variant="ghost"
            onClick={async () => {
              setApiSaveStatus('Сохраняю...');
              const r = await window.matrica.sync.configSet({ apiBaseUrl });
              setApiSaveStatus(r.ok ? 'Сохранено' : `Ошибка: ${r.error ?? 'unknown'}`);
            }}
          >
            Сохранить
          </Button>
          <span style={{ color: '#6b7280', fontSize: 12 }}>{apiSaveStatus}</span>
        </div>
      </div>
      <div style={{ color: '#6b7280', marginBottom: 8 }}>
        {syncStatus || 'Состояние синхронизации отображается в шапке. Здесь — ручной запуск и обновления.'}
      </div>
      <Button
        onClick={async () => {
          setSyncStatus('Синхронизация...');
          const r = await window.matrica.sync.run();
          setSyncStatus(
            r.ok ? `OK: push=${r.pushed}, pull=${r.pulled}, cursor=${r.serverCursor}` : `Ошибка: ${r.error ?? 'unknown'}`,
          );
          const s = await window.matrica.sync.status().catch(() => null);
          if (s) setDiag(`state=${s.state}, lastError=${s.lastError ?? '-'}, next=${s.nextAutoSyncInMs ?? '-'}`);
          await props.onAfterSync?.();
        }}
      >
        Синхронизировать сейчас
      </Button>
      {diag && <div style={{ marginTop: 10, color: '#6b7280', fontSize: 12 }}>Диагностика: {diag}</div>}
      {/* Обновления теперь полностью автоматические при запуске (и через меню “Проверить и обновить”). */}
    </div>
  );
}


