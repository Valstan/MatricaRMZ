import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';

type MasterdataRow = {
  id: string;
  displayName: string;
  searchText: string;
  updatedAt: number;
};

type SortKey = 'name' | 'updatedAt';

export function MasterdataDirectoryPage(props: {
  typeCode: string;
  titleLabel: string;
  emptyText: string;
  searchPlaceholder: string;
  createButtonText: string;
  defaultName: string;
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canView?: boolean;
  noAccessText?: string;
}) {
  const [rows, setRows] = useState<MasterdataRow[]>([]);
  const [typeId, setTypeId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const canView = props.canView !== false;

  const refresh = useCallback(async () => {
    if (!canView) return;
    try {
      setStatus('Загрузка...');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as Array<Record<string, unknown>>).find((row) => String(row.code ?? '') === props.typeCode);
      if (!type?.id) {
        setTypeId('');
        setRows([]);
        setStatus(`Справочник "${props.titleLabel}" не найден (${props.typeCode}).`);
        return;
      }
      const resolvedTypeId = String(type.id);
      setTypeId(resolvedTypeId);
      const list = await window.matrica.admin.entities.listByEntityType(resolvedTypeId);
      setRows(
        (Array.isArray(list) ? list : []).map((row: any) => ({
          id: String(row?.id ?? ''),
          displayName: String(row?.displayName ?? '').trim(),
          searchText: String(row?.searchText ?? '').trim(),
          updatedAt: Number(row?.updatedAt ?? 0),
        })),
      );
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [canView, props.titleLabel, props.typeCode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => `${row.displayName} ${row.searchText}`.toLowerCase().includes(q));
  }, [query, rows]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = String(a.displayName ?? '').localeCompare(String(b.displayName ?? ''), 'ru');
      else cmp = Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
      if (cmp === 0) cmp = String(a.id).localeCompare(String(b.id), 'ru');
      return cmp * dir;
    });
  }, [filtered, sortDir, sortKey]);
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

  function label(title: string, key: SortKey) {
    if (sortKey !== key) return title;
    return `${title} ${sortDir === 'asc' ? '↑' : '↓'}`;
  }

  if (!canView) {
    return <div style={{ color: 'var(--subtle)' }}>{props.noAccessText ?? 'Недостаточно прав для просмотра.'}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate ? (
          <Button
            onClick={async () => {
              if (!typeId) return;
              try {
                const created = await window.matrica.admin.entities.create(typeId);
                if (!created?.ok || !created.id) {
                  setStatus('Ошибка: не удалось создать запись.');
                  return;
                }
                await window.matrica.admin.entities.setAttr(created.id, 'name', props.defaultName);
                await refresh();
                await props.onOpen(created.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            {props.createButtonText}
          </Button>
        ) : null}
        <div style={{ flex: 1 }}>
          <Input
            value={query}
            onChange={(e) => {
              setPageIndex(0);
              setQuery(e.target.value);
            }}
            placeholder={props.searchPlaceholder}
          />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
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

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>
                {label('Название', 'name')}
              </th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
                {label('Обновлено', 'updatedAt')}
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={2} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  {rows.length === 0 ? props.emptyText : 'Не найдено'}
                </td>
              </tr>
            ) : (
              paged.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => void props.onOpen(row.id)}>
                  <td>{row.displayName || '(без названия)'}</td>
                  <td>{row.updatedAt > 0 ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

