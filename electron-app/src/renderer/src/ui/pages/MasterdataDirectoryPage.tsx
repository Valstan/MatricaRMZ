import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { useCardContentIds } from '../hooks/useListDeepFilter.js';
import { matchesQueryInRecord } from '../utils/search.js';
import { formatListDateTime } from '../utils/dateUtils.js';

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
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;
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

  // Верхний поиск: поля строки + внутрь карточки (EAV).
  const getRowId = useCallback((row: { id: string }) => String(row.id), []);
  const deepIds = useCardContentIds(rows, getRowId, query);
  const filtered = useMemo(
    () =>
      rows.filter(
        (row) =>
          matchesQueryInRecord(query, { displayName: row.displayName, searchText: row.searchText }) ||
          (deepIds?.has(String(row.id)) ?? false),
      ),
    [query, rows, deepIds],
  );

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

  function onSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(nextKey);
    setSortDir('asc');
  }

  function label(title: string, key: SortKey) {
    if (sortKey !== key) return title;
    return `${title} ${sortDir === 'asc' ? '↑' : '↓'}`;
  }

  const tableHeader = (
    <thead>
      <tr>
        <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>
          {label('Название', 'name')}
        </th>
        <th data-col-kind="date" title="Обновлено" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
          {label('Обновлено', 'updatedAt')}
        </th>
      </tr>
    </thead>
  );

  function renderMasterdataCells(row: MasterdataRow) {
    return (
      <>
        <td data-col-kind="name">{row.displayName || '(без названия)'}</td>
        <td data-col-kind="date">{row.updatedAt > 0 ? formatListDateTime(row.updatedAt) : '—'}</td>
      </>
    );
  }

  function rowProps(row: MasterdataRow): VirtualTableRowProps {
    return {
      style: { cursor: 'pointer' },
      onClick: () => void props.onOpen(row.id),
    };
  }

  function renderTable(items: MasterdataRow[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'clip' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.map((row) => (
              <tr key={row.id} {...rowProps(row)}>
                {renderMasterdataCells(row)}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={2}>
                  {rows.length === 0 ? props.emptyText : 'Не найдено'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
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

      <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {twoCol ? (
          <TwoColumnList items={sorted} enabled renderColumn={(items) => renderTable(items)} />
        ) : (
          <VirtualTable
            scrollElementRef={containerRef}
            count={sorted.length}
            header={tableHeader}
            renderCells={(i) => renderMasterdataCells(sorted[i]!)}
            getRowKey={(i) => sorted[i]!.id}
            getRowProps={(i) => rowProps(sorted[i]!)}
            colCount={2}
            estimateSize={40}
            emptyState={rows.length === 0 ? props.emptyText : 'Не найдено'}
          />
        )}
      </div>
      <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {sorted.length}</div>
    </div>
  );
}

