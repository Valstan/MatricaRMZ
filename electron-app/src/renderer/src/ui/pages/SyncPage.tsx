import React, { useState } from 'react';

import { Button } from '../components/Button.js';

export function SyncPage(props: { onAfterSync?: () => Promise<void> }) {
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [diag, setDiag] = useState<string>('');

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Синхронизация</h2>
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


