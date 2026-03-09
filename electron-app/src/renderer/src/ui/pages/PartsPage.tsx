import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { useListSelection } from '../hooks/useListSelection.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';
import { invalidateListAllPartsCache, listAllParts } from '../utils/partsPagination.js';
import {
  buildCopyRowsStatus,
  buildDeleteConfirmMessage,
  buildDeleteRowsStatus,
  buildListContextMenuItems,
  copyRowsToClipboard,
  printRowsPreview,
  resolveMenuRows,
} from '../utils/listContextActions.js';

type Row = {
  id: string;
  name?: string;
  article?: string;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
  updatedAt: number;
  createdAt: number;
};
type SortKey = 'name' | 'article' | 'updatedAt';
type TemplateOption = { id: string; label: string };

export function PartsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const { state: listState, patchState } = useListUiState('list:parts', {
    query: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
    showPreviews: true,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:parts');
  const query = String(listState.query ?? '');
  const showPreviews = listState.showPreviews !== false;
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [templateOptions, setTemplateOptions] = useState<TemplateOption[]>([]);
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const width = useWindowWidth();
  const { isMultiColumn, toggle: toggleColumnsMode } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;
  const queryTimer = useRef<number | null>(null);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const r = await listAllParts(query.trim() ? { q: query.trim() } : {});
      if (!r.ok) {
        if (!silent) setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows(r.parts as any);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!props.canCreate) return;
    void (async () => {
      const r = await window.matrica.parts.templates.list({ limit: 5000 }).catch((e) => ({ ok: false as const, error: String(e) }));
      if (!r.ok) {
        setTemplateOptions([]);
        return;
      }
      const opts = r.templates.map((row) => ({
        id: String(row.id),
        label: String(row.name ?? row.description ?? row.id),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setTemplateOptions(opts);
    })();
  }, [props.canCreate]);

  useEffect(() => {
    if (queryTimer.current) {
      window.clearTimeout(queryTimer.current);
    }
    queryTimer.current = window.setTimeout(() => {
      void refresh();
    }, 300);
    return () => {
      if (queryTimer.current) window.clearTimeout(queryTimer.current);
    };
  }, [query]);

  useLiveDataRefresh(
    useCallback(async () => {
      await refresh({ silent: true });
    }, [refresh]),
    { intervalMs: 15000 },
  );

  const sorted = useSortedItems(
    rows,
    listState.sortKey as SortKey,
    listState.sortDir,
    (row, key) => {
      if (key === 'name') return String(row.name ?? '').toLowerCase();
      if (key === 'article') return String(row.article ?? '').toLowerCase();
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const selection = useListSelection(sorted.map((row) => row.id));
  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const contextColumns = useMemo(
    () => [
      { title: 'Название', value: (row: Row) => row.name || '(без названия)' },
      { title: 'Артикул', value: (row: Row) => row.article || '—' },
      { title: 'Обновлено', value: (row: Row) => (row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—') },
    ],
    [],
  );

  function printRows(items: Row[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные детали (${items.length})` : `Деталь: ${items[0]?.name || '(без названия)'}`,
      sectionTitle: 'Список деталей',
      rows: items,
      columns: contextColumns,
    });
  }

  async function copyRows(items: Row[]) {
    await copyRowsToClipboard(items, contextColumns);
    setStatus(buildCopyRowsStatus(items.length));
  }

  async function deleteRows(ids: string[]) {
    if (!props.canDelete || ids.length === 0) return;
    const message = buildDeleteConfirmMessage({
      selectedCount: ids.length,
      selectedManyLabel: 'выделенные детали',
      singleLabel: 'деталь',
    });
    if (!confirm(message)) return;
    let failed = 0;
    for (const id of ids) {
      const r = await window.matrica.parts.delete(id);
      if (!r.ok) failed += 1;
    }
    setStatus(
      buildDeleteRowsStatus({
        failedCount: failed,
        deletedCount: ids.length,
        deletedManyLabel: 'деталей',
      }),
    );
    invalidateListAllPartsCache();
    selection.clearSelection();
    await refresh();
  }

  async function createPartFromTemplate(templateId: string) {
    const cleanTemplateId = String(templateId || '').trim();
    if (!cleanTemplateId) return;
    try {
      setStatus('Создание детали...');
      const r = await window.matrica.parts.createFromTemplate({ templateId: cleanTemplateId });
      if (!r.ok || !r.part?.id) {
        setStatus(`Ошибка: ${r.error ?? 'Не удалось создать деталь'}`);
        return;
      }
      invalidateListAllPartsCache();
      await refresh({ silent: true });
      setCreateTemplateId(null);
      setCreatePanelOpen(false);
      setStatus('');
      await props.onOpen(r.part.id);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function createTemplateAndPart(label: string) {
    const name = label.trim();
    if (!name) return null;
    try {
      setStatus('Создание шаблона детали...');
      const createdTemplate = await window.matrica.parts.templates.create({ attributes: { name } });
      if (!createdTemplate.ok || !createdTemplate.template?.id) {
        setStatus(`Ошибка: ${createdTemplate.error ?? 'Не удалось создать шаблон детали'}`);
        return null;
      }
      const nextTemplate = { id: String(createdTemplate.template.id), label: name };
      setTemplateOptions((prev) => {
        if (prev.some((item) => item.id === nextTemplate.id)) return prev;
        return [...prev, nextTemplate].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      });
      await createPartFromTemplate(nextTemplate.id);
      return nextTemplate.id;
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
      return null;
    }
  }

  const tableHeader = (
    <thead>
      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('name')}>
          Название {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'name')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('article')}>
          Артикул {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'article')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
          Обновлено {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'updatedAt')}
        </th>
        {showPreviews && (
          <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontSize: 14, color: '#374151', width: 220 }}>Превью</th>
        )}
      </tr>
    </thead>
  );

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={showPreviews ? 4 : 3} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет деталей' : 'Не найдено'}
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr
                key={row.id}
                data-list-selected={selection.isSelected(row.id) ? 'true' : undefined}
                style={{
                  borderBottom: '1px solid #f3f4f6',
                  cursor: 'pointer',
                }}
                onContextMenu={(e) => {
                  const result = selection.onRowContextMenu(e, row.id);
                  if (!result.openMenu) return;
                  setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
                }}
                onClick={() => {
                  selection.onRowPrimaryAction(row.id);
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
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.article || '—'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>
                  {row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—'}
                </td>
                {showPreviews && (
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                    <ListRowThumbs files={row.attachmentPreviews ?? []} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
        {props.canCreate && (
          <Button
            onClick={() => setCreatePanelOpen((prev) => !prev)}
          >
            {createPanelOpen ? 'Закрыть создание' : 'Создать деталь из шаблона'}
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным детали…" />
        </div>
        <Button variant="ghost" onClick={() => patchState({ showPreviews: !showPreviews })}>
          {showPreviews ? 'Отключить превью' : 'Включить превью'}
        </Button>
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      {props.canCreate && createPanelOpen ? (
        <div style={{ marginTop: 8, border: '1px solid #e5e7eb', padding: 12 }}>
          <SearchSelectWithCreate
            value={createTemplateId}
            options={templateOptions}
            placeholder="Выберите шаблон детали"
            onChange={(id) => {
              setCreateTemplateId(id);
              if (id) void createPartFromTemplate(id);
            }}
            canCreate
            createLabel="Новый шаблон детали"
            onCreate={createTemplateAndPart}
          />
          <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
            Сначала выбирается шаблон детали. Если подходящего шаблона нет, создайте его здесь и система сразу откроет новую реальную деталь.
          </div>
        </div>
      ) : null}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
      {menu ? (
        <ListContextMenu
          x={menu.x}
          y={menu.y}
          items={buildListContextMenuItems({
            rows: resolveMenuRows(menu.targetIds, rowById),
            bulk: menu.bulk,
            canDelete: props.canDelete,
            getId: (row) => row.id,
            onSelect: selection.toggleSelect,
            onPrint: printRows,
            onCopy: copyRows,
            onDelete: deleteRows,
            onClearSelection: selection.clearSelection,
          })}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

