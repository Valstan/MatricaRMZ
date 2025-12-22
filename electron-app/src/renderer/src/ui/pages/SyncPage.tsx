import React, { useState } from 'react';

import { Button } from '../components/Button.js';

export function SyncPage(props: { onAfterSync?: () => Promise<void> }) {
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<string>('');

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
          await props.onAfterSync?.();
        }}
      >
        Синхронизировать сейчас
      </Button>

      <h2 style={{ margin: '18px 0 8px' }}>Обновления</h2>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Button
          variant="ghost"
          onClick={async () => {
            setUpdateStatus('Проверка обновлений...');
            const r = await window.matrica.update.check();
            setUpdateStatus(
              r.ok
                ? r.updateAvailable
                  ? `Доступно обновление: ${r.version ?? ''}`
                  : 'Обновлений нет'
                : `Ошибка: ${r.error ?? 'unknown'}`,
            );
          }}
        >
          Проверить обновления
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            setUpdateStatus('Скачивание обновления...');
            const r = await window.matrica.update.download();
            setUpdateStatus(r.ok ? 'Обновление скачано. Нажмите “Установить”.' : `Ошибка: ${r.error ?? 'unknown'}`);
          }}
        >
          Скачать
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            await window.matrica.update.install();
          }}
        >
          Установить
        </Button>
        <span style={{ color: '#6b7280' }}>{updateStatus}</span>
      </div>
    </div>
  );
}


