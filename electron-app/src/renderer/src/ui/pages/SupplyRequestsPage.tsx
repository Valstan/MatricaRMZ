import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type Row = {
  id: string;
  requestNumber: string;
  compiledAt: number;
  status: string;
  title: string;
  departmentId: string;
  workshopId: string | null;
  sectionId: string | null;
  updatedAt: number;
};

function statusLabel(s: string): string {
  switch (s) {
    case 'draft':
      return 'Черновик';
    case 'signed':
      return 'Подписана начальником';
    case 'director_approved':
      return 'Одобрена директором';
    case 'accepted':
      return 'Принята к исполнению';
    case 'fulfilled_full':
      return 'Исполнена полностью';
    case 'fulfilled_partial':
      return 'Исполнена частично';
    default:
      return s;
  }
}

export function SupplyRequestsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
}) {
  const [query, setQuery] = useState<string>('');
  const [month, setMonth] = useState<string>(''); // YYYY-MM
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');

  async function refresh() {
    try {
      setStatus('Загрузка…');
      const r = await window.matrica.supplyRequests.list({ q: query.trim() || undefined, month: month || undefined });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows(r.requests as any);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [rows]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию/тексту/товарам…" />
        </div>
        <div style={{ width: 180 }}>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Поиск
        </Button>
        {props.canCreate && (
          <Button
            onClick={async () => {
              const r = await window.matrica.supplyRequests.create();
              if (!r.ok) {
                setStatus(`Ошибка: ${r.error}`);
                return;
              }
              await props.onOpen(r.id);
            }}
          >
            Создать заявку
          </Button>
        )}
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'linear-gradient(135deg, #a21caf 0%, #7c3aed 120%)', color: '#fff' }}>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Номер</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Дата</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Статус</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Описание</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Подразделение</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.id}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  void props.onOpen(r.id);
                }}
              >
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{r.requestNumber || r.id}</td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                  {r.compiledAt ? new Date(r.compiledAt).toLocaleDateString('ru-RU') : '-'}
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{statusLabel(r.status)}</td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{r.title || '-'}</td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{r.departmentId || '-'}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td style={{ padding: 12, color: '#6b7280' }} colSpan={5}>
                  Ничего не найдено
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


