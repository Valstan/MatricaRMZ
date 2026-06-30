import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ENGINE_OUTPUT_METRIC_LABEL,
  scrapRate,
  seriesGrowth,
  type AnalyticsBucket,
  type EngineOutputMetric,
  type EngineOutputResult,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { MultiSeriesLineChart, type ChartSeries } from '../components/MultiSeriesLineChart.js';

const PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2',
  '#db2777', '#65a30d', '#0d9488', '#9333ea', '#ea580c', '#4f46e5',
];

const METRICS: EngineOutputMetric[] = ['shipped', 'repaired', 'arrived'];
const BUCKETS: { id: AnalyticsBucket; label: string }[] = [
  { id: 'day', label: 'По дням' },
  { id: 'week', label: 'По неделям' },
  { id: 'month', label: 'По месяцам' },
];
const WINDOWS: { days: number; label: string }[] = [
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
  { days: 180, label: 'Полгода' },
  { days: 365, label: 'Год' },
];

function ymdDaysAgo(days: number): string {
  const ms = Date.now() - days * 86_400_000;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(ms));
}

function formatBucketLabel(label: string, bucket: AnalyticsBucket): string {
  const [y, m, d] = label.split('-');
  if (bucket === 'month') return `${m}.${y}`;
  return `${d}.${m}`;
}

