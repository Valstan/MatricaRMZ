import React, { useEffect, useState } from 'react';

import { listClients, updateClient } from '../api/clients.js';
import { requestClientSync } from '../api/diagnostics.js';
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
  const [query, setQuery] = useState<string>('');
  const [fullSyncSelection, setFullSyncSelection] = useState<Record<string, boolean>>({});
  const [fullSyncStatus, setFullSyncStatus] = useState<string>('');
  const [fullSyncLoading, setFullSyncLoading] = useState<boolean>(false);

  function normalize(s: string | null | undefined) {
    return String(s ?? '')
      .toLowerCase()
      .replaceAll('ё', 'е')
      .replaceAll(/\s+/g, ' ')
      .trim();
  }

  function isOnline(lastSeenAt: number | null) {
    if (!lastSeenAt) return false;
    return Date.now() - lastSeenAt < 5 * 60_000;
  }

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

  useEffect(() => {
    const id = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(id);
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

  async function requestFullSync(targetIds: string[]) {
    if (!targetIds.length) {
      setFullSyncStatus('Выберите клиентов или включите режим "Всех клиентов".');
      return;
    }
    if (
      !confirm(
        `Запросить полную синхронизацию для ${targetIds.length} клиент(ов)? Это может занять длительное время на клиенте.`,
      )
    )
      return;
    setFullSyncLoading(true);
    setFullSyncStatus('Отправка запросов...');
    const results = await Promise.all(
      targetIds.map(async (clientId) => {
        const r = await requestClientSync(clientId, 'force_full_pull').catch((e) => ({ ok: false, error: String(e) }));
        return { clientId, ok: !!(r as any)?.ok, error: (r as any)?.error };
      }),
    );
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      setFullSyncStatus(`Запрос отправлен: ${results.length} клиент(ов).`);
    } else {
      setFullSyncStatus(`Ошибки: ${failed.length}/${results.length}. Первые: ${failed.slice(0, 3).map((f) => f.clientId).join(', ')}`);
    }
    setFullSyncLoading(false);
  }

  if (loading) {
    return <div className="card">Загрузка…</div>;
  }

  const filtered = rows.filter((row) => {
    const q = normalize(query);
    if (!q) return true;
    return (
      normalize(row.clientId).includes(q) ||
      normalize(row.lastHostname).includes(q) ||
      normalize(row.lastIp).includes(q)
    );
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Клиенты</h2>
        <div style={{ width: 280 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по Client ID / Hostname / IP…"
            style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
          />
        </div>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>Принудительная полная синхронизация на клиенте</h3>
        <div className="muted" style={{ marginBottom: 10 }}>
          Используйте только для лечения базы. Клиенты выполнят полную синхронизацию при следующем опросе настроек.
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="ghost"
            disabled={fullSyncLoading || filtered.length === 0}
            onClick={() =>
              setFullSyncSelection((prev) => {
                const next = { ...prev };
                for (const row of filtered) next[row.clientId] = true;
                return next;
              })
            }
          >
            Выбрать всех
          </Button>
          <Button
            variant="ghost"
            disabled={fullSyncLoading || Object.keys(fullSyncSelection).length === 0}
            onClick={() => setFullSyncSelection({})}
          >
            Снять всех
          </Button>
          <Button
            variant="ghost"
            disabled={fullSyncLoading}
            onClick={() => {
              const targetIds = Object.entries(fullSyncSelection)
                .filter(([, v]) => v)
                .map(([id]) => id);
              void requestFullSync(targetIds);
            }}
          >
            Запросить полную синхронизацию
          </Button>
          {fullSyncStatus && <span className="muted">{fullSyncStatus}</span>}
        </div>
        <div style={{ marginTop: 10, maxHeight: 180, overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 10, padding: 10 }}>
          {!filtered.length && <div className="muted">Нет клиентов для выбора.</div>}
          {filtered.map((row) => (
            <label key={row.clientId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <input
                type="checkbox"
                checked={!!fullSyncSelection[row.clientId]}
                onChange={(e) =>
                  setFullSyncSelection((prev) => ({ ...prev, [row.clientId]: e.target.checked }))
                }
              />
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{row.clientId}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {row.lastHostname ?? '—'} · {row.lastIp ?? '—'}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 120%)', color: '#fff' }}>
                <th style={{ textAlign: 'left', padding: 10 }}>Client ID</th>
                <th style={{ textAlign: 'left', padding: 10 }}>Статус</th>
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
              {filtered.map((row) => {
                const loggingUi = toLoggingUi(row);
                const online = isOnline(row.lastSeenAt);
                return (
                  <tr key={row.clientId}>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      {row.clientId}
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 999,
                            display: 'inline-block',
                            background: online ? '#16a34a' : '#dc2626',
                            boxShadow: '0 0 0 2px rgba(0,0,0,0.08)',
                          }}
                        />
                        <span>{online ? 'Онлайн' : 'Оффлайн'}</span>
                      </span>
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
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ padding: 12, color: '#6b7280' }}>
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
