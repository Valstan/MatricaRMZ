import React, { useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

function toInputDate(ms: number) {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function ReportsPage() {
  const today = useMemo(() => new Date(), []);
  const [startDate, setStartDate] = useState<string>(() => toInputDate(new Date(today.getFullYear(), today.getMonth(), 1).getTime()));
  const [endDate, setEndDate] = useState<string>(() => toInputDate(Date.now()));
  const [status, setStatus] = useState<string>('');
  const [groupBy, setGroupBy] = useState<'none' | 'customer' | 'contract' | 'work_order'>('none');

  async function downloadCsv() {
    const startMs = fromInputDate(startDate);
    const endMsRaw = fromInputDate(endDate);
    const endMs = endMsRaw ? endMsRaw + 24 * 60 * 60 * 1000 - 1 : null;
    if (!endMs) {
      setStatus('Некорректная дата окончания.');
      return;
    }
    setStatus('Формирование отчёта...');
    const r =
      groupBy === 'none'
        ? await window.matrica.reports.periodStagesCsv({ startMs: startMs ?? undefined, endMs })
        : await window.matrica.reports.periodStagesByLinkCsv({
            startMs: startMs ?? undefined,
            endMs,
            linkAttrCode: groupBy === 'customer' ? 'customer_id' : groupBy === 'contract' ? 'contract_id' : 'work_order_id',
          });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = groupBy === 'none' ? `stages_${startDate}_${endDate}.csv` : `stages_${groupBy}_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Готово: CSV скачан.');
  }

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Отчёты</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Отчёт: сколько двигателей на какой стадии (по последней операции на дату окончания), опционально с группировкой по заказчику/контракту/наряду.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 200 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Начало (включительно)</div>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div style={{ width: 200 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Конец (включительно)</div>
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div style={{ width: 220 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Группировка</div>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as any)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
          >
            <option value="none">без группировки</option>
            <option value="customer">по заказчику</option>
            <option value="contract">по контракту</option>
            <option value="work_order">по наряду</option>
          </select>
        </div>
        <div style={{ flex: 1 }} />
        <Button onClick={() => void downloadCsv()}>Скачать CSV</Button>
      </div>

      {status && <div style={{ marginTop: 10, color: '#6b7280' }}>{status}</div>}
    </div>
  );
}


