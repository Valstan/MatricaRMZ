import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  activePpeCardsFacetCount,
  applyPpeCardsFacets,
  describeFacetSelection,
  PPE_CARDS_FACETS,
  PPE_CARD_STATE_RU,
  PPE_OVERVIEW_STATUS_RU,
  sanitizePpeCardsFacetSelection,
  type FacetDescriptor,
  type FacetSelection,
  type PpeCardsFacetRow,
  type PpeCardsFacetSelection,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnResizeHandle, manualThAnchor, manualWidth, manualWidthAttr } from '../components/ColumnResizeHandle.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { ColumnToggleButton } from '../components/ColumnToggleButton.js';
import { FacetFilter, FacetToggleButton } from '../components/FacetFilter.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { ListExportButtons } from '../components/ListExportButtons.js';
import { ListPrintDialog } from '../components/ListPrintDialog.js';
import { PageToolbar, ToolbarPin } from '../components/PageToolbar.js';
import { RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { useListUiState, usePersistedScrollTop, sortArrow, toggleSort, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { isAndroidPlatform, tabletColumnLabel } from '../platform.js';
import { listCellKindProps, listHeaderKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';
import { buildListPrintColumns } from '../utils/listPrintColumns.js';

type Row = PpeCardsFacetRow & {
  employeeId: string;
  fullName: string;
  personnelNo: string | null;
  sizes: { clothes: string; shoes: string; height: string };
  cardId: string | null;
  cardOpenedAt: number | null;
  normSetCount: number;
  normPositionCount: number;
  issueCount: number;
  lastIssuedAt: number | null;
  nextDueAt: number | null;
  overdueCount: number;
  dueSoonCount: number;
};

type SortKey =
  | 'fullName'
  | 'personnelNo'
  | 'cardState'
  | 'fillPercent'
  | 'clothes'
  | 'shoes'
  | 'height'
  | 'norms'
  | 'issues'
  | 'lastIssuedAt'
  | 'nextDueAt'
  | 'status'
  | 'employed';

type ListState = {
  query: string;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  facets: PpeCardsFacetSelection;
  facetFields: string[];
  facetsOpen: boolean;
};

const DEFAULT_STATE: ListState = {
  query: '',
  sortKey: 'fullName',
  sortDir: 'asc',
  facets: {},
  facetFields: [],
  facetsOpen: false,
};

/** Порядок важности состояний: сортировка «Состояние» ставит просрочку наверх. */
const STATUS_RANK: Record<Row['status'], number> = {
  overdue: 0,
  dueSoon: 1,
  neverIssued: 2,
  noNorms: 3,
  ok: 4,
};

function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function statusCell(row: Row): React.ReactNode {
  const label = PPE_OVERVIEW_STATUS_RU[row.status];
  if (row.status === 'overdue') {
    return (
      <span style={{ color: '#b91c1c', fontWeight: 600 }} title={`Просрочено позиций: ${row.overdueCount}`}>
        {label}
        {row.overdueCount > 1 ? ` (${row.overdueCount})` : ''}
      </span>
    );
  }
  if (row.status === 'dueSoon') {
    return (
      <span style={{ color: '#b45309' }} title={`Скоро выдавать позиций: ${row.dueSoonCount}`}>
        {label}
      </span>
    );
  }
  return <span style={{ color: 'var(--muted)' }}>{label}</span>;
}

function fillCell(row: Row): React.ReactNode {
  return (
    <span title="Заполнено: одежда, обувь, рост, нормы, выдачи">
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 44,
          height: 6,
          borderRadius: 3,
          background: '#e5e7eb',
          marginRight: 6,
          verticalAlign: 'middle',
        }}
      >
        <span
          style={{
            display: 'block',
            width: `${Math.max(0, Math.min(100, row.fillPercent))}%`,
            height: '100%',
            borderRadius: 3,
            background: row.fillPercent >= 100 ? '#16a34a' : row.fillPercent > 0 ? '#f59e0b' : '#dc2626',
          }}
        />
      </span>
      {row.fillPercent}%
    </span>
  );
}

/**
 * «Карточки СИЗ» — список сотрудников, а не пикер (владелец 20.10.2026): кладовщику нужно
 * видеть, у кого карточка заведена и кому пора выдавать, а не искать фамилию вслепую.
 * Клик по строке открывает карточку сотрудника в отдельной вкладке.
 *
 * Строку и сроки считает сервер (`/ppe/cards/overview`) тем же ядром shared/ppe, что и
 * карточка: список и карточка не могут говорить разное про «пора».
 */
export function PpeCardsPage(props: { onOpen: (employeeId: string) => void }) {
  const { state, patchState } = useListUiState<ListState>('list:ppe-cards', DEFAULT_STATE);
  const { query, sortKey, sortDir, facetsOpen } = state;
  const facets = sanitizePpeCardsFacetSelection(state.facets);
  const facetFields = state.facetFields;
  const { containerRef, onScroll } = usePersistedScrollTop('list:ppe-cards');

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [printDialogOpen, setPrintDialogOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await window.matrica.ppe.cards.overview().catch(() => null);
    if (!res) {
      setStatus('Ошибка: сервер не ответил');
      setLoading(false);
      return;
    }
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      setLoading(false);
      return;
    }
    setRows(res.rows as Row[]);
    setStatus('');
    setLoading(false);
  }, []);

  // Вкладка в keep-alive: без импульса выдача, сделанная в карточке, не изменила бы сроки
  // в списке до перезапуска клиента.
  useLiveDataRefresh(load, { intervalMs: 60_000, domains: ['ppe'] });

  useEffect(() => {
    void load();
  }, [load]);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      `${row.fullName} ${row.personnelNo ?? ''}`.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const faceted = useMemo(
    () => applyPpeCardsFacets(searched, facets),
    [searched, facets],
  );

  const sorted = useSortedItems<Row, SortKey>(
    faceted,
    sortKey,
    sortDir,
    (row, key) => {
      switch (key) {
        case 'personnelNo':
          return row.personnelNo ?? '';
        case 'cardState':
          return PPE_CARD_STATE_RU[row.cardState];
        case 'fillPercent':
          return row.fillPercent;
        case 'clothes':
          return row.sizes.clothes;
        case 'shoes':
          return row.sizes.shoes;
        case 'height':
          return row.sizes.height;
        case 'norms':
          return row.normPositionCount;
        case 'issues':
          return row.issueCount;
        case 'lastIssuedAt':
          return row.lastIssuedAt ?? 0;
        case 'nextDueAt':
          return row.nextDueAt ?? Number.MAX_SAFE_INTEGER;
        case 'status':
          return STATUS_RANK[row.status];
        case 'employed':
          return row.isActive ? 1 : 0;
        default:
          return row.fullName;
      }
    },
    (row) => row.fullName,
  );

  type PpeColumn = ColumnDescriptor & {
    sortKey: SortKey;
    kind?: ListColumnKind;
    printValue?: (row: Row) => string;
    render: (row: Row) => React.ReactNode;
  };

  const allColumns = useMemo<PpeColumn[]>(
    () => [
      {
        id: 'fullName',
        label: 'Сотрудник',
        sortKey: 'fullName',
        kind: 'name',
        alwaysVisible: true,
        render: (row) => (
          <span style={row.isActive ? undefined : { color: 'var(--muted)' }}>
            {row.fullName || '—'}
            {row.isActive ? null : <span style={{ fontSize: 11 }}> · уволен</span>}
          </span>
        ),
      },
      {
        id: 'personnelNo',
        label: 'Табельный',
        tabletLabel: 'Таб.',
        sortKey: 'personnelNo',
        render: (row) => row.personnelNo || '—',
      },
      {
        id: 'cardState',
        label: 'Карточка',
        sortKey: 'cardState',
        render: (row) => PPE_CARD_STATE_RU[row.cardState],
        printValue: (row) => PPE_CARD_STATE_RU[row.cardState],
      },
      {
        id: 'fillPercent',
        label: 'Заполнено',
        sortKey: 'fillPercent',
        kind: 'num',
        render: fillCell,
        printValue: (row) => `${row.fillPercent}%`,
      },
      {
        id: 'clothes',
        label: 'Одежда',
        sortKey: 'clothes',
        render: (row) => row.sizes.clothes || '—',
      },
      {
        id: 'shoes',
        label: 'Обувь',
        sortKey: 'shoes',
        render: (row) => row.sizes.shoes || '—',
      },
      {
        id: 'height',
        label: 'Рост',
        sortKey: 'height',
        render: (row) => row.sizes.height || '—',
      },
      {
        id: 'norms',
        label: 'Норм',
        sortKey: 'norms',
        kind: 'num',
        render: (row) => row.normPositionCount,
        printValue: (row) => String(row.normPositionCount),
      },
      {
        id: 'issues',
        label: 'Выдач',
        sortKey: 'issues',
        kind: 'num',
        render: (row) => row.issueCount,
        printValue: (row) => String(row.issueCount),
      },
      {
        id: 'lastIssuedAt',
        label: 'Последняя выдача',
        tabletLabel: 'Посл.',
        sortKey: 'lastIssuedAt',
        kind: 'date',
        render: (row) => fmtDate(row.lastIssuedAt),
        printValue: (row) => fmtDate(row.lastIssuedAt),
      },
      {
        id: 'nextDueAt',
        label: 'Следующая',
        sortKey: 'nextDueAt',
        kind: 'date',
        render: (row) => fmtDate(row.nextDueAt),
        printValue: (row) => fmtDate(row.nextDueAt),
      },
      {
        id: 'status',
        label: 'Состояние',
        sortKey: 'status',
        render: statusCell,
        printValue: (row) => PPE_OVERVIEW_STATUS_RU[row.status],
      },
      {
        id: 'employed',
        label: 'Уволен',
        sortKey: 'employed',
        render: (row) => (row.isActive ? '—' : 'да'),
        printValue: (row) => (row.isActive ? '' : 'да'),
      },
    ],
    [],
  );

  const allColumnIds = useMemo(() => allColumns.map((c) => c.id), [allColumns]);
  const columnsById = useMemo(() => new Map(allColumns.map((c) => [c.id, c])), [allColumns]);
  // Рост и дату последней выдачи прячем по умолчанию: без них список читается, а с ними
  // превращается в таблицу из тринадцати колонок.
  const columnLayout = useColumnLayout('list:ppe-cards:columns', allColumnIds, ['height', 'lastIssuedAt']);
  const visibleColumns = useMemo(
    () =>
      columnLayout.order
        .map((id) => columnsById.get(id))
        .filter((col): col is PpeColumn => Boolean(col))
        .filter((col) => columnLayout.isVisible(col.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- useColumnLayout returns a fresh object each render; only hidden matters here
    [columnLayout.order, columnLayout.hidden, columnsById],
  );
  const columnDescriptors = useMemo<ColumnDescriptor[]>(
    () => allColumns.map((c) => ({ id: c.id, label: c.label, ...(c.tabletLabel ? { tabletLabel: c.tabletLabel } : {}) })),
    [allColumns],
  );
  const printColumns = useMemo(() => buildListPrintColumns(allColumns), [allColumns]);

  function onSortHeader(nextKey: SortKey) {
    const next = toggleSort(sortKey, sortDir, nextKey);
    patchState({ sortKey: next.sortKey, sortDir: next.sortDir });
  }

  function sortLabel(label: string, key: SortKey) {
    return `${label}${sortArrow(sortKey, sortDir, key)}`;
  }

  function renderTableHeader() {
    const allInOrder = columnLayout.order
      .map((id) => columnsById.get(id))
      .filter((col): col is PpeColumn => Boolean(col));
    return (
      <thead>
        <tr>
          <RowNumberHeaderCell />
          {allInOrder.map((col) => {
            if (!columnLayout.isVisible(col.id)) return null;
            return (
              <th
                key={col.id}
                {...listHeaderKindProps(col.kind, col.label)}
                {...manualWidthAttr(columnLayout.widthOf(col.id))}
                style={{
                  ...manualThAnchor(),
                  textAlign: 'left',
                  cursor: 'pointer',
                  ...manualWidth(columnLayout.widthOf(col.id)),
                }}
                onClick={() => onSortHeader(col.sortKey)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  <span>{sortLabel(tabletColumnLabel(col.label, col.tabletLabel), col.sortKey)}</span>
                  <ColumnToggleButton
                    colId={col.id}
                    visible
                    alwaysVisible={col.alwaysVisible}
                    onToggle={() => columnLayout.setVisible(col.id, false)}
                  />
                </span>
                <ColumnResizeHandle columnId={col.id} layout={columnLayout} />
              </th>
            );
          })}
          <th className="list-col-filler" aria-hidden="true" />
        </tr>
      </thead>
    );
  }

  function rowProps(row: Row): VirtualTableRowProps {
    return {
      style: { cursor: 'pointer', opacity: row.isActive ? 1 : 0.55 },
      onClick: () => props.onOpen(row.employeeId),
      title: 'Открыть карточку СИЗ',
    };
  }

  function renderCells(row: Row) {
    return (
      <>
        {visibleColumns.map((col) => (
          <td key={col.id} {...listCellKindProps(col.kind)}>
            {col.render(row)}
          </td>
        ))}
        <td className="list-col-filler" aria-hidden="true" />
      </>
    );
  }

  return (
    <div data-list-root="true" style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <PageToolbar>
        <ToolbarPin>
          <div style={{ width: 280 }}>
            <Input
              value={query}
              onChange={(e) => patchState({ query: e.target.value })}
              placeholder="Поиск по ФИО и табельному…"
            />
          </div>
        </ToolbarPin>
        <ToolbarPin>
          <FacetToggleButton<Row>
            facets={PPE_CARDS_FACETS as readonly FacetDescriptor<Row>[]}
            selection={facets as FacetSelection}
            open={facetsOpen}
            onToggle={() => patchState({ facetsOpen: !facetsOpen })}
          />
        </ToolbarPin>
        <ColumnSettingsButton
          label="Колонки списка"
          columns={columnDescriptors}
          order={columnLayout.order}
          isVisible={columnLayout.isVisible}
          onToggleVisible={columnLayout.setVisible}
          onMove={columnLayout.moveColumn}
          onReset={columnLayout.resetToDefault}
        />
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
          Обновить
        </Button>
        {!isAndroidPlatform() && (
          <Button
            variant="ghost"
            onClick={() => setPrintDialogOpen(true)}
            title="Печать текущего списка: колонки как на экране, объём под контролем"
          >
            Печать списка
          </Button>
        )}
        <ListExportButtons
          title="Карточки СИЗ"
          columns={printColumns}
          visibleColumnIds={visibleColumns.map((c) => c.id)}
          rows={sorted}
          selectedRows={[]}
          storageKey="list:ppe-cards:printFields"
          filtersSummary={describeFacetSelection(PPE_CARDS_FACETS as readonly FacetDescriptor<Row>[], facets as FacetSelection, {
            search: query,
          })}
        />
      </PageToolbar>

      {/* Диалог печати вне ряда кнопок: в ряду он уехал бы в меню переполнения. */}
      {printDialogOpen && (
        <ListPrintDialog
          title="Карточки СИЗ"
          columns={printColumns}
          visibleColumnIds={visibleColumns.map((c) => c.id)}
          rows={sorted}
          selectedRows={[]}
          storageKey="list:ppe-cards:printFields"
          filtersSummary={describeFacetSelection(PPE_CARDS_FACETS as readonly FacetDescriptor<Row>[], facets as FacetSelection, {
            search: query,
          })}
          onClose={() => setPrintDialogOpen(false)}
        />
      )}

      <div style={{ marginTop: 8, flex: '0 0 auto' }}>
        <FacetFilter<Row>
          facets={PPE_CARDS_FACETS as readonly FacetDescriptor<Row>[]}
          rows={searched}
          selection={facets as FacetSelection}
          fields={facetFields}
          open={facetsOpen}
          usageKey="list:ppe-cards"
          onChangeSelection={(next) => patchState({ facets: next as PpeCardsFacetSelection })}
          onChangeFields={(next) => patchState({ facetFields: next })}
          onReset={() => patchState({ facets: {}, facetFields: [] })}
        />
      </div>

      {status ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b91c1c)' : 'var(--muted)' }}>{status}</div>
      ) : null}

      <ListCount total={rows.length} shown={sorted.length} />
      <div ref={containerRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <VirtualTable
          scrollElementRef={containerRef}
          count={sorted.length}
          header={renderTableHeader()}
          renderCells={(i) => renderCells(sorted[i]!)}
          getRowKey={(i) => sorted[i]!.employeeId}
          getRowProps={(i) => rowProps(sorted[i]!)}
          colCount={visibleColumns.length + 1}
          rowNumbers
          leadingColumns={2}
          columnWidths={visibleColumns.map((col) => ({ id: col.id, width: columnLayout.widthOf(col.id) }))}
          emptyState={
            loading
              ? 'Загружаем сотрудников…'
              : activePpeCardsFacetCount(facets) > 0
                ? 'Под фильтр не попал никто'
                : 'Сотрудников нет'
          }
        />
      </div>
    </div>
  );
}
