import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  getConsistencyReport,
  getClientLastError,
  getEntityDiff,
  requestMasterdataSnapshotAll,
  requestClientSync,
  runConsistencyCheck,
  type ConsistencyClientReport,
  type ConsistencySnapshot,
} from '../api/diagnostics.js';
import { Button } from './components/Button.js';
import { Input } from './components/Input.js';

type Report = { server: ConsistencySnapshot; clients: ConsistencyClientReport[] };
type ClientView = ConsistencyClientReport & { deviceKey: string; deviceName: string; aliases?: ConsistencyClientReport[] };

function formatTs(ts: number | null | undefined) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function statusColor(status: ConsistencyClientReport['status']) {
  if (status === 'ok') return 'var(--success)';
  if (status === 'warning') return 'var(--warning)';
  if (status === 'drift') return 'var(--danger)';
  return 'var(--muted)';
}

function statusLabel(status: ConsistencyClientReport['status']) {
  if (status === 'ok') return 'Синхронизировано';
  if (status === 'warning') return 'Требует проверки';
  if (status === 'drift') return 'Есть различия';
  return 'Нет данных';
}

function renderSectionRow(
  label: string,
  section: { count: number; maxUpdatedAt: number | null; checksum: string | null; pendingCount?: number; errorCount?: number } | null,
) {
  if (!section) return `${label}: —`;
  const updated = section.maxUpdatedAt ? new Date(section.maxUpdatedAt).toLocaleString() : '—';
  const extras = [];
  if (section.pendingCount != null) extras.push(`ожидает=${section.pendingCount}`);
  if (section.errorCount != null) extras.push(`ошибок=${section.errorCount}`);
  const suffix = extras.length > 0 ? `, ${extras.join(', ')}` : '';
  return `${label}: записей=${section.count}, обновлено=${updated}${suffix}`;
}

const TABLE_META: Record<string, { title: string; note: string }> = {
  entity_types: { title: 'Справочники: типы карточек', note: 'Категории карточек и справочников' },
  attribute_defs: { title: 'Справочники: поля карточек', note: 'Схема полей и атрибутов' },
  entities: { title: 'Карточки: базовые записи', note: 'Основные записи карточек' },
  attribute_values: { title: 'Карточки: значения полей', note: 'Данные в полях карточек' },
  operations: { title: 'Операции', note: 'Журнал операций по двигателям/заявкам' },
};

const ENTITY_TYPE_META: Record<string, { title: string }> = {
  engine: { title: 'Двигатели' },
  engine_brand: { title: 'Марки двигателей' },
  part: { title: 'Детали' },
  contract: { title: 'Контракты' },
  customer: { title: 'Контрагенты' },
  employee: { title: 'Сотрудники' },
};

function sumPendingErrors(snapshot: ConsistencySnapshot | null) {
  if (!snapshot) return { pending: 0, error: 0 };
  const sections = Object.values(snapshot.tables ?? {});
  return sections.reduce(
    (acc, s) => {
      acc.pending += Number(s?.pendingCount ?? 0);
      acc.error += Number(s?.errorCount ?? 0);
      return acc;
    },
    { pending: 0, error: 0 },
  );
}

function clientCounts(c: ConsistencyClientReport) {
  const tableDiffs = (c.diffs ?? []).filter((d) => d.kind === 'table');
  const pending = tableDiffs.reduce((sum, d) => sum + Number(d.client?.pendingCount ?? 0), 0);
  const error = tableDiffs.reduce((sum, d) => sum + Number(d.client?.errorCount ?? 0), 0);
  const drift = (c.diffs ?? []).filter((d) => d.status === 'drift').length;
  const warnings = (c.diffs ?? []).filter((d) => d.status === 'warning').length;
  const totalDiffs = (c.diffs ?? []).filter((d) => d.status !== 'ok').length;
  return { pending, error, drift, warnings, totalDiffs };
}

