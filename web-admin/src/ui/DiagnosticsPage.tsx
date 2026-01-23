import React, { useEffect, useState } from 'react';

import { getConsistencyReport, runConsistencyCheck, type ConsistencyClientReport, type ConsistencySnapshot } from '../api/diagnostics.js';
import { Button } from './components/Button.js';

type Report = { server: ConsistencySnapshot; clients: ConsistencyClientReport[] };

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

function renderSectionRow(label: string, section: { count: number; maxUpdatedAt: number | null; checksum: string | null } | null) {
  if (!section) return `${label}: —`;
  const updated = section.maxUpdatedAt ? new Date(section.maxUpdatedAt).toLocaleString() : '—';
  return `${label}: count=${section.count}, maxUpdatedAt=${updated}`;
}

export function DiagnosticsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [report, setReport] = useState<Report | null>(null);

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

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: '8px 0' }}>Диагностика</h2>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
          Обновить
        </Button>
        <Button onClick={() => void runNow()} disabled={loading}>
          Отправить диагностику сейчас
        </Button>
      </div>

      {error && <div className="muted">Ошибка: {error}</div>}

      <div style={{ marginTop: 10 }} className="card">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <div className="muted">Снимок сервера</div>
            <div>{report ? formatTs(report.server.generatedAt) : '—'}</div>
          </div>
          <div>
            <div className="muted">Последний server_seq</div>
            <div>{report?.server.serverSeq ?? '—'}</div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12 }} className="card">
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Клиенты</div>
        {!report?.clients?.length && <div className="muted">Нет данных.</div>}
        {report?.clients?.length ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {report.clients.map((c) => (
              <div key={c.clientId} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong>{c.clientId}</strong>
                  <span style={{ color: statusColor(c.status), fontWeight: 700 }}>{c.status}</span>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  lastSeen: {formatTs(c.lastSeenAt)} | lastPullSeq: {c.lastPulledServerSeq ?? '—'} | lastPull: {formatTs(c.lastPulledAt)} |
                  snapshot: {formatTs(c.snapshotAt)}
                </div>
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  Дифов: {c.diffs?.filter((d) => d.status !== 'ok').length ?? 0}
                </div>
                <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                  {(c.diffs ?? []).map((d, idx) => (
                    <div
                      key={`${d.kind}-${d.name}-${idx}`}
                      style={{
                        border: '1px dashed #e5e7eb',
                        borderRadius: 8,
                        padding: 8,
                        fontSize: 12,
                        background: d.status === 'ok' ? 'transparent' : 'rgba(239,68,68,0.05)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong>{d.kind === 'table' ? `table:${d.name}` : `type:${d.name}`}</strong>
                        <span style={{ color: statusColor(d.status), fontWeight: 700 }}>{d.status}</span>
                      </div>
                      <div className="muted" style={{ marginTop: 4 }}>
                        {renderSectionRow('server', d.server)}
                      </div>
                      <div className="muted">{renderSectionRow('client', d.client)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
