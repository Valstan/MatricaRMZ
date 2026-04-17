import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

type TemplateRow = {
  id: string;
  name?: string;
  description?: string;
  updatedAt: number;
  createdAt: number;
};

type SortKey = 'name' | 'description' | 'updatedAt';

export function PartTemplatesPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
}) {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
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
    () => {
      const dir = sortDir === 'asc' ? 1 : -1;
      return [...rows].sort((a, b) => {
        let cmp = 0;
        if (sortKey === 'name') cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
        else if (sortKey === 'description') cmp = String(a.description ?? '').localeCompare(String(b.description ?? ''), 'ru');
        else cmp = Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
        if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
        return cmp * dir;
      });
    },
    [rows, sortDir, sortKey],
  );
  const paged = useMemo(() => {
    const start = pageIndex * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [pageIndex, pageSize, sorted]);

  function onSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      setPageIndex(0);
      return;
    }
    setSortKey(nextKey);
    setSortDir('asc');
    setPageIndex(0);
  }

  function sortLabel(label: string, key: SortKey) {
    if (sortKey !== key) return label;
    return `${label} ${sortDir === 'asc' ? '↑' : '↓'}`;
  }

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
                  setStatus(`Ошибка: ${!created.ok ? created.error : 'Не удалось создать деталь'}`);
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
            Создать новый шаблон детали
          </Button>
        ) : null}
        <div style={{ flex: 1 }}>
          <Input
            value={query}
            onChange={(e) => {
              setPageIndex(0);
              setQuery(e.target.value);
            }}
            placeholder="Поиск по справочнику деталей…"
          />
        </div>
      </div>

      {status ? <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div> : null}
      <WarehouseListPager
        pageSize={pageSize}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPageIndex(0);
        }}
        pageIndex={pageIndex}
        onPageIndexChange={setPageIndex}
        rowCount={paged.length}
        totalCount={sorted.length}
      />

      <div style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto', border: '1px solid #e5e7eb' }}>
        <table className="list-table">
          <thead>
            <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
              <th
                style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }}
                onClick={() => onSort('name')}
              >
                {sortLabel('Название', 'name')}
              </th>
              <th
                style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }}
                onClick={() => onSort('description')}
              >
                {sortLabel('Описание', 'description')}
              </th>
              <th
                style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }}
                onClick={() => onSort('updatedAt')}
              >
                {sortLabel('Обновлено', 'updatedAt')}
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Справочник деталей пуст' : 'Не найдено'}
                </td>
              </tr>
            ) : null}
            {paged.map((row) => (
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