function isStale(ts: number | null | undefined, minutes = 30) {
  if (!ts) return false;
  return Date.now() - Number(ts) > minutes * 60_000;
}

function lastActiveAt(c: ConsistencyClientReport) {
  const candidates = [c.lastSeenAt, c.lastPulledAt, c.lastPushedAt, c.snapshotAt].filter((v) => v != null);
  if (!candidates.length) return null;
  return Math.max(...(candidates as number[]));
}

function inferDeviceName(c: ConsistencyClientReport) {
  const host = (c.lastHostname ?? '').trim();
  if (host) return host;
  const raw = String(c.clientId ?? '').trim();
  const idx = raw.indexOf('-');
  return idx > 0 ? raw.slice(0, idx) : raw;
}

function deviceKeyFor(c: ConsistencyClientReport) {
  const name = inferDeviceName(c);
  const platform = (c.lastPlatform ?? '').trim();
  const arch = (c.lastArch ?? '').trim();
  return `${name}|${platform}|${arch}`.toLowerCase();
}

function formatSyncRequest(c: ConsistencyClientReport) {
  if (!c.syncRequestType || !c.syncRequestAt) return '—';
  const title = c.syncRequestType === 'sync_now' ? 'повторить синхронизацию' : c.syncRequestType === 'force_full_pull' ? 'перекачать с сервера' : c.syncRequestType;
  return `${title} · ${formatTs(c.syncRequestAt)}`;
}

function downloadJsonReport(report: Report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function DiagnosticsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [report, setReport] = useState<Report | null>(null);
  const [showOnlyIssues, setShowOnlyIssues] = useState(false);
  const [showOnlyDiffs, setShowOnlyDiffs] = useState(true);
  const [hideDuplicates, setHideDuplicates] = useState(true);
  const [expandedClients, setExpandedClients] = useState<Record<string, boolean>>({});
  const [clientQuery, setClientQuery] = useState('');
  const [entityDiffs, setEntityDiffs] = useState<Record<string, { loading: boolean; error?: string; data?: any }>>({});
  const [lastErrors, setLastErrors] = useState<Record<string, { loading: boolean; error?: string; data?: any }>>({});
  const [actionNotices, setActionNotices] = useState<Record<string, string>>({});
  const diffTimersRef = useRef<Record<string, number>>({});

  async function refresh() {
    setLoading(true);
    setError('');
    const r = await getConsistencyReport();
    if (!r?.ok) {
      setError(r?.error ?? 'Ошибка загрузки');
      setLoading(false);
      return;
    }
    setReport(r.report ?? null);
    setLoading(false);
  }

  async function runNow() {
    setLoading(true);
    setError('');
    const r = await runConsistencyCheck();
    if (!r?.ok) {
      setError(r?.error ?? 'Ошибка запуска');
      setLoading(false);
      return;
    }
    setReport(r.report ?? null);
    setLoading(false);
  }

  async function requestSync(clientId: string, type: 'sync_now' | 'force_full_pull') {
    setLoading(true);
    setError('');
    if (type === 'force_full_pull') {
      const snap = await requestMasterdataSnapshotAll();
      if (!snap?.ok) {
        setError(snap?.error ?? 'Ошибка переснимка справочников');
        setLoading(false);
        return;
      }
    }
    const r = await requestClientSync(clientId, type);
    if (!r?.ok) {
      setError(r?.error ?? 'Ошибка запуска синхронизации');
      setLoading(false);
      return;
    }
    setActionNotices((prev) => ({
      ...prev,
      [clientId]: type === 'sync_now' ? 'Запрос отправлен. Клиент выполнит при следующем опросе настроек.' : 'Запрос перекачки отправлен. Клиент выполнит при следующем опросе.',
    }));
    await refresh();
  }

  async function requestEntityDiff(clientId: string, entityId: string) {
    setLoading(true);
    setError('');
    const r = await requestClientSync(clientId, 'entity_diff', { entityId });
    if (!r?.ok) {
      setError(r?.error ?? 'Ошибка запроса сравнения');
      setLoading(false);
      return;
    }
    const key = `${clientId}:${entityId}`;
    setEntityDiffs((prev) => ({ ...prev, [key]: { loading: true } }));
    setLoading(false);
    scheduleEntityDiffPoll(clientId, entityId);
  }

  async function requestDeleteLocal(clientId: string, entityId: string) {
    setLoading(true);
    setError('');
    const r = await requestClientSync(clientId, 'delete_local_entity', { entityId });
    if (!r?.ok) {
      setError(r?.error ?? 'Ошибка запроса удаления');
      setLoading(false);
      return;
    }
    setLoading(false);
  }

  async function loadEntityDiff(clientId: string, entityId: string, opts?: { silent?: boolean }) {
    const key = `${clientId}:${entityId}`;
    setEntityDiffs((prev) => ({ ...prev, [key]: { loading: true } }));
    const r = await getEntityDiff(clientId, entityId);
    if (!r?.ok || !r?.diff) {
      if (!opts?.silent) {
        setEntityDiffs((prev) => ({ ...prev, [key]: { loading: false, error: r?.error ?? 'Нет данных' } }));
      } else {
        setEntityDiffs((prev) => ({ ...prev, [key]: { loading: false } }));
      }
      return false;
    }
    setEntityDiffs((prev) => ({ ...prev, [key]: { loading: false, data: r.diff } }));
    return true;
  }

  async function loadLastError(clientId: string) {
    setLastErrors((prev) => ({ ...prev, [clientId]: { loading: true } }));
    const r = await getClientLastError(clientId);
    if (!r?.ok) {
      setLastErrors((prev) => ({ ...prev, [clientId]: { loading: false, error: r?.error ?? 'Ошибка загрузки' } }));
      return;
    }
    setLastErrors((prev) => ({ ...prev, [clientId]: { loading: false, data: r.result ?? null } }));
  }

  function buildEntityLink(typeCode: string, entityId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('openType', typeCode);
    url.searchParams.set('openId', entityId);
    return url.toString();
  }

  function openEntityCard(typeCode: string, entityId: string) {
    try {
      const payload = { typeCode, entityId, at: Date.now() };
      const url = buildEntityLink(typeCode, entityId);
      window.history.replaceState(null, '', url);
      localStorage.setItem('diagnostics.openEntity', JSON.stringify(payload));
      window.dispatchEvent(new CustomEvent('diagnostics:open-entity', { detail: payload }));
    } catch {
      // ignore
    }
  }

  function scheduleEntityDiffPoll(clientId: string, entityId: string, attempt = 0) {
    const key = `${clientId}:${entityId}`;
    const maxAttempts = 6;
    const delayMs = 4000;
    const existing = diffTimersRef.current[key];
    if (existing) clearTimeout(existing);
    diffTimersRef.current[key] = window.setTimeout(async () => {
      const ready = await loadEntityDiff(clientId, entityId, { silent: true });
      if (ready) return;
      if (attempt + 1 >= maxAttempts) {
        setEntityDiffs((prev) => ({ ...prev, [key]: { loading: false, error: 'Diff не получен (клиент не ответил)' } }));
        return;
      }
      scheduleEntityDiffPoll(clientId, entityId, attempt + 1);
    }, delayMs);
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    return () => {
      for (const t of Object.values(diffTimersRef.current)) clearTimeout(t);
      diffTimersRef.current = {};
    };
  }, []);

  const clientView = useMemo<{ list: ClientView[]; hidden: number }>(() => {
    const list = report?.clients ?? [];
    const baseFiltered = showOnlyIssues
      ? list.filter((c) => {
          const counts = clientCounts(c);
          return c.status !== 'ok' || counts.pending > 0 || counts.error > 0;
        })
      : list;
    const q = clientQuery.trim().toLowerCase();
    const filtered = q
      ? baseFiltered.filter((c) => {
          const name = inferDeviceName(c).toLowerCase();
          return String(c.clientId).toLowerCase().includes(q) || name.includes(q);
        })
      : baseFiltered;
    const baseSorted = filtered.slice().sort((a, b) => {
      const ac = clientCounts(a);
      const bc = clientCounts(b);
      const aScore = (a.status === 'drift' ? 3 : a.status === 'warning' ? 2 : 0) + (ac.error > 0 ? 2 : 0) + (ac.pending > 0 ? 1 : 0);
      const bScore = (b.status === 'drift' ? 3 : b.status === 'warning' ? 2 : 0) + (bc.error > 0 ? 2 : 0) + (bc.pending > 0 ? 1 : 0);
      if (aScore !== bScore) return bScore - aScore;
      const aName = inferDeviceName(a);
      const bName = inferDeviceName(b);
      if (aName !== bName) return aName.localeCompare(bName);
      return String(a.clientId).localeCompare(String(b.clientId));
    });
    if (!hideDuplicates) {
      return {
        list: baseSorted.map((c) => ({
          ...c,
          deviceKey: deviceKeyFor(c),
          deviceName: inferDeviceName(c),
          aliases: undefined,
        })),
        hidden: 0,
      };
    }
    const groups = new Map<string, ConsistencyClientReport[]>();
    for (const c of baseSorted) {
      const key = deviceKeyFor(c);
      const arr = groups.get(key) ?? [];
      arr.push(c);
      groups.set(key, arr);
    }
    const merged: ClientView[] = [];
    let hidden = 0;
    for (const [key, group] of groups.entries()) {
      const sorted = group.slice().sort((a, b) => (lastActiveAt(b) ?? 0) - (lastActiveAt(a) ?? 0));
      const primary = sorted[0];
      if (!primary) continue;
      const aliases = sorted.slice(1);
      hidden += aliases.length;
      merged.push({
        ...primary,
        deviceKey: key,
        deviceName: inferDeviceName(primary),
        aliases: aliases.length ? aliases : undefined,
      });
    }
    return { list: merged, hidden };
  }, [report?.clients, showOnlyIssues, clientQuery, hideDuplicates]);

  const clientSummary = useMemo(() => {
    const list = clientView.list ?? [];
    const totals = list.reduce(
      (acc, c) => {
        const counts = clientCounts(c);
        if (c.status !== 'ok' || counts.pending > 0 || counts.error > 0) acc.problem += 1;
        if (isStale(lastActiveAt(c), 30)) acc.stale += 1;
        acc.pending += counts.pending;
        acc.error += counts.error;
        return acc;
      },
      { total: list.length, problem: 0, stale: 0, pending: 0, error: 0 },
    );
    return totals;
  }, [clientView.list]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: '8px 0' }}>Диагностика</h2>
        <span style={{ flex: 1 }} />
        <div style={{ width: 260 }}>
          <Input value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} placeholder="Фильтр по клиенту…" />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b' }}>
          <input type="checkbox" checked={showOnlyIssues} onChange={(e) => setShowOnlyIssues(e.target.checked)} />
          только проблемные
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b' }}>
          <input type="checkbox" checked={showOnlyDiffs} onChange={(e) => setShowOnlyDiffs(e.target.checked)} />
          только различия
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b' }}>
          <input type="checkbox" checked={hideDuplicates} onChange={(e) => setHideDuplicates(e.target.checked)} />
          скрывать дубликаты
        </label>
        <Button variant="ghost" onClick={() => report && downloadJsonReport(report)} disabled={!report}>
          Экспорт JSON
        </Button>
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
          Обновить
        </Button>
        <Button onClick={() => void runNow()} disabled={loading}>
          Отправить диагностику сейчас
        </Button>
      </div>

      {error && <div className="muted">Ошибка: {error}</div>}

      <div style={{ marginTop: 10 }} className="card">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <div>
            <div className="muted">Снимок сервера</div>
            <div>{report ? formatTs(report.server.generatedAt) : '—'}</div>
          </div>
          <div>
            <div className="muted">Последний server_seq</div>
            <div>{report?.server.serverSeq ?? '—'}</div>
          </div>
          <div>
            <div className="muted">Сервер: ожидает/ошибки</div>
            <div>
              {report ? `${sumPendingErrors(report.server).pending} / ${sumPendingErrors(report.server).error}` : '—'}
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12 }} className="card">
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Клиенты</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Всего: {clientSummary.total} · Проблемные: {clientSummary.problem} · Нет связи: {clientSummary.stale} · Ожидает/Ошибок: {clientSummary.pending} /{' '}
          {clientSummary.error}
          {clientView.hidden > 0 ? ` · Скрыто дублей: ${clientView.hidden}` : ''}
        </div>
        {!clientView.list.length && <div className="muted">Нет данных.</div>}
        {clientView.list.length ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {clientView.list.map((c) => {
              const counts = clientCounts(c);
              const lastActive = lastActiveAt(c);
              const stale = isStale(lastActive, 30);
              const isExpanded = expandedClients[c.clientId] ?? true;
              return (
              <div key={c.clientId} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong>{c.deviceName}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{c.clientId}</span>
                  <span style={{ color: statusColor(c.status), fontWeight: 700 }}>{statusLabel(c.status)}</span>
                  <span style={{ color: '#64748b', fontSize: 12 }}>({c.status})</span>
                  {stale && <span style={{ color: '#b91c1c', fontSize: 12 }}>нет связи</span>}
                  {c.aliases?.length ? <span style={{ color: '#64748b', fontSize: 12 }}>дубликаты: {c.aliases.length}</span> : null}
                  <span style={{ flex: 1 }} />
                  <Button
                    variant="ghost"
                    onClick={() => setExpandedClients((prev) => ({ ...prev, [c.clientId]: !isExpanded }))}
                  >
                    {isExpanded ? 'Свернуть' : 'Развернуть'}
                  </Button>
                  <Button variant="ghost" onClick={() => void loadLastError(c.clientId)}>
                    Последняя ошибка
                  </Button>
                </div>
                {lastErrors[c.clientId]?.loading && <div className="muted" style={{ fontSize: 12 }}>Загрузка ошибки…</div>}
                {lastErrors[c.clientId]?.error && (
                  <div style={{ color: '#b91c1c', fontSize: 12 }}>Ошибка: {lastErrors[c.clientId]?.error}</div>
                )}
                {lastErrors[c.clientId]?.data && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {lastErrors[c.clientId]?.data?.at ? `${lastErrors[c.clientId]?.data?.at}: ` : ''}
                    {String(lastErrors[c.clientId]?.data?.line ?? '').slice(0, 400)}
                  </div>
                )}
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  последняя активность: {formatTs(lastActive)} | lastSeen: {formatTs(c.lastSeenAt)} | lastPullSeq: {c.lastPulledServerSeq ?? '—'} | lastPull:{' '}
                  {formatTs(c.lastPulledAt)} | lastPush: {formatTs(c.lastPushedAt)} | snapshot: {formatTs(c.snapshotAt)}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  хост: {c.lastHostname ?? '—'} · платформа: {c.lastPlatform ?? '—'} · версия: {c.lastVersion ?? '—'} · логин:{' '}
                  {c.lastUsername ?? '—'}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  последний запрос: {formatSyncRequest(c)}
                </div>
                {actionNotices[c.clientId] ? <div style={{ fontSize: 12, color: '#0369a1', marginTop: 4 }}>{actionNotices[c.clientId]}</div> : null}
                <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
                  Ожидает/Ошибки: {counts.pending} / {counts.error} · Различий: {counts.totalDiffs}
                </div>
                {isExpanded && c.aliases?.length ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Другие записи этого компьютера:{' '}
                    {c.aliases
                      .slice(0, 6)
                      .map((a) => `${a.clientId} (${formatTs(lastActiveAt(a))})`)
                      .join(', ')}
                  </div>
                ) : null}
                <div style={{ marginTop: 4, fontSize: 12, color: '#475569' }}>
                  {(() => {
                    const sections = (c.diffs ?? [])
                      .filter((d) => d.kind === 'entityType')
                      .map((d) => ({
                        name: ENTITY_TYPE_META[d.name]?.title ?? d.name,
                        pending: Number(d.client?.pendingCount ?? 0),
                        error: Number(d.client?.errorCount ?? 0),
                        status: d.status,
                      }))
                      .filter((s) => s.pending > 0 || s.error > 0 || s.status !== 'ok');
                    if (sections.length === 0) return <span className="muted">Проблемных разделов нет.</span>;
                    return (
                      <span>
                        Проблемные разделы:{' '}
                        {sections.slice(0, 4).map((s, idx) => (
                          <span key={`${s.name}-${idx}`} style={{ marginRight: 8 }}>
                            {s.name} ({s.pending}/{s.error})
                          </span>
                        ))}
                      </span>
                    );
                  })()}
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="ghost" onClick={() => void requestSync(c.clientId, 'sync_now')} disabled={loading}>
                    Повторить синхронизацию
                  </Button>
                  <Button variant="ghost" onClick={() => void requestSync(c.clientId, 'force_full_pull')} disabled={loading}>
                    Перекачать с сервера
                  </Button>
                </div>
                {isExpanded ? (
                <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                  {(c.diffs ?? [])
                    .filter((d) => {
                      if (!showOnlyDiffs) return true;
                      const pendingTotal = Number(d.client?.pendingCount ?? 0) + Number(d.server?.pendingCount ?? 0);
                      const errorTotal = Number(d.client?.errorCount ?? 0) + Number(d.server?.errorCount ?? 0);
                      return d.status !== 'ok' || pendingTotal > 0 || errorTotal > 0;
                    })
                    .map((d, idx) => (
                    (() => {
                      const meta = d.kind === 'table' ? TABLE_META[d.name] : ENTITY_TYPE_META[d.name];
                      const label = meta?.title ?? (d.kind === 'table' ? `Таблица: ${d.name}` : `Тип: ${d.name}`);
                      const note = d.kind === 'table' ? TABLE_META[d.name]?.note : '';
                      const pendingTotal = Number(d.client?.pendingCount ?? 0) + Number(d.server?.pendingCount ?? 0);
                      const errorTotal = Number(d.client?.errorCount ?? 0) + Number(d.server?.errorCount ?? 0);
                      const hasPendingOrError = pendingTotal > 0 || errorTotal > 0;
                      const bg =
                        errorTotal > 0
                          ? 'rgba(239,68,68,0.08)'
                          : hasPendingOrError
                            ? 'rgba(245,158,11,0.08)'
                            : d.status === 'ok'
                              ? 'transparent'
                              : 'rgba(239,68,68,0.05)';
                      return (
                    <div
                      key={`${d.kind}-${d.name}-${idx}`}
                      style={{
                        border: '1px dashed #e5e7eb',
                        borderRadius: 8,
                        padding: 8,
                        fontSize: 12,
                        background: bg,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong>{label}</strong>
                        <span style={{ color: statusColor(d.status), fontWeight: 700 }}>{statusLabel(d.status)}</span>
                        <span style={{ color: '#64748b' }}>({d.status})</span>
                      </div>
                      {note ? <div className="muted" style={{ marginTop: 4 }}>{note}</div> : null}
                      {hasPendingOrError ? (
                        <div style={{ marginTop: 4, color: errorTotal > 0 ? '#b91c1c' : '#92400e' }}>
                          Ожидает: {pendingTotal} · Ошибок: {errorTotal}
                        </div>
                      ) : null}
                      <div className="muted" style={{ marginTop: 4 }}>
                        {renderSectionRow('server', d.server)}
                      </div>
                      <div className="muted">{renderSectionRow('client', d.client)}</div>
                      {d.kind === 'entityType' && d.client?.pendingItems?.length ? (
                        <div style={{ marginTop: 6 }}>
                          <div style={{ color: '#475569', fontWeight: 600 }}>Ожидают отправки:</div>
                          <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
                            {d.client.pendingItems.map((item) => (
                              <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ color: item.status === 'error' ? '#b91c1c' : '#92400e' }}>
                                  {item.status === 'error' ? 'ошибка' : 'ожидает'}
                                </span>
                                <span>{item.label}</span>
                                <span className="muted" style={{ fontSize: 11 }}>
                                  {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '—'}
                                </span>
                                <span className="muted" style={{ fontSize: 11 }}>{item.id.slice(0, 8)}</span>
                                <Button
                                  variant="ghost"
                                  onClick={() => navigator.clipboard?.writeText(item.id).catch(() => {})}
                                  style={{ fontSize: 11 }}
                                >
                                  копировать id
                                </Button>
                                <Button
                                  variant="ghost"
                                  onClick={() => openEntityCard(d.name, item.id)}
                                  style={{ fontSize: 11 }}
                                >
                                  открыть карточку
                                </Button>
                                <Button
                                  variant="ghost"
                                  onClick={() => void requestEntityDiff(c.clientId, item.id)}
                                  style={{ fontSize: 11 }}
                                >
                                  сверить
                                </Button>
                                <Button
                                  variant="ghost"
                                  onClick={() => void loadEntityDiff(c.clientId, item.id)}
                                  style={{ fontSize: 11 }}
                                >
                                  показать diff
                                </Button>
                                <Button
                                  variant="ghost"
                                  onClick={() => navigator.clipboard?.writeText(buildEntityLink(d.name, item.id)).catch(() => {})}
                                  style={{ fontSize: 11 }}
                                >
                                  копировать ссылку
                                </Button>
                                <Button
                                  variant="ghost"
                                  onClick={() => {
                                    if (!confirm('Удалить локальную запись на клиенте?')) return;
                                    void requestDeleteLocal(c.clientId, item.id);
                                  }}
                                  style={{ fontSize: 11, color: '#b91c1c' }}
                                >
                                  удалить локально
                                </Button>
                              </div>
                            ))}
                            {d.client.pendingItems.map((item) => {
                              const key = `${c.clientId}:${item.id}`;
                              const state = entityDiffs[key];
                              if (!state?.loading && !state?.error && !state?.data) return null;
                              return (
                                <div key={`${item.id}-diff`} style={{ marginLeft: 18, marginTop: 6, padding: 8, background: '#fff7ed', borderRadius: 6 }}>
                                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Diff по атрибутам</div>
                                  {state.loading && <div className="muted">Загрузка…</div>}
                                  {state.error && <div style={{ color: '#b91c1c' }}>{state.error}</div>}
                                  {state.data?.diff && Array.isArray(state.data.diff) ? (
                                    state.data.diff.length === 0 ? (
                                      <div className="muted">Нет различий по атрибутам.</div>
                                    ) : (
                                      <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                                        {state.data.diff.map((row: any, idx: number) => (
                                          <div key={`${row.key}-${idx}`}>
                                            <strong>{row.key}</strong> · server: {JSON.stringify(row.serverValue)} · client: {JSON.stringify(row.clientValue)}
                                          </div>
                                        ))}
                                      </div>
                                    )
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </div>
                      );
                    })()
                  ))}
                </div>
                ) : null}
              </div>
            )})}
          </div>
        ) : null}
      </div>
    </div>
  );
}
