import React, { useEffect, useState } from 'react';

import { getAuditStatisticsStatus } from '../api/audit.js';
import { Button } from './components/Button.js';
import { formatMoscowDateTime, formatRuNumber } from './utils/dateUtils.js';

type StatsStatus = {
  schedulerStarted: boolean;
  schedulerRunning: boolean;
  lastRequestAt: number;
  lastRunAt: number | null;
  lastRunStartedAt: number | null;
  lastRunFinishedAt: number | null;
  lastRunDurationMs: number | null;
  lastRunProcessedRows: number;
  totalProcessedRows: number;
  lastRunError: string | null;
  maxProcessedCreatedAt: number | null;
  lagMs: number | null;
  queueSize: number;
  avgDurationMs: number | null;
  lagSamples: Array<{ at: number; value: number }>;
  queueSamples: Array<{ at: number; value: number }>;
  durationSamples: Array<{ at: number; value: number }>;
  thresholds: {
    lagWarnMs: number;
    lagCritMs: number;
    queueWarn: number;
    queueCrit: number;
    durationWarnMs: number;
    durationCritMs: number;
  };
  health: 'ok' | 'warn' | 'critical';
  intervalMs: number;
  minIdleMs: number;
  maxSkipMs: number;
};

function fmtMs(ms: number | null) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} мс`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} с`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min} мин ${sec} с`;
}

function fmtTs(ms: number | null) {
  if (!ms) return '—';
  return formatMoscowDateTime(ms);
}

function fmtCount(v: number | null | undefined) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? formatRuNumber(n) : '0';
}

function colorByHealth(health: 'ok' | 'warn' | 'critical') {
  if (health === 'critical') return { bg: '#fee2e2', border: '#ef4444', text: '#991b1b', label: 'CRITICAL' };
  if (health === 'warn') return { bg: '#fef3c7', border: '#f59e0b', text: '#92400e', label: 'WARN' };
  return { bg: '#dcfce7', border: '#22c55e', text: '#166534', label: 'OK' };
}

function TrendChart(props: { title: string; samples: Array<{ at: number; value: number }>; valueFormatter: (v: number) => string; color: string }) {
  const width = 420;
  const height = 120;
  const padding = 8;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const points = props.samples ?? [];
  const maxValue = Math.max(1, ...points.map((p) => Number(p.value ?? 0)));
  const step = points.length > 1 ? innerW / (points.length - 1) : innerW;
  const polyline = points
    .map((p, i) => {
      const x = padding + i * step;
      const y = padding + innerH - (Math.max(0, Number(p.value ?? 0)) / maxValue) * innerH;
      return `${x},${y}`;
    })
    .join(' ');
  const latest = points.length > 0 ? Number(points[points.length - 1]?.value ?? 0) : 0;

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10, background: '#fff' }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{props.title}</div>
      <div className="muted" style={{ marginBottom: 8 }}>
        Сейчас: {props.valueFormatter(latest)}
      </div>
      <svg width={width} height={height} style={{ width: '100%', maxWidth: width, height: 'auto', display: 'block' }}>
        <rect x={0} y={0} width={width} height={height} fill="#f8fafc" />
        {points.length > 1 ? (
          <polyline fill="none" stroke={props.color} strokeWidth={2} points={polyline} />
        ) : (
          <text x={12} y={24} fill="#64748b" fontSize={12}>
            Недостаточно данных для графика
          </text>
        )}
      </svg>
    </div>
  );
}

export function StatisticsPage() {
  const [status, setStatus] = useState<StatsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    const r = await getAuditStatisticsStatus().catch((e) => ({ ok: false as const, error: String(e) }));
    if (r && (r as any).ok) {
      setStatus(((r as any).status ?? null) as StatsStatus | null);
    } else {
      setError(`Ошибка: ${String((r as any)?.error ?? 'unknown')}`);
    }
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Статистика: мониторинг сборщика</h3>
        {status && (
          <span
            style={{
              marginLeft: 4,
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 10px',
              borderRadius: 999,
              border: `1px solid ${colorByHealth(status.health).border}`,
              background: colorByHealth(status.health).bg,
              color: colorByHealth(status.health).text,
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {colorByHealth(status.health).label}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Обновление...' : 'Обновить'}
        </Button>
      </div>

      <div className="muted" style={{ marginBottom: 10 }}>
        Диагностика фонового модуля статистики аудита: состояние, лаг, очередь, скорость обработки.
      </div>

      {error && <div style={{ color: '#b91c1c', marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 8 }}>
        <div className="muted">Планировщик</div>
        <div>
          {status?.schedulerStarted ? 'запущен' : 'не запущен'}{status?.schedulerRunning ? ' (тик выполняется)' : ''}
        </div>

        <div className="muted">Последний успешный тик</div>
        <div>{fmtTs(status?.lastRunAt ?? null)}</div>

        <div className="muted">Последний тик (старт)</div>
        <div>{fmtTs(status?.lastRunStartedAt ?? null)}</div>

        <div className="muted">Последний тик (финиш)</div>
        <div>{fmtTs(status?.lastRunFinishedAt ?? null)}</div>

        <div className="muted">Длительность последнего тика</div>
        <div>{fmtMs(status?.lastRunDurationMs ?? null)}</div>

        <div className="muted">Средняя длительность (последние тики)</div>
        <div>{fmtMs(status?.avgDurationMs ?? null)}</div>

        <div className="muted">Обработано в последнем тике</div>
        <div>{fmtCount(status?.lastRunProcessedRows)}</div>

        <div className="muted">Обработано всего</div>
        <div>{fmtCount(status?.totalProcessedRows)}</div>

        <div className="muted">Оценка очереди</div>
        <div>{fmtCount(status?.queueSize)}</div>

        <div className="muted">Лаг данных</div>
        <div>{fmtMs(status?.lagMs ?? null)}</div>

        <div className="muted">Последняя обработанная запись</div>
        <div>{fmtTs(status?.maxProcessedCreatedAt ?? null)}</div>

        <div className="muted">Последняя ошибка</div>
        <div style={{ color: status?.lastRunError ? '#b91c1c' : 'inherit' }}>{status?.lastRunError ?? '—'}</div>

        <div className="muted">Интервал тика</div>
        <div>{fmtMs(status?.intervalMs ?? null)}</div>

        <div className="muted">Минимальный idle перед тиком</div>
        <div>{fmtMs(status?.minIdleMs ?? null)}</div>

        <div className="muted">Максимальный skip при нагрузке</div>
        <div>{fmtMs(status?.maxSkipMs ?? null)}</div>
      </div>

      {status && (
        <>
          <div style={{ marginTop: 14, marginBottom: 8, fontWeight: 700 }}>Пороги алертов</div>
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 8, marginBottom: 14 }}>
            <div className="muted">Lag warn / critical</div>
            <div>
              {fmtMs(status.thresholds.lagWarnMs)} / {fmtMs(status.thresholds.lagCritMs)}
            </div>
            <div className="muted">Queue warn / critical</div>
            <div>
              {fmtCount(status.thresholds.queueWarn)} / {fmtCount(status.thresholds.queueCrit)}
            </div>
            <div className="muted">Duration warn / critical</div>
            <div>
              {fmtMs(status.thresholds.durationWarnMs)} / {fmtMs(status.thresholds.durationCritMs)}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 10 }}>
            <TrendChart title="Lag (мс)" samples={status.lagSamples ?? []} valueFormatter={(v) => fmtMs(v)} color="#2563eb" />
            <TrendChart title="Очередь (событий)" samples={status.queueSamples ?? []} valueFormatter={(v) => fmtCount(v)} color="#9333ea" />
            <TrendChart
              title="Длительность тика (мс)"
              samples={status.durationSamples ?? []}
              valueFormatter={(v) => fmtMs(v)}
              color="#ea580c"
            />
          </div>
        </>
      )}
    </div>
  );
}
