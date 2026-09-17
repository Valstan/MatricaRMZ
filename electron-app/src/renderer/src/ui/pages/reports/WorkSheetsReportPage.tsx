import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  HUMAN_LABEL_DASH,
  HUMAN_LABEL_NO_NUMBER,
  applyFacets,
  flattenGrouped,
  formatWorkSheetValue,
  workSheetFacets,
  workSheetFieldsSummary,
  type FacetDescriptor,
  type FacetSelection,
  type GroupLevel,
  unionWorkSheetColumns,
  type WorkSheetColumn,
  type WorkSheetRow,
} from '@matricarmz/shared';

import { Button } from '../../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../../components/ColumnSettingsButton.js';
import { ColumnToggleButton } from '../../components/ColumnToggleButton.js';
import { FacetFilter, FacetToggleButton } from '../../components/FacetFilter.js';
import { Input } from '../../components/Input.js';
import { ListCount } from '../../components/ListCount.js';
import { ListPrintDialog } from '../../components/ListPrintDialog.js';
import { PageToolbar, ToolbarPin } from '../../components/PageToolbar.js';
import { RowNumberHeaderCell } from '../../components/RowNumberCell.js';
import { SearchModeToggle, searchModeOf } from '../../components/SearchModeToggle.js';
import { VirtualTable, type VirtualTableRowProps } from '../../components/VirtualTable.js';
import { useColumnLayout } from '../../hooks/useColumnLayout.js';
import { useListDeepFilter } from '../../hooks/useListDeepFilter.js';
import { useListUiState } from '../../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../../hooks/useLiveDataRefresh.js';
import { isAndroidPlatform } from '../../platform.js';
import { formatMoscowDate } from '../../utils/dateUtils.js';
import { listCellKindProps, listHeaderKindProps, type ListColumnKind } from '../../utils/listColumnKinds.js';
import { buildListPrintColumns } from '../../utils/listPrintColumns.js';
import { loadWorkSheetTypes } from '../../utils/workSheetTypesCache.js';
import type { ListReportPageProps } from './listReportPages.js';

/**
 * Отчёт «Этапы работ» в укладе списка (B5 программы осень-2026, рецепт —
 * `docs/plans/reports-as-lists-2026-09.md`). Строки — те же записи истории ремонта, что на
 * экране «Этапы работ», но за ВСЁ время (экран берёт год) и с группировкой: вид работ /
 * договор / цех / заказчик; заголовок группы несёт её итог — это и есть «итоги по видам работ».
 *
 * Данных нет в каталоге двигателей (правило 4 рецепта), поэтому страница читает их сама тем
 * же мостом `workSheets.rows.list`, что и экран, — лениво, при первом открытии отчёта, и
 * подхватывает живые изменения так же, как экран. Поля видов работ — и сводной колонкой, и
 * отдельными колонками по каждому полю (скрыты по умолчанию; набор — объединение полей всех
 * видов работ из справочника, так что новая колонка вида работ появляется здесь сама).
 */

type Column = ColumnDescriptor & {
  kind?: ListColumnKind;
  render: (r: WorkSheetRow) => React.ReactNode;
  sortValue?: (r: WorkSheetRow) => string | number;
  printValue?: (r: WorkSheetRow) => string;
};

type GroupBy = 'type' | 'contract' | 'workshop' | 'customer' | 'customer_type' | 'none';

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  type: 'По виду работ',
  contract: 'По договору',
  workshop: 'По цеху',
  customer: 'По заказчику',
  customer_type: 'Заказчик → вид работ',
  none: 'Без группировки',
};

type ListUiState = {
  query: string;
  searchSimilar: boolean;
  facets: FacetSelection;
  facetFields: string[];
  facetsOpen: boolean;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  groupBy: GroupBy;
};

/** Ключ колонки поля вида работ — с префиксом, чтобы не пересечься с общими. */
function fieldColumnId(code: string): string {
  return `field:${code}`;
}

function text(v: unknown): string {
  return String(v ?? '').trim();
}

