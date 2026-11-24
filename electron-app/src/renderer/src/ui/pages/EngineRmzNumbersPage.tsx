import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { EngineRmzHistoryItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
// Кит списков (промт КАРМАНА #67): правила — из общего источника, меню — из объявления действий.
import { useListSelection } from '../hooks/useListSelection.js';
import { useListBehaviorSettings } from '../hooks/useListBehaviorSettings.js';
import { ListLassoLayer } from '../components/ListLassoLayer.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import {
  buildCopyRowsStatus,
  buildListContextMenuItems,
  copyRowsToClipboard,
  listCopyAction,
  listPrintAction,
  printRowsPreview,
  resolveMenuRows,
  type ListActionDeclaration,
  type ListContextColumn,
} from '../utils/listContextActions.js';

/**
 * Реестр «Номера РМЗ» (план engine-rmz-numbers-2026-10, PR-4).
 *
 * Зачем отдельный экран. Номер карточки не переиспользуется никогда, а строки реестра
 * не удаляются: после удаления карточки остаётся строка со статусом «Удалена», кто и
 * когда её удалил, причина и снимок того, что в ней было. Список двигателей на вопрос
 * «куда делась карточка `RMZ451`» не отвечает — её там уже нет, а журнал действий не
 * знает номера. Это единственное место, где обе половины сходятся.
 */

type Step = 'active' | 'deleted' | 'all';

const STEP_LABELS: Record<Step, string> = {
  active: 'Активные',
  deleted: 'Удалённые',
  all: 'Все',
};

const STATUS_LABELS: Record<EngineRmzHistoryItem['status'], string> = {
  active: 'Активна',
  deleted: 'Удалена',
  merged: 'Слита',
};

const STATUS_TONES: Record<EngineRmzHistoryItem['status'], { background: string; color: string; border: string }> = {
  active: { background: '#ecfdf5', color: '#047857', border: '#a7f3d0' },
  deleted: { background: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
  merged: { background: '#f1f5f9', color: '#475569', border: '#e2e8f0' },
};

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
});
const TIME_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
});

function fmtDay(ms: number | null): string {
  return ms && Number.isFinite(ms) ? DATE_FMT.format(new Date(ms)) : '—';
}

function fmtMoment(ms: number | null): string {
  return ms && Number.isFinite(ms) ? TIME_FMT.format(new Date(ms)) : '—';
}

