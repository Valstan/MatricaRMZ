import React, { useCallback, useEffect, useState } from 'react';
import type { WorkshopStatsResult } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

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

function fmtRub(v: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(v));
}

function fmtDate(ms: number): string {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' }).format(new Date(ms));
}

export function WorkshopStatsPage(): React.JSX.Element {
  const [from, setFrom] = useState<string>(ymdDaysAgo(365));
  const [to, setTo] = useState<string>(ymdDaysAgo(0));
  const [workshopId, setWorkshopId] = useState<string>('');
  const [workshops, setWorkshops] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<WorkshopStatsResult | null>(null);
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
      const r = await window.matrica.workshops.stats({ from, to, ...(workshopId ? { workshopId } : {}) });
      if (!r?.ok) {
        setStatus(`Ошибка: ${String(r?.error ?? 'unknown')}`);
        return;
      }
      setData(r.result);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [from, to, workshopId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedRoutes = data?.selected?.routes ?? [];

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 4px' }}>📊 Статистика цехов</h2>
        <div style={{ fontSize: 13, color: '#64748b' }}>
          Труд и прохождение двигателей по цехам — из нарядов. Выберите цех, чтобы увидеть маршруты прошедших через него двигателей.
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {WINDOWS.map((w) => (
            <Button
              key={w.days}
              variant="ghost"
              onClick={() => {
                setFrom(ymdDaysAgo(w.days));
                setTo(ymdDaysAgo(0));
              }}
            >
              {w.label}
            </Button>
          ))}
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#64748b' }}>
          С
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#64748b' }}>
          По
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#64748b' }}>
          Цех (для маршрутов)
          <select
            value={workshopId}
            onChange={(e) => setWorkshopId(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', minWidth: 200 }}
          >
            <option value="">— все цеха —</option>
            {workshops.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => void refresh()}>Обновить</Button>
        {status && <span style={{ fontSize: 13, color: status.startsWith('Ошибка') ? '#dc2626' : '#64748b' }}>{status}</span>}
      </div>

      {data?.coverageNote && (
        <div
          style={{
            padding: '8px 12px',
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: 8,
            fontSize: 13,
            color: '#92400e',
          }}
        >
          ⚠️ {data.coverageNote}
        </div>
      )}

      <div>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>
              <th style={{ padding: '8px 10px' }}>Цех</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Этапов (нарядов)</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Двигателей</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Начислено, ₽</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Бригада, чел.</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((row) => (
              <tr
                key={row.workshopId}
                onClick={() => setWorkshopId((cur) => (cur === row.workshopId ? '' : row.workshopId))}
                style={{
                  borderBottom: '1px solid #f1f5f9',
                  cursor: 'pointer',
                  background: workshopId === row.workshopId ? '#eff6ff' : undefined,
                }}
              >
                <td style={{ padding: '8px 10px' }}>{row.workshopName}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{row.orders}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{row.engines}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtRub(row.laborRub)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{row.crew}</td>
              </tr>
            ))}
            {(data?.rows ?? []).length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: '16px 10px', color: '#94a3b8', textAlign: 'center' }}>
                  Нет данных за период.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {workshopId && (
        <div>
          <h3 style={{ margin: '8px 0' }}>
            Маршруты двигателей через «{workshops.find((w) => w.id === workshopId)?.name ?? 'цех'}»
            <span style={{ fontSize: 13, color: '#94a3b8', fontWeight: 400 }}> ({selectedRoutes.length})</span>
          </h3>
          {selectedRoutes.length === 0 && (
            <div style={{ color: '#94a3b8', fontSize: 13 }}>Через этот цех за период двигатели не проходили.</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {selectedRoutes.map((route) => (
              <div key={route.engineId} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{route.engineName}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  {route.steps.map((step, i) => (
                    <React.Fragment key={`${route.engineId}-${i}`}>
                      {i > 0 && <span style={{ color: '#94a3b8' }}>→</span>}
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: 12,
                          background: step.workshopId === workshopId ? '#dbeafe' : '#f1f5f9',
                          border: step.workshopId === workshopId ? '1px solid #93c5fd' : '1px solid #e2e8f0',
                        }}
                        title={`Наряд №${step.workOrderNumber} · ${fmtRub(step.amountRub)} ₽`}
                      >
                        {step.workshopName} <span style={{ color: '#94a3b8' }}>{fmtDate(step.performedAt)}</span>
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
