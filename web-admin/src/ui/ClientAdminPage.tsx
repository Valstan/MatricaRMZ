import React, { useEffect, useState } from 'react';

import { listClients, updateClient } from '../api/clients.js';
import { Button } from './components/Button.js';

type ClientRow = {
  clientId: string;
  updatesEnabled: boolean;
  torrentEnabled: boolean;
  loggingEnabled: boolean;
  loggingMode: 'dev' | 'prod';
  lastSeenAt: number | null;
  lastVersion: string | null;
  lastIp: string | null;
  lastHostname: string | null;
  lastPlatform: string | null;
  lastArch: string | null;
  updatedAt: number;
};

function formatDate(ms: number | null) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('ru-RU');
}

function toLoggingUi(row: ClientRow): 'full' | 'partial' | 'off' {
  if (!row.loggingEnabled) return 'off';
  return row.loggingMode === 'dev' ? 'full' : 'partial';
}

export function ClientAdminPage() {
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);

  async function refresh() {
    setLoading(true);
    const r = await listClients().catch(() => null);
    if (r && (r as any).ok) {
      setRows((r as any).rows ?? []);
      setStatus('');
    } else {
      setStatus(`Ошибка загрузки клиентов: ${(r as any)?.error ?? 'unknown'}`);
    }
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function patchClient(clientId: string, patch: Partial<ClientRow>) {
    const r = await updateClient(clientId, {
      updatesEnabled: patch.updatesEnabled,
      torrentEnabled: patch.torrentEnabled,
      loggingEnabled: patch.loggingEnabled,
      loggingMode: patch.loggingMode,
    }).catch(() => null);
    if (r && (r as any).ok && (r as any).row) {
      setRows((prev) => prev.map((row) => (row.clientId === clientId ? { ...row, ...(r as any).row } : row)));
      setStatus('');
    } else {
      setStatus(`Ошибка сохранения: ${(r as any)?.error ?? 'unknown'}`);
    }
  }

  if (loading) {
    return <div className="card">Загрузка…</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Клиенты</h2>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 120%)', color: '#fff' }}>
                <th style={{ textAlign: 'left', padding: 10 }}>Client ID</th>
                <th style={{ textAlign: 'left', padding: 10 }}>Версия</th>
                <th style={{ textAlign: 'left', padding: 10 }}>Последний раз</th>
                <th style={{ textAlign: 'left', padding: 10 }}>IP</th>
                <th style={{ textAlign: 'left', padding: 10 }}>Hostname</th>
                <th style={{ textAlign: 'left', padding: 10 }}>Платформа</th>
                <th style={{ textAlign: 'left', padding: 10 }}>Обновления</th>
                <th style={{ textAlign: 'left', padding: 10 }}>Торрент</th>
                <th style={{ textAlign: 'left', padding: 10 }}>Логи</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const loggingUi = toLoggingUi(row);
                return (
                  <tr key={row.clientId}>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      {row.clientId}
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{row.lastVersion ?? '—'}</td>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{formatDate(row.lastSeenAt)}</td>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{row.lastIp ?? '—'}</td>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{row.lastHostname ?? '—'}</td>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>
                      {row.lastPlatform ? `${row.lastPlatform}${row.lastArch ? `/${row.lastArch}` : ''}` : '—'}
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>
                      <Button
                        variant={row.updatesEnabled ? 'primary' : 'ghost'}
                        onClick={() => {
                          const next = !row.updatesEnabled;
                          void patchClient(row.clientId, {
                            updatesEnabled: next,
                            torrentEnabled: next ? row.torrentEnabled : false,
                          });
                        }}
                      >
                        {row.updatesEnabled ? 'Включены' : 'Отключены'}
                      </Button>
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>
                      <Button
                        variant={row.torrentEnabled ? 'primary' : 'ghost'}
                        disabled={!row.updatesEnabled}
                        onClick={() => {
                          if (!row.updatesEnabled) return;
                          void patchClient(row.clientId, { torrentEnabled: !row.torrentEnabled });
                        }}
                      >
                        {row.torrentEnabled ? 'Включен' : 'Отключен'}
                      </Button>
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>
                      <select
                        value={loggingUi}
                        onChange={(e) => {
                          const v = e.target.value as 'full' | 'partial' | 'off';
                          if (v === 'off') {
                            void patchClient(row.clientId, { loggingEnabled: false });
                          } else if (v === 'full') {
                            void patchClient(row.clientId, { loggingEnabled: true, loggingMode: 'dev' });
                          } else {
                            void patchClient(row.clientId, { loggingEnabled: true, loggingMode: 'prod' });
                          }
                        }}
                        style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #d1d5db' }}
                      >
                        <option value="full">Полное</option>
                        <option value="partial">Частичное</option>
                        <option value="off">Отключить</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ padding: 12, color: '#6b7280' }}>
                    Клиенты ещё не зарегистрированы.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {status && <div style={{ marginTop: 10, color: '#6b7280' }}>{status}</div>}
      </div>
    </div>
  );
}
