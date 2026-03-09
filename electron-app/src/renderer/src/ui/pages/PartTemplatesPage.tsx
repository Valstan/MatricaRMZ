import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

type TemplateRow = {
  id: string;
  name?: string;
  description?: string;
  updatedAt: number;
  createdAt: number;
};

export function PartTemplatesPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
}) {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const queryTimer = useRef<number | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const r = await window.matrica.parts.templates.list(query.trim() ? { q: query.trim(), limit: 5000 } : { limit: 5000 });
      if (!r.ok) {
        if (!silent) setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows(r.templates as TemplateRow[]);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (queryTimer.current) window.clearTimeout(queryTimer.current);
    queryTimer.current = window.setTimeout(() => {
      void load();
    }, 300);
    return () => {
      if (queryTimer.current) window.clearTimeout(queryTimer.current);
    };
  }, [load]);

  useLiveDataRefresh(
    useCallback(async () => {
      await load({ silent: true });
    }, [load]),
    { intervalMs: 15000 },
  );

  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru')),
    [rows],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate ? (
          <Button
            onClick={async () => {
              const name = prompt('Название детали')?.trim() ?? '';
              if (!name) return;
              try {
                setStatus('Создание детали...');
                const created = await window.matrica.parts.templates.create({ attributes: { name } });
                if (!created.ok || !created.template?.id) {
                  setStatus(`Ошибка: ${created.error ?? 'Не удалось создать деталь'}`);
                  return;
                }
                setStatus('');
                await load({ silent: true });
                await props.onOpen(created.template.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Создать деталь
          </Button>
        ) : null}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по справочнику деталей…" />
        </div>
      </div>

      {status ? <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div> : null}

      <div style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto', border: '1px solid #e5e7eb' }}>
        <table className="list-table">
          <thead>
            <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
              <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Название</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Описание</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Обновлено</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Справочник деталей пуст' : 'Не найдено'}
                </td>
              </tr>
            ) : null}
            {sorted.map((row) => (
              <tr
                key={row.id}
                style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                onClick={() => {
                  void props.onOpen(row.id);
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f9fafb';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.name || '(без названия)'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.description || '—'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
