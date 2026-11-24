import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SearchModeToggle, searchModeOf } from '../components/SearchModeToggle.js';
import { searchModeEmptyText } from '../components/SearchModeHint.js';
import { useSearchMode } from '../hooks/useSearchMode.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { matchesQueryInRecord } from '../utils/search.js';
import { parseIdArray } from '../utils/groupBrandIds.js';
import { loadAllGroupMembers, reexpandPartsForGroup } from '../utils/liveGroupSync.js';
// Кит списков (промт КАРМАНА #67): правила — из общего источника, меню — из объявления действий.
import { useListSelection } from '../hooks/useListSelection.js';
import { useListBehaviorSettings } from '../hooks/useListBehaviorSettings.js';
import { ListLassoLayer } from '../components/ListLassoLayer.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import {
  buildCopyRowsStatus,
  buildDeleteConfirmMessage,
  buildDeleteRowsStatus,
  buildListContextMenuItems,
  copyRowsToClipboard,
  listCopyAction,
  listDeleteAction,
  listPrintAction,
  printRowsPreview,
  resolveMenuRows,
  type ListContextColumn,
} from '../utils/listContextActions.js';

type GroupRow = { id: string; name: string; description: string; brandCount: number };

export function EngineBrandGroupsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canViewMasterData: boolean;
}) {
  const [entityTypeId, setEntityTypeId] = useState<string | null>(null);
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [query, setQuery] = useState('');
  const { similar: searchSimilar, toggle: toggleSearchSimilar } = useSearchMode({ query });
  const [status, setStatus] = useState('');
  const { confirm } = useConfirm();

  const refresh = useCallback(async () => {
    if (!props.canViewMasterData) return;
    try {
      setStatus('Загрузка...');
      const types = (await window.matrica.admin.entityTypes.list()) as Array<{ id: string; code: string }>;
      const gt = types.find((t) => String(t.code) === 'engine_brand_group');
      if (!gt?.id) {
        setEntityTypeId(null);
        setRows([]);
        setStatus('Тип «Группы марок двигателей» не найден (перезапустите клиент для инициализации).');
        return;
      }
      setEntityTypeId(gt.id);
      const list = (await window.matrica.admin.entities.listByEntityType(gt.id)) as Array<{ id: string; displayName?: string }>;
      // Групп немного (справочник оператора) — грузим детали каждой для описания и числа марок.
      const details = await Promise.all(
        list.map(async (r) => {
          const det = await window.matrica.admin.entities.get(String(r.id), gt.id).catch(() => null);
          const attrs = (det as { attributes?: Record<string, unknown> } | null)?.attributes ?? {};
          return {
            id: String(r.id),
            name: String(attrs.name ?? r.displayName ?? '').trim() || String(r.id),
            description: String(attrs.description ?? '').trim(),
            brandCount: parseIdArray(attrs.engine_brand_ids).length,
          };
        }),
      );
      setRows(details);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.canViewMasterData]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useLiveDataRefresh(refresh, { enabled: props.canViewMasterData, intervalMs: 20000, domains: ['directories'] });

  const searchMode = searchModeOf(searchSimilar);
  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        matchesQueryInRecord(query, { name: r.name, description: r.description, id: r.id }, undefined, searchMode),
      ),
    [rows, query, searchMode],
  );
  const sorted = useMemo(() => [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'ru')), [filtered]);

  // Кит списка: выделение, контур и меню — по общим правилам программы (D-248).
  // Правила поведения берутся из общего источника, а не из настроек страницы.
  const sortedIds = useMemo(() => sorted.map((row) => row.id), [sorted]);
  const selection = useListSelection(sortedIds);
  const listBehavior = useListBehaviorSettings();
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const contextColumns = useMemo<ListContextColumn<GroupRow>[]>(
    () => [
      { title: 'Название группы', value: (row) => row.name },
      { title: 'Марок', value: (row) => String(row.brandCount) },
      { title: 'Описание', value: (row) => row.description || '—' },
    ],
    [],
  );

  function printRows(items: GroupRow[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные группы (${items.length})` : `Группа: ${items[0]?.name || '(без названия)'}`,
      sectionTitle: 'Список групп марок',
      rows: items,
      columns: contextColumns,
    });
  }

  async function copyRows(items: GroupRow[]) {
    await copyRowsToClipboard(items, contextColumns);
    setStatus(buildCopyRowsStatus(items.length));
  }

  /** Удаление групп из пачки — тем же путём, что и кнопка «✕» в строке. */
  async function deleteRows(ids: string[]) {
    if (!props.canCreate || ids.length === 0) return;
    const message = buildDeleteConfirmMessage({
      selectedCount: ids.length,
      selectedManyLabel: 'выделенные группы',
      singleLabel: 'группу',
    });
    const ok = await confirm({
      title: ids.length > 1 ? 'Удалить группы марок?' : 'Удалить группу марок?',
      detail: `${message}\n\nУ деталей с живой привязкой к группам связи будут сняты; связи, добавленные вручную, останутся.`,
      confirmLabel: 'Удалить',
      confirmTone: 'danger',
    });
    if (!ok) return;
    let failed = 0;
    for (const id of ids) {
      const r = await window.matrica.admin.entities.softDelete(id).catch(() => null);
      if (!r?.ok) {
        failed += 1;
        continue;
      }
      // Симметрия: снять живые связи удалённой группы у деталей.
      try {
        const gm = await loadAllGroupMembers();
        await reexpandPartsForGroup(id, gm);
      } catch {
        /* self-heal починит при следующем открытии детали */
      }
    }
    setStatus(
      buildDeleteRowsStatus({
        failedCount: failed,
        deletedCount: ids.length - failed,
        deletedManyLabel: 'групп',
        deletedSingleLabel: 'Группа удалена',
      }),
    );
    selection.clearSelection();
    await refresh();
  }

  async function addGroup() {
    if (!props.canCreate || !entityTypeId) return;
    setStatus('');
    // Deferred-create: пустая карточка на клиентском id; строка материализуется при первом сохранении.
    await props.onOpen(crypto.randomUUID()).catch((e) => setStatus(`Ошибка: ${String(e)}`));
  }

  async function removeGroup(row: GroupRow) {
    const ok = await confirm({
      title: 'Удалить группу марок?',
      detail: `Группа «${row.name}» будет удалена. У деталей с живой привязкой к ней связи, добавленные этой группой, будут сняты; связи, добавленные вручную, останутся.`,
      confirmLabel: 'Удалить',
      confirmTone: 'danger',
    });
    if (!ok) return;
    const r = await window.matrica.admin.entities.softDelete(row.id);
    if (r?.ok) {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
      // Симметрия: снять живые связи удалённой группы у деталей (membership без неё —
      // recompute уберёт её anchor+derived). Best-effort.
      try {
        const gm = await loadAllGroupMembers();
        await reexpandPartsForGroup(row.id, gm);
      } catch {
        /* self-heal починит при следующем открытии детали */
      }
    } else {
      setStatus(`Ошибка удаления: ${String((r as { error?: string })?.error ?? 'unknown')}`);
    }
  }

  if (!props.canViewMasterData) {
    return <div style={{ color: 'var(--subtle)' }}>Недостаточно прав для просмотра групп марок.</div>;
  }

  return (
    <div data-list-root="true" style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate ? (
          <Button onClick={() => void addGroup()} disabled={!entityTypeId}>
            Создать группу
          </Button>
        ) : null}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию или описанию..." />
        </div>
        <SearchModeToggle similar={searchSimilar} onToggle={toggleSearchSimilar} />
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
        Группа — удобный список марок двигателей. Используется, чтобы разом привязать деталь ко всем маркам группы (в карточке
        детали → «Применяемость»). Марка может входить в несколько групп.
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <ListCount total={rows.length} shown={sorted.length} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid #e5e7eb', overflowX: 'clip' }}>
        <table className="list-table">
          <thead>
            <tr>
              <RowNumberHeaderCell />
              <th data-col-kind="name" style={{ textAlign: 'left' }}>Название группы</th>
              <th data-col-kind="num" style={{ textAlign: 'right', width: 90 }} title="Сколько марок в группе">Марок</th>
              <th data-col-kind="text" style={{ textAlign: 'left' }}>Описание</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr
                key={row.id}
                data-list-selected={selection.isSelected(row.id) ? 'true' : undefined}
                // Маркер строки для выделения контуром (Ctrl + рамка) — правило одно на программу.
                data-list-row="true"
                data-list-row-key={row.id}
                style={{ cursor: 'pointer' }}
                onContextMenu={(e) => {
                  const result = selection.onRowContextMenu(e, row.id);
                  if (!result.openMenu) return;
                  setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
                }}
                onClick={() => {
                  selection.onRowPrimaryAction(row.id);
                  void props.onOpen(row.id);
                }}
              >
                <RowNumberCell n={i + 1} />
                <td data-col-kind="name">{row.name}</td>
                <td data-col-kind="num" style={{ textAlign: 'right' }}>{row.brandCount}</td>
                <td data-col-kind="text">{row.description || <span style={{ color: 'var(--subtle)' }}>—</span>}</td>
                <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                  {props.canCreate ? (
                    <Button variant="ghost" size="sm" tone="danger" onClick={() => void removeGroup(row)} title="Удалить группу">
                      ✕
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={5}>
                  {query.trim() ? searchModeEmptyText(searchSimilar, query) : 'Групп марок пока нет. Нажмите «Создать группу».'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Выделение контуром (Ctrl + рамка) — слой кита, включается общей настройкой. */}
      <ListLassoLayer enabled={listBehavior.lasso} onSelect={selection.selectMany} />
      {menu ? (
        <ListContextMenu
          x={menu.x}
          y={menu.y}
          items={buildListContextMenuItems({
            rows: resolveMenuRows(menu.targetIds, rowById),
            bulk: menu.bulk,
            getId: (row) => row.id,
            onSelect: selection.toggleSelect,
            onClearSelection: selection.clearSelection,
            hasSelection: selection.selectedCount > 0,
            // Список ОБЪЯВЛЯЕТ свои действия (промт КАРМАНА #67): «Удалить» есть только
            // там, где список умеет удалять и есть право.
            actions: [
              listPrintAction({ available: true, print: printRows }),
              listCopyAction({ available: true, copy: copyRows }),
              listDeleteAction<GroupRow>({ available: props.canCreate, remove: deleteRows, getId: (row) => row.id }),
            ],
          })}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