export function WarehouseAnalyticsPage(): React.JSX.Element {
  const [metric, setMetric] = useState<EngineOutputMetric>('shipped');
  const [bucket, setBucket] = useState<AnalyticsBucket>('month');
  const [from, setFrom] = useState<string>(ymdDaysAgo(365));
  const [to, setTo] = useState<string>(ymdDaysAgo(0));
  const [workshopId, setWorkshopId] = useState<string>('');
  const [workshops, setWorkshops] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<EngineOutputResult | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showScrap, setShowScrap] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    void (async () => {
      try {
        const r = await window.matrica.workshops.list({ activeOnly: true });
        if (r?.ok) setWorkshops(r.rows.map((w) => ({ id: String(w.id), name: String(w.name) })));
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка…');
      const r = await window.matrica.warehouse.analyticsEngineOutput({ metric, bucket, from, to, ...(workshopId ? { workshopId } : {}) });
      if (!r?.ok) {
        setStatus(`Ошибка: ${String(r?.error ?? 'unknown')}`);
        return;
      }
      setData(r.result);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [metric, bucket, from, to, workshopId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const seriesKey = (s: { brandId: string | null; brandName: string }) => s.brandId ?? `name:${s.brandName}`;

  const chartSeries: ChartSeries[] = useMemo(() => {
    if (!data) return [];
    return data.series.map((s, i) => {
      const key = seriesKey(s);
      return {
        key,
        name: s.brandName,
        color: PALETTE[i % PALETTE.length] ?? '#666',
        points: showScrap ? s.scrapPoints : s.points,
        visible: !hidden.has(key),
      };
    });
  }, [data, hidden, showScrap]);

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const setWindow = (days: number) => {
    setFrom(ymdDaysAgo(days));
    setTo(ymdDaysAgo(0));
  };

  const showOnly = (keys: string[]) => {
    if (!data) return;
    const keep = new Set(keys);
    setHidden(new Set(data.series.map(seriesKey).filter((k) => !keep.has(k))));
  };

  const activePoints = (s: { points: number[]; scrapPoints: number[] }) => (showScrap ? s.scrapPoints : s.points);
  const topGrowing = () => {
    if (!data) return;
    const ranked = [...data.series]
      .map((s) => ({ key: seriesKey(s), g: seriesGrowth(activePoints(s)) }))
      .sort((a, b) => b.g - a.g)
      .slice(0, 5)
      .map((x) => x.key);
    showOnly(ranked);
  };
  const topLagging = () => {
    if (!data) return;
    const ranked = [...data.series]
      .map((s) => ({ key: seriesKey(s), g: seriesGrowth(activePoints(s)) }))
      .sort((a, b) => a.g - b.g)
      .slice(0, 5)
      .map((x) => x.key);
    showOnly(ranked);
  };

  const btn = (active: boolean): React.CSSProperties => ({ opacity: active ? 1 : 0.6 });

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>📈 Аналитика выпуска двигателей</h2>
        <span style={{ color: '#888', fontSize: 13 }}>
          {showScrap ? 'Брак' : ENGINE_OUTPUT_METRIC_LABEL[metric]} по маркам · серии во времени
        </span>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {METRICS.map((m) => (
            <Button key={m} size="sm" variant="outline" style={btn(metric === m)} onClick={() => setMetric(m)}>
              {ENGINE_OUTPUT_METRIC_LABEL[m]}
            </Button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {BUCKETS.map((b) => (
            <Button key={b.id} size="sm" variant="outline" style={btn(bucket === b.id)} onClick={() => setBucket(b.id)}>
              {b.label}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          style={btn(showScrap)}
          title="Показать серии брака по маркам вместо выпуска"
          onClick={() => setShowScrap((v) => !v)}
        >
          {showScrap ? '● Брак по маркам' : '○ Брак по маркам'}
        </Button>
        <div style={{ display: 'flex', gap: 4 }}>
          {WINDOWS.map((w) => (
            <Button key={w.days} size="sm" variant="ghost" onClick={() => setWindow(w.days)}>
              {w.label}
            </Button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#888' }}>с</span>
          <div style={{ width: 130 }}>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <span style={{ fontSize: 12, color: '#888' }}>по</span>
          <div style={{ width: 130 }}>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#888' }}>Цех</span>
          <select
            value={workshopId}
            onChange={(e) => { setWorkshopId(e.target.value); setHidden(new Set()); }}
            style={{ minHeight: 28, fontSize: 13, padding: '4px 6px' }}
          >
            <option value="">Все цеха</option>
            {workshops.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Summary */}
      {data && (
        <div style={{ display: 'flex', gap: 20, fontSize: 13, color: '#444', flexWrap: 'wrap' }}>
          <span>Всего: <b>{data.grandTotal}</b></span>
          <span>Марок: <b>{data.series.length}</b></span>
          <span>
            Брак за период: <b style={{ color: data.scrapTotal > 0 ? '#dc2626' : undefined }}>{data.scrapTotal}</b>
            {data.grandTotal > 0 && (
              <span style={{ color: '#888' }}> ({(scrapRate(data.grandTotal, data.scrapTotal) * 100).toFixed(1)}%)</span>
            )}
          </span>
          {status && <span style={{ color: '#dc2626' }}>{status}</span>}
        </div>
      )}
      {!data && status && <div style={{ color: '#dc2626', fontSize: 13 }}>{status}</div>}

      {/* Per-shop summary (C3): shown only when a workshop is selected. */}
      {data?.workshopSummary && (
        <div
          style={{
            display: 'flex',
            gap: 24,
            flexWrap: 'wrap',
            alignItems: 'center',
            padding: '8px 12px',
            background: 'var(--surface-muted, #f5f7fa)',
            border: '1px solid var(--border, #e5e5e5)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 600 }}>
            {workshops.find((w) => w.id === workshopId)?.name ?? 'Цех'}
          </span>
          <span>Выпустил за период: <b>{data.workshopSummary.shippedInWindow}</b></span>
          <span>
            Сейчас в цехе: <b>{data.workshopSummary.onHand}</b>
            <span style={{ color: '#888' }}>
              {' '}(в работе {data.workshopSummary.inProgress}, готово к отгрузке {data.workshopSummary.repairedNotShipped})
            </span>
          </span>
          <span title="Передано в другой цех за период (межцеховые передачи)">
            Отдал: <b>{data.workshopSummary.handedOff}</b>
          </span>
        </div>
      )}

      {/* Chart */}
      <div style={{ border: '1px solid var(--border, #e5e5e5)', borderRadius: 6, padding: 8 }}>
        <MultiSeriesLineChart axis={data?.axis ?? []} series={chartSeries} formatLabel={(l) => formatBucketLabel(l, bucket)} />
      </div>

      {/* Series checkboxes */}
      {data && data.series.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#888' }}>Марки:</span>
            <Button size="sm" variant="ghost" onClick={() => setHidden(new Set())}>Все</Button>
            <Button size="sm" variant="ghost" onClick={topGrowing}>Топ растущих</Button>
            <Button size="sm" variant="ghost" onClick={topLagging}>Отстающие</Button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
            {chartSeries.map((s) => {
              const src = data.series.find((x) => seriesKey(x) === s.key);
              return (
                <label key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer', opacity: s.visible ? 1 : 0.5 }}>
                  <input type="checkbox" checked={s.visible} onChange={() => toggle(s.key)} />
                  <span style={{ width: 10, height: 10, background: s.color, borderRadius: 2, display: 'inline-block' }} />
                  <span>{s.name}</span>
                  {showScrap ? (
                    <span style={{ color: '#999' }}>
                      ({src?.scrap ?? 0}
                      {src && src.total > 0 ? ` · ${(scrapRate(src.total, src.scrap) * 100).toFixed(0)}%` : ''})
                    </span>
                  ) : (
                    <span style={{ color: '#999' }}>({src?.total ?? 0})</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
