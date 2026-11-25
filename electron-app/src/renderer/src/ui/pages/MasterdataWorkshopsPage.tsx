import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { WorkshopTemplateDialog } from '../components/WorkshopTemplateDialog.js';
// Кит списков (промт КАРМАНА #67): правила — из общего источника, меню — из объявления действий.
import { useListSelection } from '../hooks/useListSelection.js';
import { useListBehaviorSettings } from '../hooks/useListBehaviorSettings.js';
import { ListLassoLayer } from '../components/ListLassoLayer.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import {
  buildCopyRowsStatus,
  buildListContextMenuItems,
  copyRowsToClipboard,
  isListEditingTarget,
  listCopyAction,
  listDeleteAction,
  listPrintAction,
  printRowsPreview,
  resolveMenuRows,
  type ListContextColumn,
} from '../utils/listContextActions.js';

type WorkshopRow = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  displayOrder: number;
  deprecatedAt: number | null;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
};

type DraftRow = Pick<WorkshopRow, 'id' | 'code' | 'name' | 'isActive' | 'displayOrder'>;

export function MasterdataWorkshopsPage(props: { canManage: boolean; canEditRepairTemplates: boolean }) {
  const [rows, setRows] = useState<WorkshopRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [status, setStatus] = useState<string>('');
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [templateDialog, setTemplateDialog] = useState<{ workshopId: string; workshopName: string } | null>(null);

  const refresh = useCallback(async () => {
    setStatus('Загрузка...');
    try {
      const res = await window.matrica.workshops.list();
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setRows(res.rows);
      setDrafts({});
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code, 'ru')),
    [rows],
  );

  // Кит списка: выделение, контур и меню — по общим правилам программы (D-248).
  // Правила поведения берутся из общего источника, а не из настроек страницы.
  const sortedIds = useMemo(() => sorted.map((row) => row.id), [sorted]);
  const selection = useListSelection(sortedIds);
  const listBehavior = useListBehaviorSettings();
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  /** Строки для печати/копирования — с учётом несохранённой правки: на экране и в буфере одно и то же. */
  const rowById = useMemo(() => {
    const map = new Map<string, WorkshopRow>();
    for (const row of rows) {
      const draft = drafts[row.id];
      map.set(
        row.id,
        draft
          ? { ...row, code: draft.code, name: draft.name, isActive: draft.isActive, displayOrder: draft.displayOrder }
          : row,
      );
    }
    return map;
  }, [rows, drafts]);

  const contextColumns = useMemo<ListContextColumn<WorkshopRow>[]>(
    () => [
      { title: 'Код', value: (row) => row.code },
      { title: 'Название', value: (row) => row.name },
      { title: 'Активен', value: (row) => (row.isActive ? 'да' : 'нет') },
      { title: 'Порядок', value: (row) => String(row.displayOrder) },
      { title: 'warehouseId', value: (row) => `workshop_${row.code.trim()}` },
    ],
    [],
  );

  function printRows(items: WorkshopRow[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные цеха (${items.length})` : `Цех: ${items[0]?.name || '(без названия)'}`,
      sectionTitle: 'Справочник цехов',
      rows: items,
      columns: contextColumns,
    });
  }

  async function copyRows(items: WorkshopRow[]) {
    await copyRowsToClipboard(items, contextColumns);
    setStatus(buildCopyRowsStatus(items.length));
  }

  function patchDraft(id: string, patch: Partial<DraftRow>) {
    const base = rows.find((r) => r.id === id);
    if (!base) return;
    setDrafts((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] ?? { id: base.id, code: base.code, name: base.name, isActive: base.isActive, displayOrder: base.displayOrder }),
        ...patch,
      },
    }));
  }

  function getRow(id: string): DraftRow {
    const draft = drafts[id];
    if (draft) return draft;
    const base = rows.find((r) => r.id === id)!;
    return { id: base.id, code: base.code, name: base.name, isActive: base.isActive, displayOrder: base.displayOrder };
  }

  async function saveRow(id: string) {
    if (!props.canManage) return;
    const draft = drafts[id];
    if (!draft) return;
    setStatus('Сохраняю...');
    try {
      const res = await window.matrica.workshops.upsert({
        id: draft.id,
        code: draft.code.trim(),
        name: draft.name.trim(),
        isActive: draft.isActive,
        displayOrder: draft.displayOrder,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refresh();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  /**
   * Удаление цехов — и кнопкой в строке, и пунктом меню кита (одно действие, два входа).
   * Пачкой спрашиваем подтверждение один раз: оператор удаляет выделенное и ждёт один ответ.
   */
  async function removeRows(ids: string[]) {
    if (!props.canManage || ids.length === 0) return;
    const question =
      ids.length > 1
        ? `Удалить цеха (${ids.length})? (soft-delete; записи скроются из списка)`
        : 'Удалить цех? (soft-delete; запись скроется из списка)';
    if (!confirm(question)) return;
    setStatus('Удаляю...');
    let failed = 0;
    let lastError = '';
    for (const id of ids) {
      try {
        const res = await window.matrica.workshops.delete(id);
        if (!res.ok) {
          failed += 1;
          lastError = res.error;
        }
      } catch (e) {
        failed += 1;
        lastError = String(e);
      }
    }
    await refresh();
    setStatus(failed > 0 ? `Ошибка: не удалось удалить строк: ${failed}${lastError ? ` (${lastError})` : ''}` : '');
  }

  async function deleteRow(id: string) {
    await removeRows([id]);
  }

  async function createNew() {
    if (!props.canManage) return;
    const code = newCode.trim();
    const name = newName.trim();
    if (!code || !name) {
      setStatus('Заполните «Код» и «Название»');
      return;
    }
    setStatus('Создаю...');
    try {
      const maxOrder = rows.reduce((acc, r) => Math.max(acc, r.displayOrder), 0);
      const res = await window.matrica.workshops.upsert({
        code,
        name,
        isActive: true,
        displayOrder: maxOrder + 10,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setNewCode('');
      setNewName('');
      await refresh();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!props.canManage) {
    return <div style={{ color: 'var(--subtle)' }}>Недостаточно прав для управления цехами (нужно workshops.manage).</div>;
  }

  return (
    <div data-list-root="true" style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Справочник цехов</h2>
        <Button variant="ghost" onClick={() => void refresh()}>Обновить</Button>
        <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
          Используется в нарядах (workshopId), документах склада (workshop_id), warehouseId формата workshop_&lt;code&gt;.
        </span>
      </div>

      {status ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 8, border: '1px solid var(--border)', borderRadius: 4 }}>
        <strong style={{ minWidth: 110 }}>Создать цех:</strong>
        <Input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="Код (например, 8)" style={{ width: 140 }} />
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Название (например, Цех №8)" style={{ flex: 1 }} />
        <Button onClick={() => void createNew()}>Создать</Button>
      </div>

      <ListCount total={sorted.length} shown={sorted.length} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <RowNumberHeaderCell />
              <th style={{ width: 80 }}>Код</th>
              <th data-col-kind="name">Название</th>
              <th data-col-kind="flag" title="Активен" style={{ width: 80, textAlign: 'center' }}>Активен</th>
              <th data-col-kind="num" title="Порядок" style={{ width: 110, textAlign: 'right' }}>Порядок</th>
              <th style={{ width: 140 }}>warehouseId</th>
              <th style={{ width: 130 }}>Шаблон ремонта</th>
              <th style={{ width: 220 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  Цехов нет. Создайте первый сверху.
                </td>
              </tr>
            ) : (
              sorted.map((base, i) => {
                const draft = getRow(base.id);
                const dirty = drafts[base.id] !== undefined;
                return (
                  <tr
                    key={base.id}
                    data-list-selected={selection.isSelected(base.id) ? 'true' : undefined}
                    // Маркер строки для выделения контуром (Ctrl + рамка) — правило одно на программу.
                    data-list-row="true"
                    data-list-row-key={base.id}
                    onContextMenu={(e) => {
                      // Правый клик по полю ввода — нативное меню оператора (вставить из буфера), не меню списка.
                      if (isListEditingTarget(e.target)) return;
                      const result = selection.onRowContextMenu(e, base.id);
                      if (!result.openMenu) return;
                      setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
                    }}
                    onClick={() => selection.onRowPrimaryAction(base.id)}
                  >
                    <RowNumberCell n={i + 1} />
                    <td>
                      <Input
                        value={draft.code}
                        onChange={(e) => patchDraft(base.id, { code: e.target.value })}
                        style={{ width: 70 }}
                      />
                    </td>
                    <td data-col-kind="name">
                      <Input
                        value={draft.name}
                        onChange={(e) => patchDraft(base.id, { name: e.target.value })}
                        style={{ width: '100%' }}
                      />
                    </td>
                    <td data-col-kind="flag" style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={draft.isActive}
                        onChange={(e) => patchDraft(base.id, { isActive: e.target.checked })}
                      />
                    </td>
                    <td data-col-kind="num" style={{ textAlign: 'right' }}>
                      <Input
                        type="number"
                        value={String(draft.displayOrder)}
                        onChange={(e) => patchDraft(base.id, { displayOrder: Number(e.target.value) || 0 })}
                        style={{ width: 100 }}
                      />
                    </td>
                    <td>
                      <code style={{ fontSize: 12 }}>workshop_{draft.code.trim()}</code>
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() => setTemplateDialog({ workshopId: base.id, workshopName: base.name })}
                        title={
                          props.canEditRepairTemplates
                            ? 'Открыть шаблон ремонта цеха'
                            : 'Просмотр шаблона ремонта (редактирование — только админ)'
                        }
                      >
                        Шаблон
                      </Button>
                    </td>
                    <td>
                      <Button onClick={() => void saveRow(base.id)} disabled={!dirty}>
                        Сохранить
                      </Button>{' '}
                      <Button variant="ghost" onClick={() => void deleteRow(base.id)}>
                        Удалить
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {templateDialog ? (
        <WorkshopTemplateDialog
          open
          workshopId={templateDialog.workshopId}
          workshopName={templateDialog.workshopName}
          canEdit={props.canEditRepairTemplates}
          onClose={() => setTemplateDialog(null)}
        />
      ) : null}

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
            // Список ОБЪЯВЛЯЕТ свои действия (промт КАРМАНА #67): печать, копирование,
            // удаление цеха — и «Сохранить», только когда строка правлена.
            actions: [
              listPrintAction({ available: true, print: printRows }),
              listCopyAction({ available: true, copy: copyRows }),
              listDeleteAction<WorkshopRow>({ available: props.canManage, remove: removeRows, getId: (row) => row.id }),
              {
                id: 'save-workshop',
                label: 'Сохранить',
                available: !menu.bulk && menu.targetIds.some((id) => drafts[id] !== undefined),
                scope: 'single',
                run: (items) => {
                  void saveRow(items[0]!.id);
                },
              },
            ],
          })}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