export function WorkSheetsReportPage(props: ListReportPageProps) {
  const [rows, setRows] = useState<WorkSheetRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState('');
  const [fieldColumns, setFieldColumns] = useState<WorkSheetColumn[]>([]);
  const [workshopNameById, setWorkshopNameById] = useState<Map<string, string>>(() => new Map());
  const [printOpen, setPrintOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { state: ui, patchState } = useListUiState<ListUiState>('report:workSheets:ui', {
    query: '',
    searchSimilar: false,
    facets: {},
    facetFields: ['type'],
    facetsOpen: true,
    sortKey: 'at',
    sortDir: 'desc',
    groupBy: 'type',
  });

  const refreshRows = useCallback(async () => {
    try {
      const res = await window.matrica.workSheets.rows.list({ sinceMs: null });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setRows(res.rows);
      setTruncated(res.truncated === true);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refreshRows();
    void loadWorkSheetTypes().then((res) => setFieldColumns(unionWorkSheetColumns(res.rows)));
    void (async () => {
      try {
        const r = await window.matrica.workshops.list({ activeOnly: true });
        if (r.ok) setWorkshopNameById(new Map(r.rows.map((w) => [String(w.id), String(w.name || w.code)] as const)));
      } catch {
        /* без справочника цехов — снимок имени из самой строки */
      }
    })();
  }, [refreshRows]);
  useLiveDataRefresh(refreshRows);

  const workshopLabel = useCallback(
    (r: WorkSheetRow) => (r.workshopId ? workshopNameById.get(r.workshopId) || r.workshopName || HUMAN_LABEL_DASH : ''),
    [workshopNameById],
  );

  const columns = useMemo<Column[]>(
    () => [
      { id: 'at', label: 'Дата', kind: 'date', render: (r) => formatMoscowDate(new Date(r.at)), sortValue: (r) => r.at, alwaysVisible: true },
      { id: 'type', label: 'Вид работ', kind: 'name', render: (r) => r.typeName || r.typeCode, sortValue: (r) => r.typeName, alwaysVisible: true },
      { id: 'engine', label: 'Двигатель', kind: 'name', render: (r) => r.engineNumber || HUMAN_LABEL_NO_NUMBER, sortValue: (r) => r.engineNumber, alwaysVisible: true },
      { id: 'brand', label: 'Марка', kind: 'name', render: (r) => r.engineBrand, sortValue: (r) => r.engineBrand },
      { id: 'internal', label: 'Внутр. №', kind: 'num', render: (r) => r.internalNumber, sortValue: (r) => r.internalNumber },
      {
        id: 'customer',
        label: 'Заказчик',
        kind: 'name',
        render: (r) => (r.customerName ? <span title={r.customerFullName || r.customerName}>{r.customerName}</span> : ''),
        sortValue: (r) => r.customerName,
        printValue: (r) => r.customerName,
      },
      {
        id: 'contract',
        label: 'Договор',
        kind: 'name',
        render: (r) => (r.contractShortLabel ? <span title={r.contractNumber}>{r.contractShortLabel}</span> : ''),
        sortValue: (r) => r.contractShortLabel,
        printValue: (r) => r.contractShortLabel,
      },
      { id: 'workshop', label: 'Цех', kind: 'name', render: (r) => workshopLabel(r), sortValue: (r) => workshopLabel(r) },
      { id: 'fields', label: 'Поля', kind: 'text', render: (r) => workSheetFieldsSummary(r.fields) },
      ...fieldColumns.map<Column>((c) => ({
        id: fieldColumnId(c.code),
        label: c.label,
        kind: c.type === 'number' ? 'num' : c.type === 'date' ? 'date' : 'text',
        render: (r) => {
          const f = r.fields.find((x) => x.code === c.code);
          return f ? formatWorkSheetValue(f) : '';
        },
        sortValue: (r) => {
          const f = r.fields.find((x) => x.code === c.code);
          return typeof f?.value === 'number' ? f.value : f ? formatWorkSheetValue(f) : '';
        },
      })),
      { id: 'performedBy', label: 'Кто', kind: 'name', render: (r) => r.performedBy, sortValue: (r) => r.performedBy },
      { id: 'note', label: 'Примечание', kind: 'text', render: (r) => r.note },
    ],
    [workshopLabel, fieldColumns],
  );

  const hiddenByDefault = useMemo(() => ['internal', ...fieldColumns.map((c) => fieldColumnId(c.code))], [fieldColumns]);
  const columnLayout = useColumnLayout(
    'report:workSheets:columns',
    columns.map((c) => c.id),
    hiddenByDefault,
  );
  const columnsById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const visibleColumns = useMemo(
    () => columnLayout.order.map((id) => columnsById.get(id)).filter((c): c is Column => Boolean(c) && columnLayout.isVisible(c!.id)),
    [columnLayout, columnsById],
  );

  // Ступени — общие плюс по одной на каждое поле вида работ (по справочнику).
  const facets = useMemo(() => workSheetFacets(fieldColumns) as FacetDescriptor<WorkSheetRow>[], [fieldColumns]);

  const deep = useListDeepFilter(
    rows,
    (r) => r.id,
    (r) => [r.engineNumber, r.engineBrand, r.internalNumber, r.typeName, r.customerName, r.contractNumber, r.contractShortLabel, workshopLabel(r), r.note, r.performedBy, workSheetFieldsSummary(r.fields)].join(' '),
    ui.query,
    { entityBacked: false, mode: searchModeOf(ui.searchSimilar) },
  );
  const faceted = useMemo(() => applyFacets(facets, deep.filtered, ui.facets), [facets, deep.filtered, ui.facets]);
  const sorted = useMemo(() => {
    const col = columnsById.get(ui.sortKey) ?? columnsById.get('at')!;
    const sv = col.sortValue ?? ((r: WorkSheetRow) => r.at);
    const dir = ui.sortDir === 'asc' ? 1 : -1;
    return [...faceted].sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru');
      return cmp * dir || b.at - a.at;
    });
  }, [faceted, columnsById, ui.sortKey, ui.sortDir]);

  const levels = useMemo<GroupLevel<WorkSheetRow>[]>(() => {
    const byLabel = (keyOf: (r: WorkSheetRow) => string, labelOf: (r: WorkSheetRow) => string, empty: string): GroupLevel<WorkSheetRow> => ({
      keyOf: (r) => {
        const label = text(labelOf(r));
        return { key: text(keyOf(r)) || `name:${label.toLowerCase()}` || 'none', label: label || empty };
      },
    });
    const byType = byLabel((r) => r.typeCode, (r) => r.typeName || r.typeCode, 'Без вида работ');
    const byContract = byLabel((r) => r.contractNumber, (r) => r.contractShortLabel || r.contractNumber, 'Без договора');
    const byWorkshop = byLabel((r) => r.workshopId, workshopLabel, 'Без цеха');
    const byCustomer = byLabel((r) => r.customerName, (r) => r.customerName, 'Без заказчика');
    switch (ui.groupBy) {
      case 'type':
        return [byType];
      case 'contract':
        return [byContract];
      case 'workshop':
        return [byWorkshop];
      case 'customer':
        return [byCustomer];
      case 'customer_type':
        return [byCustomer, byType];
      default:
        return [];
    }
  }, [ui.groupBy, workshopLabel]);
  const items = useMemo(() => flattenGrouped(sorted, levels), [sorted, levels]);

  // Подпись группы для печати: путь заголовков над строкой, как на экране.
  const groupLabelByRow = useMemo(() => {
    const map = new Map<string, string>();
    const path: string[] = [];
    for (const it of items) {
      if (it.kind === 'group') {
        path.length = it.depth;
        path[it.depth] = it.label;
      } else map.set(it.row.id, path.join(' › '));
    }
    return map;
  }, [items]);

  const enginesShown = useMemo(() => new Set(sorted.map((r) => r.engineId)).size, [sorted]);

  const toggleSort = (id: string) =>
    patchState(ui.sortKey === id ? { sortDir: ui.sortDir === 'asc' ? 'desc' : 'asc' } : { sortKey: id, sortDir: id === 'at' ? 'desc' : 'asc' });

  const thStyle: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2 };
  const header = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 120%)', color: '#fff' }}>
        <RowNumberHeaderCell style={thStyle} />
        {visibleColumns.map((col) => (
          <th key={col.id} {...listHeaderKindProps(col.kind, col.label)} style={{ ...thStyle, cursor: col.sortValue ? 'pointer' : 'default' }} onClick={col.sortValue ? () => toggleSort(col.id) : undefined}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <span>{col.label}</span>
              <ColumnToggleButton colId={col.id} visible alwaysVisible={col.alwaysVisible} onToggle={() => columnLayout.setVisible(col.id, false)} />
            </span>
            {ui.sortKey === col.id ? (ui.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </th>
        ))}
        <th className="list-col-filler" aria-hidden="true" />
      </tr>
    </thead>
  );

  const cellStyle: React.CSSProperties = { borderBottom: '1px solid #f3f4f6', padding: 8 };
  const renderCells = (i: number) => {
    const it = items[i]!;
    if (it.kind === 'group') {
      return (
        // Отступ вложенной группы — внутренним span'ом: паддинг `td` списка задан в global.css
        // с !important, и inline paddingLeft на ячейке молча съедается (стенд, 15.09.2026).
        <td colSpan={visibleColumns.length + 1} style={{ ...cellStyle, fontWeight: 600, background: it.depth === 0 ? '#eef2ff' : '#f8fafc' }} data-report-group-row={it.key}>
          <span style={{ display: 'inline-block', paddingLeft: it.depth * 18 }} data-report-group-depth={it.depth}>
            {it.depth > 0 ? '↳ ' : ''}
            {it.label} <span className="ui-muted" style={{ fontWeight: 400 }}>· {it.count}</span>
          </span>
        </td>
      );
    }
    return (
      <>
        {visibleColumns.map((col) => (
          <td key={col.id} {...listCellKindProps(col.kind)} style={cellStyle}>
            {col.render(it.row)}
          </td>
        ))}
        <td className="list-col-filler" aria-hidden="true" style={{ borderBottom: '1px solid #f3f4f6' }} />
      </>
    );
  };
  const rowProps = (i: number): VirtualTableRowProps => {
    const it = items[i]!;
    if (it.kind === 'group') return { 'data-report-group': it.key };
    return { onClick: () => props.onOpenEngine(it.row.engineId), title: 'Открыть карточку двигателя', style: { cursor: 'pointer' }, 'data-report-sheet-row': it.row.id };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-work-sheets-report>
      <PageToolbar>
        <Button variant="ghost" onClick={props.onBack}>
          К списку Отчётов
        </Button>
        <ToolbarPin>
          <Input value={ui.query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по этапам работ…" />
        </ToolbarPin>
        <ToolbarPin>
          <SearchModeToggle similar={ui.searchSimilar} onToggle={() => patchState({ searchSimilar: !ui.searchSimilar })} />
        </ToolbarPin>
        <ToolbarPin>
          <FacetToggleButton<WorkSheetRow> facets={facets} selection={ui.facets} open={ui.facetsOpen} onToggle={() => patchState({ facetsOpen: !ui.facetsOpen })} />
        </ToolbarPin>
        <ColumnSettingsButton
          label="Колонки списка"
          columns={columns}
          order={columnLayout.order}
          isVisible={columnLayout.isVisible}
          onToggleVisible={columnLayout.setVisible}
          onMove={columnLayout.moveColumn}
          onReset={columnLayout.resetToDefault}
        />
        <ToolbarPin>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span className="ui-muted">Группировать</span>
            <select value={ui.groupBy} onChange={(e) => patchState({ groupBy: e.target.value as GroupBy })} data-report-group-by>
              {(Object.keys(GROUP_BY_LABELS) as GroupBy[]).map((k) => (
                <option key={k} value={k}>
                  {GROUP_BY_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </ToolbarPin>
        {!isAndroidPlatform() && props.canExport && (
          <Button variant="ghost" onClick={() => setPrintOpen(true)} title="Печать текущего списка (по фильтру, с заголовками групп) с выбором полей">
            Печать списка
          </Button>
        )}
      </PageToolbar>
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ marginTop: 8, flex: '0 0 auto' }}>
        <FacetFilter<WorkSheetRow>
          facets={facets}
          rows={deep.filtered}
          selection={ui.facets}
          fields={ui.facetFields}
          open={ui.facetsOpen}
          onChangeSelection={(next) => patchState({ facets: next })}
          onChangeFields={(next) => patchState({ facetFields: next })}
          onReset={() => patchState({ facets: {}, facetFields: [] })}
        />
      </div>

      <ListCount
        total={rows.length}
        shown={sorted.length}
        extra={`двигателей: ${enginesShown}${truncated ? ' · показано не всё: выборка упёрлась в потолок' : ''}`}
        style={{ marginTop: 6 }}
      />
      <div ref={containerRef} style={{ marginTop: 2, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <VirtualTable
          scrollElementRef={containerRef}
          count={items.length}
          header={header}
          renderCells={renderCells}
          getRowKey={(i) => {
            const it = items[i]!;
            return it.kind === 'group' ? `g:${it.key}` : it.row.id;
          }}
          getRowProps={rowProps}
          rowNumberOf={(i) => {
            const it = items[i]!;
            return it.kind === 'group' ? null : it.number;
          }}
          colCount={Math.max(1, visibleColumns.length) + 1}
          rowNumbers
          estimateSize={40}
          emptyState={rows.length === 0 ? 'Этапов работ пока нет' : 'Ничего не найдено'}
        />
      </div>

      {printOpen ? (
        <ListPrintDialog
          title="Этапы работ"
          unitLabel="Этапов работ"
          columns={buildListPrintColumns(columns)}
          visibleColumnIds={visibleColumns.map((c) => c.id)}
          rows={sorted.length > 0 ? items.filter((it) => it.kind === 'row').map((it) => (it.kind === 'row' ? it.row : null)!).filter(Boolean) : []}
          selectedRows={[]}
          storageKey="report:workSheets:printFields"
          rowGroupLabel={(r) => groupLabelByRow.get(r.id) || null}
          onClose={() => setPrintOpen(false)}
        />
      ) : null}
    </div>
  );
}