function matches(item: EngineRmzHistoryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    item.rmzCode,
    item.engineNumber,
    item.internalNumber,
    item.engineBrand,
    item.createdBy,
    item.cardDeletedBy,
    item.deleteReason,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

export function EngineRmzNumbersPage(props: { onOpenEngine?: (engineId: string) => void }): React.JSX.Element {
  const [rows, setRows] = useState<EngineRmzHistoryItem[]>([]);
  const [step, setStep] = useState<Step>('active');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string>('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus('Загрузка…');
      const list = await window.matrica.engines.rmzNumbers();
      setRows(Array.isArray(list) ? list : []);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      active: rows.filter((r) => r.status === 'active').length,
      deleted: rows.filter((r) => r.status !== 'active').length,
      all: rows.length,
    }),
    [rows],
  );

  const visible = useMemo(() => {
    const byStep = rows.filter((r) => (step === 'all' ? true : step === 'active' ? r.status === 'active' : r.status !== 'active'));
    return byStep.filter((r) => matches(r, query));
  }, [rows, step, query]);

  const emptyText =
    rows.length === 0
      ? 'Номеров пока нет: сервер присваивает их карточкам сам, первый же синк привезёт их сюда.'
      : step === 'deleted' && counts.deleted === 0
        ? 'Удалённых карточек нет — все выданные номера принадлежат живым карточкам.'
        : 'Ничего не найдено по этому запросу.';

  // Кит списка: выделение, контур и меню — по общим правилам программы (D-248).
  const selection = useListSelection(visible.map((r) => r.engineId));
  const listBehavior = useListBehaviorSettings();
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.engineId, r])), [rows]);
  const menuRows = menu ? resolveMenuRows(menu.targetIds, rowById) : [];

  const contextColumns = useMemo<ListContextColumn<EngineRmzHistoryItem>[]>(
    () => [
      { title: 'РМЗ', value: (r) => r.rmzCode },
      { title: 'Номер', value: (r) => r.engineNumber || '—' },
      { title: 'Внутр. №', value: (r) => r.internalNumber || '—' },
      { title: 'Марка', value: (r) => r.engineBrand || '—' },
      { title: 'Состояние', value: (r) => STATUS_LABELS[r.status] },
      { title: 'Кто создал', value: (r) => r.createdBy || '—' },
      { title: 'Когда удалил', value: (r) => r.cardDeletedBy || '—' },
      { title: 'Причина', value: (r) => r.deleteReason || '—' },
    ],
    [],
  );

  function printRows(items: EngineRmzHistoryItem[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные номера (${items.length})` : `Номер: ${items[0]?.rmzCode ?? '(без номера)'}`,
      sectionTitle: 'Реестр номеров РМЗ',
      rows: items,
      columns: contextColumns,
    });
  }

  async function copyRows(items: EngineRmzHistoryItem[]) {
    await copyRowsToClipboard(items, contextColumns);
    setStatus(buildCopyRowsStatus(items.length));
  }

  /**
   * «Открыть карточку» — действие самого списка: у живой карточки номер есть и карточку
   * открыть можно, у удалённой — нельзя, и пункта в меню тогда НЕТ ВООБЩЕ (промт #67).
   */
  const openEngineAction: ListActionDeclaration<EngineRmzHistoryItem> = {
    id: 'open-engine',
    label: 'Открыть карточку двигателя',
    available: menuRows.length > 0 && menuRows.every((r) => r.status === 'active'),
    scope: 'single',
    run: (items) => {
      const engineId = items[0]?.engineId;
      if (engineId) props.onOpenEngine?.(engineId);
    },
  };

  return (
    <div data-list-root="true" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <div>
        <h2 style={{ margin: '0 0 4px' }}>🔢 Номера РМЗ</h2>
        <div style={{ fontSize: 13, color: '#64748b' }}>
          Сквозные программные номера карточек двигателей. Номер присваивается созданию карточки и не
          переиспользуется никогда: после удаления строка остаётся здесь — с причиной, автором и тем, что было в карточке.
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {(Object.keys(STEP_LABELS) as Step[]).map((id) => (
            <Button
              key={id}
              variant={step === id ? 'primary' : 'ghost'}
              onClick={() => {
                setStep(id);
                setExpanded('');
              }}
            >
              {STEP_LABELS[id]} ({counts[id]})
            </Button>
          ))}
        </div>
        <div style={{ minWidth: 280, flex: '0 1 360px' }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск: номер РМЗ, документный, внутренний, марка, кто удалил…"
          />
        </div>
        <Button variant="ghost" onClick={() => void load()}>
          Обновить
        </Button>
        {status && (
          <span style={{ fontSize: 13, color: status.startsWith('Ошибка') ? '#dc2626' : '#64748b' }}>{status}</span>
        )}
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <thead style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 1 }}>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>
              <th style={{ padding: '8px 10px' }}>РМЗ</th>
              <th style={{ padding: '8px 10px' }}>Номер</th>
              <th style={{ padding: '8px 10px' }}>Внутр. №</th>
              <th style={{ padding: '8px 10px' }}>Марка</th>
              <th style={{ padding: '8px 10px' }}>Состояние</th>
              <th style={{ padding: '8px 10px' }}>Кто создал</th>
              <th style={{ padding: '8px 10px' }}>Когда</th>
              <th style={{ padding: '8px 10px' }}>Кто удалил</th>
              <th style={{ padding: '8px 10px' }}>Когда</th>
              <th style={{ padding: '8px 10px' }}>Причина</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const isOpen = expanded === row.engineId;
              const canExpand = row.status !== 'active' && row.snapshot.length > 0;
              return (
                <React.Fragment key={row.engineId}>
                  <tr
                    data-list-selected={selection.isSelected(row.engineId) ? 'true' : undefined}
                    // Маркер строки для выделения контуром (Ctrl + рамка) — правило одно на программу.
                    data-list-row="true"
                    data-list-row-key={row.engineId}
                    onContextMenu={(e) => {
                      const result = selection.onRowContextMenu(e, row.engineId);
                      if (!result.openMenu) return;
                      setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
                    }}
                    onClick={() => {
                      selection.onRowPrimaryAction(row.engineId);
                      if (canExpand) setExpanded(isOpen ? '' : row.engineId);
                      else if (row.status === 'active') props.onOpenEngine?.(row.engineId);
                    }}
                    title={
                      canExpand
                        ? 'Показать, что было в карточке'
                        : row.status === 'active'
                          ? 'Открыть карточку двигателя'
                          : undefined
                    }
                    style={{
                      borderBottom: '1px solid #f1f5f9',
                      cursor: canExpand || row.status === 'active' ? 'pointer' : 'default',
                      background: isOpen ? '#f8fafc' : undefined,
                    }}
                  >
                    <td style={{ padding: '8px 10px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{row.rmzCode}</td>
                    <td style={{ padding: '8px 10px' }}>{row.engineNumber || '—'}</td>
                    <td style={{ padding: '8px 10px' }}>{row.internalNumber || '—'}</td>
                    <td style={{ padding: '8px 10px' }}>{row.engineBrand || '—'}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '1px 8px',
                          borderRadius: 12,
                          fontSize: 12,
                          border: `1px solid ${STATUS_TONES[row.status].border}`,
                          background: STATUS_TONES[row.status].background,
                          color: STATUS_TONES[row.status].color,
                        }}
                      >
                        {STATUS_LABELS[row.status]}
                        {canExpand ? (isOpen ? ' ▲' : ' ▼') : ''}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px' }}>{row.createdBy || '—'}</td>
                    <td style={{ padding: '8px 10px', color: '#64748b' }}>{fmtDay(row.createdAt)}</td>
                    <td style={{ padding: '8px 10px' }}>{row.cardDeletedBy || '—'}</td>
                    <td style={{ padding: '8px 10px', color: '#64748b' }}>{fmtDay(row.cardDeletedAt)}</td>
                    <td style={{ padding: '8px 10px', maxWidth: 320 }}>{row.deleteReason || '—'}</td>
                  </tr>
                  {isOpen && (
                    <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                      <td colSpan={10} style={{ padding: '10px 14px 14px' }}>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>
                          Что было в карточке {row.rmzCode}
                          <span style={{ fontWeight: 400, color: '#94a3b8' }}>
                            {' '}
                            · удалена {fmtMoment(row.cardDeletedAt)}
                            {row.cardDeletedBy ? ` · ${row.cardDeletedBy}` : ''}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                            gap: '6px 18px',
                          }}
                        >
                          {row.snapshot.map((fact) => (
                            <div key={fact.label} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                              <span style={{ color: '#64748b', minWidth: 130 }}>{fact.label}:</span>
                              <span>{fact.value}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={10} style={{ padding: '16px 10px', color: '#94a3b8', textAlign: 'center' }}>
                  {emptyText}
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
            getId: (row) => row.engineId,
            onSelect: selection.toggleSelect,
            onClearSelection: selection.clearSelection,
            hasSelection: selection.selectedCount > 0,
            // Список ОБЪЯВЛЯЕТ свои действия (промт КАРМАНА #67). Удалять номера РМЗ
            // нельзя никогда — пункта «Удалить» в меню НЕТ ВООБЩЕ, а не гаснет.
            actions: [
              openEngineAction,
              listPrintAction({ available: true, print: printRows }),
              listCopyAction({ available: true, copy: copyRows }),
            ],
          })}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <div style={{ fontSize: 12, color: '#94a3b8' }}>
        Показано {visible.length} из {rows.length}. Номер выдаёт сервер: у карточки, сохранённой без связи, номера ещё нет —
        он приедет первым же синком.
      </div>
    </div>
  );
}
