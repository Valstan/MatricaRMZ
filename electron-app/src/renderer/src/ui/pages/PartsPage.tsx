import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type Row = {
  id: string;
  name?: string;
  article?: string;
  updatedAt: number;
  createdAt: number;
};

export function PartsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
}) {
  const [query, setQuery] = useState<string>('');
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');

  async function refresh() {
    try {
      setStatus('Загрузка…');
      const r = await window.matrica.parts.list({ q: query.trim() || undefined });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows(r.parts as any);
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
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию/артикулу…" />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Поиск
        </Button>
        {props.canCreate && (
          <Button
            onClick={async () => {
              try {
                setStatus('Создание детали...');
                const r = await window.matrica.parts.create();
                if (!r.ok) {
                  setStatus(`Ошибка: ${r.error}`);
                  return;
                }
                if (!r.part || !r.part.id) {
                  setStatus('Ошибка: некорректный ответ от сервера');
                  return;
                }
                setStatus('');
                await props.onOpen(r.part.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Создать деталь
          </Button>
        )}
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
              <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, fontSize: 14, color: '#374151' }}>Название</th>
              <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, fontSize: 14, color: '#374151' }}>Артикул</th>
              <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, fontSize: 14, color: '#374151' }}>Обновлено</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={3} style={{ padding: '24px 16px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет деталей' : 'Не найдено'}
                </td>
              </tr>
            )}
            {sorted.map((row) => (
              <tr
                key={row.id}
                style={{
                  borderBottom: '1px solid #f3f4f6',
                  cursor: 'pointer',
                }}
                onClick={() => void props.onOpen(row.id)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f9fafb';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <td style={{ padding: '12px 16px', fontSize: 14, color: '#111827' }}>{row.name || '(без названия)'}</td>
                <td style={{ padding: '12px 16px', fontSize: 14, color: '#6b7280' }}>{row.article || '—'}</td>
                <td style={{ padding: '12px 16px', fontSize: 14, color: '#6b7280' }}>
                  {row.updatedAt ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

