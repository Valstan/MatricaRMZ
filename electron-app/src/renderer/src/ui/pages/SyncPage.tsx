import React, { useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

export function SyncPage(props: { onAfterSync?: () => Promise<void> }) {
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [diag, setDiag] = useState<string>('');
  const [apiBaseUrl, setApiBaseUrl] = useState<string>('');
  const [apiSaveStatus, setApiSaveStatus] = useState<string>('');
  const [clientVersion, setClientVersion] = useState<string>('');
  const [serverInfo, setServerInfo] = useState<
    | { ok: true; url: string; serverOk: boolean; version: string | null; buildDate: string | null }
    | { ok: false; url: string; error: string }
    | null
  >(null);
  const [serverStatus, setServerStatus] = useState<string>('');

  useEffect(() => {
    void (async () => {
      const r = await window.matrica.sync.configGet().catch(() => null);
      if (r?.ok && r.apiBaseUrl) setApiBaseUrl(r.apiBaseUrl);

      const v = await window.matrica.app.version().catch(() => null);
      if (v?.ok && v.version) setClientVersion(v.version);

      await refreshServerHealth();
    })();
  }, []);

  async function refreshServerHealth() {
    setServerStatus('Проверяю сервер...');
    const r = await window.matrica.server.health().catch((e) => ({ ok: false as const, url: (apiBaseUrl || '').trim(), error: String(e) }));
    setServerInfo(r);
    setServerStatus(r.ok ? '' : `Ошибка: ${r.error}`);
  }

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
              if (r.ok) await refreshServerHealth();
            }}
          >
            Сохранить
          </Button>
          <Button variant="ghost" onClick={() => void refreshServerHealth()}>
            Проверить сервер
          </Button>
          <span style={{ color: '#6b7280', fontSize: 12 }}>{apiSaveStatus}</span>
        </div>

        <div style={{ marginTop: 10, color: '#6b7280', fontSize: 12 }}>
          Клиент: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{clientVersion || '—'}</span>
          {'  '}| Сервер:{' '}
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {serverInfo?.ok ? serverInfo.version ?? '—' : '—'}
          </span>
          {serverInfo?.ok && serverInfo.buildDate && (
            <>
              {' '}
              | build: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{serverInfo.buildDate}</span>
            </>
          )}
        </div>

        <div style={{ marginTop: 6, color: '#6b7280', fontSize: 12 }}>
          Версии клиента и сервера независимы (несовпадение не блокирует синхронизацию).
        </div>

        {serverStatus && <div style={{ marginTop: 8, color: serverStatus.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 12 }}>{serverStatus}</div>}
      </div>
      <div style={{ color: '#6b7280', marginBottom: 8 }}>
        {syncStatus || 'Состояние синхронизации отображается в шапке. Здесь — ручной запуск и обновления. Полная пересинхронизация доступна в настройках пользователя.'}
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
      {/* Обновления выполняются автоматически при запуске клиента. */}
    </div>
  );
}


