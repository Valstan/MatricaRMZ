import { clientHasWatchdog } from '@matricarmz/shared';
import React, { useEffect, useMemo, useState } from 'react';

import { listClients, updateClient } from '../api/clients.js';
import { requestClientSync } from '../api/diagnostics.js';
import { Button } from './components/Button.js';
import { formatMoscowDateTime } from './utils/dateUtils.js';
import { matchesQueryInRecord } from './utils/search.js';

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
  lastUsername: string | null;
  lastFullName: string | null;
  updatedAt: number;
};

function formatDate(ms: number | null) {
  if (!ms) return '—';
  return formatMoscowDateTime(ms);
}

function toLoggingUi(row: ClientRow): 'full' | 'partial' | 'off' {
  if (!row.loggingEnabled) return 'off';
  return row.loggingMode === 'dev' ? 'full' : 'partial';
}

const MUTED = '#6b7280';
const BORDER = '#e5e7eb';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function ClientAdminPage() {
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [query, setQuery] = useState<string>('');
  const [fullSyncSelection, setFullSyncSelection] = useState<Record<string, boolean>>({});
  const [fullSyncStatus, setFullSyncStatus] = useState<string>('');
  const [fullSyncLoading, setFullSyncLoading] = useState<boolean>(false);
  const [reinstallStatus, setReinstallStatus] = useState<Record<string, string>>({});

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
      setFullSyncStatus('Отметьте клиентов галочкой на карточке.');
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

  async function requestReinstall(clientId: string) {
    if (
      !confirm(
        `Отправить команду переустановки клиенту ${clientId}? Watchdog при следующем проходе (до ~15 мин) переустановит приложение из локального инсталлятора. Используйте, если у клиента пропали ярлыки/exe после сорванного обновления.`,
      )
    )
      return;
    setReinstallStatus((prev) => ({ ...prev, [clientId]: 'Отправка…' }));
    const r = await requestClientSync(clientId, 'reinstall').catch((e) => ({ ok: false, error: String(e) }));
    setReinstallStatus((prev) => ({
      ...prev,
      [clientId]: (r as any)?.ok ? 'Команда поставлена в очередь' : `Ошибка: ${(r as any)?.error ?? 'unknown'}`,
    }));
  }

  const filtered = useMemo(() => rows.filter((row) => matchesQueryInRecord(query, row)), [rows, query]);
  const selectedCount = useMemo(() => Object.values(fullSyncSelection).filter(Boolean).length, [fullSyncSelection]);

  if (loading) {
    return <div className="card">Загрузка…</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Клиенты</h2>
        <span className="muted" style={{ fontSize: 13 }}>{filtered.length} из {rows.length}</span>
        <span style={{ flex: 1 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по всем данным клиента…"
          style={{ width: 'min(320px, 60vw)', padding: '8px 10px', borderRadius: 10, border: `1px solid ${BORDER}` }}
        />
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      <div
        className="card"
        style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <strong>Полная синхронизация</strong>
        <span className="muted" style={{ fontSize: 13 }}>
          только для лечения базы — отметьте клиентов галочкой на карточке
        </span>
        <span style={{ flex: 1 }} />
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
        <Button variant="ghost" disabled={fullSyncLoading || selectedCount === 0} onClick={() => setFullSyncSelection({})}>
          Снять выбор
        </Button>
        <Button
          variant="primary"
          disabled={fullSyncLoading || selectedCount === 0}
          onClick={() => {
            const targetIds = Object.entries(fullSyncSelection)
              .filter(([, v]) => v)
              .map(([id]) => id);
            void requestFullSync(targetIds);
          }}
        >
          Синхронизировать ({selectedCount})
        </Button>
        {fullSyncStatus && <span className="muted" style={{ flexBasis: '100%', fontSize: 13 }}>{fullSyncStatus}</span>}
      </div>

      {filtered.length === 0 ? (
        <div className="card" style={{ color: MUTED }}>
          {rows.length === 0 ? 'Клиенты ещё не зарегистрированы.' : 'Ничего не найдено по запросу.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: 12 }}>
          {filtered.map((row) => {
            const loggingUi = toLoggingUi(row);
            const online = isOnline(row.lastSeenAt);
            const hasWatchdog = clientHasWatchdog(row.lastVersion);
            const selected = !!fullSyncSelection[row.clientId];
            return (
              <div
                key={row.clientId}
                className="card"
                style={{
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  boxShadow: 'none',
                  border: `1px solid ${selected ? '#0ea5e9' : BORDER}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                  <span style={{ fontSize: 13 }}>{online ? 'Онлайн' : 'Оффлайн'}</span>
                  <span
                    style={{
                      fontSize: 12,
                      color: '#0369a1',
                      background: '#e0f2fe',
                      borderRadius: 999,
                      padding: '2px 8px',
                    }}
                  >
                    {row.lastVersion ?? 'версия —'}
                  </span>
                  <span style={{ flex: 1 }} />
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: MUTED, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => setFullSyncSelection((prev) => ({ ...prev, [row.clientId]: e.target.checked }))}
                    />
                    выбрать
                  </label>
                </div>

                <div>
                  <div style={{ fontWeight: 600, fontSize: 15, wordBreak: 'break-word' }}>
                    {row.lastFullName ?? row.lastUsername ?? '—'}
                  </div>
                  {row.lastFullName && row.lastUsername && (
                    <div className="muted" style={{ fontSize: 12 }}>{row.lastUsername}</div>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: 13, alignItems: 'baseline' }}>
                  <span className="muted">Хост</span>
                  <span style={{ wordBreak: 'break-word' }}>{row.lastHostname ?? '—'}</span>
                  <span className="muted">IP</span>
                  <span>{row.lastIp ?? '—'}</span>
                  <span className="muted">Платформа</span>
                  <span>{row.lastPlatform ? `${row.lastPlatform}${row.lastArch ? `/${row.lastArch}` : ''}` : '—'}</span>
                  <span className="muted">Был</span>
                  <span>{formatDate(row.lastSeenAt)}</span>
                  <span className="muted">ID</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: MUTED, wordBreak: 'break-all' }}>{row.clientId}</span>
                </div>

                <div style={{ borderTop: `1px solid #f3f4f6`, paddingTop: 10, display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 13, minWidth: 86 }}>Обновления</span>
                    <Button
                      variant={row.updatesEnabled ? 'primary' : 'ghost'}
                      onClick={() => {
                        const next = !row.updatesEnabled;
                        void patchClient(row.clientId, { updatesEnabled: next, torrentEnabled: next ? row.torrentEnabled : false });
                      }}
                    >
                      {row.updatesEnabled ? 'Включены' : 'Отключены'}
                    </Button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 13, minWidth: 86 }}>Торрент</span>
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
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 13, minWidth: 86 }}>Логи</span>
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
                      style={{ padding: '6px 8px', borderRadius: 8, border: `1px solid ${BORDER}` }}
                    >
                      <option value="full">Полное</option>
                      <option value="partial">Частичное</option>
                      <option value="off">Отключить</option>
                    </select>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <Button variant="ghost" disabled={!hasWatchdog} onClick={() => void requestReinstall(row.clientId)}>
                      Переустановить
                    </Button>
                    {!hasWatchdog && (
                      <span className="muted" style={{ fontSize: 12 }}>нет watchdog — после обновления</span>
                    )}
                    {reinstallStatus[row.clientId] && (
                      <span className="muted" style={{ fontSize: 12, flexBasis: '100%' }}>{reinstallStatus[row.clientId]}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {status && <div style={{ marginTop: 10, color: MUTED }}>{status}</div>}
    </div>
  );
}
