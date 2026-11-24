import React, { useEffect, useState } from 'react';

import type { TimesheetHeader } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
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

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

type WorkshopOpt = { id: string; name: string };

export function TimesheetsPage(props: { canCreate: boolean; canEdit: boolean; onOpen: (id: string) => void }) {
  const { confirm } = useConfirm();
  const now = new Date();
  const [workshops, setWorkshops] = useState<WorkshopOpt[]>([]);
  const [departments, setDepartments] = useState<WorkshopOpt[]>([]);
  const [rows, setRows] = useState<TimesheetHeader[]>([]);
  // Область табеля закодирована как "w:<id>" (цех) или "d:<id>" (подразделение).
  const [scopeKey, setScopeKey] = useState('');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [weekMode, setWeekMode] = useState<5 | 6>(6);
  const [busy, setBusy] = useState('');
  // Кит списка: выделение, контур и меню — по общим правилам программы (D-248).
  const selection = useListSelection(rows.map((r) => r.id));
  const listBehavior = useListBehaviorSettings();
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const menuRows = menu ? resolveMenuRows(menu.targetIds, rowById) : [];

  const contextColumns: ListContextColumn<TimesheetHeader>[] = [
    { title: 'Цех / подразделение', value: (r) => r.scopeName || r.workshopName || '—' },
    { title: 'Период', value: (r) => `${MONTHS[r.month - 1] ?? r.month} ${r.year}` },
    { title: 'Режим', value: (r) => `${r.weekMode}-дн.` },
    { title: 'Норма, ч', value: (r) => String(r.normHours ?? '—') },
    { title: 'Статус', value: (r) => (r.status === 'closed' ? 'Закрыт' : 'Черновик') },
    { title: 'Автор', value: (r) => r.createdBy || '—' },
  ];

  function printRows(items: TimesheetHeader[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные табели (${items.length})` : `Табель: ${items[0]?.scopeName || items[0]?.workshopName || '(без названия)'}`,
      sectionTitle: 'Список табелей',
      rows: items,
      columns: contextColumns,
    });
  }

  async function copyRows(items: TimesheetHeader[]) {
    await copyRowsToClipboard(items, contextColumns);
    setBusy(buildCopyRowsStatus(items.length));
    setTimeout(() => setBusy(''), 2000);
  }

  /** Удаление табелей из пачки — теми же правами, что и кнопка «Удалить» в строке. */
  async function deleteRows(ids: string[]) {
    if (!props.canEdit || ids.length === 0) return;
    const deletable = ids.filter((id) => {
      const row = rowById.get(id);
      return Boolean(row && (row.isAuthor || !row.createdBy));
    });
    if (deletable.length === 0) {
      setBusy('Удалять чужие табели нельзя');
      setTimeout(() => setBusy(''), 3000);
      return;
    }
    const message = buildDeleteConfirmMessage({
      selectedCount: deletable.length,
      selectedManyLabel: 'выделенные табели',
      singleLabel: 'табель',
    });
    const ok = await confirm({ detail: `${message}\n\nДействие необратимо.` });
    if (!ok) return;
    let failed = 0;
    for (const id of deletable) {
      const r = await window.matrica.timesheets.delete(id);
      if (!r.ok) failed += 1;
    }
    setBusy(
      buildDeleteRowsStatus({
        failedCount: failed,
        deletedCount: deletable.length - failed,
        deletedManyLabel: 'табелей',
        deletedSingleLabel: 'Табель удалён',
      }),
    );
    setTimeout(() => setBusy(''), 3000);
    selection.clearSelection();
    void load();
  }

  async function load() {
    const [w, d, t] = await Promise.all([
      window.matrica.workshops.list({ activeOnly: true }),
      window.matrica.timesheets.departments(),
      window.matrica.timesheets.list(),
    ]);
    const wOpts: WorkshopOpt[] = w.ok ? w.rows.map((r) => ({ id: r.id, name: r.name })) : [];
    const dOpts: WorkshopOpt[] = d?.ok ? (d.rows as WorkshopOpt[]).map((r) => ({ id: String(r.id), name: String(r.name) })) : [];
    setWorkshops(wOpts);
    setDepartments(dOpts);
    setScopeKey((prev) => prev || (wOpts[0] ? `w:${wOpts[0].id}` : dOpts[0] ? `d:${dOpts[0].id}` : ''));
    if (t.ok) setRows(t.rows);
  }
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    if (!scopeKey) {
      setBusy('Выберите цех или подразделение');
      setTimeout(() => setBusy(''), 2000);
      return;
    }
    setBusy('Создание…');
    const scope = scopeKey.startsWith('d:') ? { departmentId: scopeKey.slice(2) } : { workshopId: scopeKey.slice(2) };
    const r = await window.matrica.timesheets.create({ ...scope, year, month, weekMode });
    if (!r.ok) {
      setBusy(`Ошибка: ${r.error}`);
      setTimeout(() => setBusy(''), 3500);
      return;
    }
    setBusy('');
    props.onOpen(r.id);
  }

  async function remove(id: string, label: string) {
    const ok = await confirm({ detail: `Удалить табель «${label}»? Действие необратимо.` });
    if (!ok) return;
    const r = await window.matrica.timesheets.delete(id);
    if (!r.ok) {
      setBusy(`Ошибка: ${r.error}`);
      setTimeout(() => setBusy(''), 3000);
      return;
    }
    void load();
  }

  return (
    <div data-list-root="true" style={{ padding: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Табель учёта рабочего времени</h2>
        {busy && <span style={{ color: busy.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 13 }}>{busy}</span>}
      </div>

      {/* Завести табель может каждый, кто работает в программе (владелец 13.11.2026). */}
      {props.canCreate && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10, padding: 12, border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: 14, background: '#f8fafc' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#64748b' }}>
            Цех / подразделение
            <select value={scopeKey} onChange={(e) => setScopeKey(e.target.value)} style={selStyle}>
              {workshops.length === 0 && departments.length === 0 && <option value="">— нет цехов и подразделений —</option>}
              {workshops.length > 0 && (
                <optgroup label="Цеха">
                  {workshops.map((w) => (
                    <option key={`w:${w.id}`} value={`w:${w.id}`}>{w.name}</option>
                  ))}
                </optgroup>
              )}
              {departments.length > 0 && (
                <optgroup label="Подразделения">
                  {departments.map((d) => (
                    <option key={`d:${d.id}`} value={`d:${d.id}`}>{d.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#64748b' }}>
            Месяц
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={selStyle}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#64748b' }}>
            Год
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ ...selStyle, width: 90 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#64748b' }}>
            Режим недели
            <select value={weekMode} onChange={(e) => setWeekMode(Number(e.target.value) === 5 ? 5 : 6)} style={selStyle}>
              <option value={6}>6-дневка (вс — выходной)</option>
              <option value={5}>5-дневка (сб, вс — выходные)</option>
            </select>
          </label>
          <Button variant="primary" onClick={() => void create()}>Создать табель</Button>
        </div>
      )}

      <ListCount total={rows.length} shown={rows.length} />
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'clip' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 120%)', color: '#fff' }}>
              <RowNumberHeaderCell style={{ ...thStyle, ...ROWNUM_STYLE, color: 'inherit' }} />
              <th style={thStyle}>Цех / подразделение</th>
              <th style={thStyle}>Период</th>
              <th style={thStyle}>Режим</th>
              <th style={thStyle}>Норма, ч</th>
              <th style={thStyle}>Статус</th>
              <th style={thStyle}>Автор</th>
              <th style={{ ...thStyle, width: 200 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const period = `${MONTHS[r.month - 1] ?? r.month} ${r.year}`;
              return (
                <tr
                  key={r.id}
                  data-list-selected={selection.isSelected(r.id) ? 'true' : undefined}
                  // Маркер строки для выделения контуром (Ctrl + рамка) — правило одно на программу.
                  data-list-row="true"
                  data-list-row-key={r.id}
                  style={{ cursor: 'pointer' }}
                  onContextMenu={(e) => {
                    const result = selection.onRowContextMenu(e, r.id);
                    if (!result.openMenu) return;
                    setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
                  }}
                  onClick={() => {
                    selection.onRowPrimaryAction(r.id);
                    props.onOpen(r.id);
                  }}
                >
                  <RowNumberCell n={i + 1} style={{ ...tdStyle, ...ROWNUM_STYLE }} />
                  <td style={tdStyle}>{r.scopeName || r.workshopName}</td>
                  <td style={tdStyle}>{period}</td>
                  <td style={tdStyle}>{r.weekMode}-дн.</td>
                  <td style={tdStyle}>{r.normHours ?? '—'}</td>
                  <td style={tdStyle}>{r.status === 'closed' ? 'Закрыт' : 'Черновик'}</td>
                  <td style={tdStyle}>
                    {r.createdBy ? r.createdBy : '—'}
                    {r.isAuthor ? ' (мой)' : ''}
                  </td>
                  <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button variant="ghost" onClick={() => props.onOpen(r.id)}>Открыть</Button>
                      {/* Удалить может только автор (владелец 13.11.2026: «удалять чужие нельзя»). */}
                      {props.canEdit && (r.isAuthor || !r.createdBy) && (
                        <Button variant="ghost" onClick={() => void remove(r.id, `${r.scopeName || r.workshopName} · ${period}`)}>Удалить</Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 14, color: '#6b7280' }}>
                  Табелей пока нет. {props.canCreate ? 'Выберите цех и месяц, затем «Создать табель».' : ''}
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
            rows: menuRows,
            bulk: menu.bulk,
            getId: (row) => row.id,
            onSelect: selection.toggleSelect,
            onClearSelection: selection.clearSelection,
            hasSelection: selection.selectedCount > 0,
            // Список ОБЪЯВЛЯЕТ свои действия (промт КАРМАНА #67): «Удалить» появляется
            // только когда выбранные табели удалить можно (свои — да, чужие — нет).
            actions: [
              listPrintAction({ available: true, print: printRows }),
              listCopyAction({ available: true, copy: copyRows }),
              listDeleteAction<TimesheetHeader>({
                available: props.canEdit && menuRows.every((r) => r.isAuthor || !r.createdBy),
                remove: deleteRows,
                getId: (row) => row.id,
              }),
            ],
          })}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

const selStyle: React.CSSProperties = { height: 32, padding: '4px 8px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#0b1220' };
const thStyle: React.CSSProperties = { textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' };
const tdStyle: React.CSSProperties = { padding: 10, borderBottom: '1px solid #f3f4f6', fontSize: 14 };
const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };
