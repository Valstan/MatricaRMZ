import React, { useMemo, useRef, useState } from 'react';

import {
  HUMAN_LABEL_DASH,
  applyFacets,
  arrivalMonthGroup,
  daysOnSiteGroup,
  engineDaysOnSite,
  engineFacets,
  engineFactoryStage,
  engineStateLabel,
  flattenGrouped,
  isEngineAtPlant,
  plantScrapGroup,
  type EngineListItem,
  type FacetDescriptor,
  type FacetSelection,
  type GroupLevel,
} from '@matricarmz/shared';

import { Button } from '../../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../../components/ColumnSettingsButton.js';
import { ColumnToggleButton } from '../../components/ColumnToggleButton.js';
import { ColumnResizeHandle, manualThAnchor, manualWidth, manualWidthAttr } from '../../components/ColumnResizeHandle.js';
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
import { formatMoscowDate } from '../../utils/dateUtils.js';
import { listCellKindProps, listHeaderKindProps, type ListColumnKind } from '../../utils/listColumnKinds.js';
import { buildListPrintColumns } from '../../utils/listPrintColumns.js';
import { useWorkSheetTypeRefs } from '../../hooks/useWorkSheetTypeRefs.js';
import { useRepairStageTemplateRefs } from '../../hooks/useRepairStageTemplateRefs.js';
import { isAndroidPlatform } from '../../platform.js';
import type { ListReportPageProps } from './listReportPages.js';

/**
 * Отчёт «Двигатели на заводе» (заявка владельца 07.10.2026) — обстановка по заводу
 * на текущий момент: только двигатели, что числятся пришедшими и ещё не отправленными
 * (`isEngineAtPlant`), из всех введённых данных — документов, этапов движения, карточки.
 *
 * Группировки — переключатель «Группировать»: по этапу (где двигатель сейчас),
 * по заказчику, по дате прихода (месяц), по дням на заводе (сколько уже стоит),
 * по утилю (сколько лежит и не уехало). Выбор этапов для показа — ступень
 * «Последний этап» / «Этап на заводе» панели фильтров.
 *
 * Родственник — «Двигатели на заводе: этапы ремонта» (`engine_factory_stages`): та же
 * рамка и те же ступени, но разрезы другие (там — этап / заказчик / заказчик → этап).
 * Данные — каталог двигателей приложения, тот же, что у списка «Двигатели».
 */

type Column = ColumnDescriptor & {
  kind?: ListColumnKind;
  render: (e: Row) => React.ReactNode;
  sortValue?: (e: Row) => string | number;
  printValue?: (e: Row) => string;
};

type Row = EngineListItem & { stage: ReturnType<typeof engineFactoryStage>; state: string; daysOnSite: number | null };

type GroupBy = 'stage' | 'customer' | 'arrival' | 'days' | 'scrap' | 'none';

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  stage: 'По этапу',
  customer: 'По заказчику',
  arrival: 'По дате прихода',
  days: 'По дням на заводе',
  scrap: 'По утилю',
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

/** Ступени отчёта — те же смыслы, что в списке двигателей; полный ряд — «Этап на заводе». */
const FACET_IDS = ['customer', 'contract', 'brand', 'workshop', 'factoryStage', 'hasStage', 'lastStage', 'stageDate', 'scrap', 'reclamation', 'arrivalYear', 'arrival', 'arrivalDate'] as const;

const REPORT_HIDDEN_BY_DEFAULT = ['contract', 'state'];

function text(v: unknown): string {
  return String(v ?? '').trim();
}

function fmtDate(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? formatMoscowDate(ms) : HUMAN_LABEL_DASH;
}

function yesNo(v: boolean | undefined): string {
  return v ? 'Да' : 'Нет';
}

export function EnginesAtPlantReportPage(props: ListReportPageProps) {
  const types = useWorkSheetTypeRefs();
  const stageTemplates = useRepairStageTemplateRefs();
  const [printOpen, setPrintOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { state: ui, patchState } = useListUiState<ListUiState>('report:enginesAtPlant:ui', {
    query: '',
    searchSimilar: false,
    facets: {},
    facetFields: ['factoryStage'],
    facetsOpen: true,
    sortKey: 'engineNumber',
    sortDir: 'asc',
    groupBy: 'stage',
  });

  const rows = useMemo<Row[]>(() => {
    const now = Date.now();
    return props.engines.filter(isEngineAtPlant).map((e) => ({ ...e, stage: engineFactoryStage(e, types, stageTemplates), state: engineStateLabel(e), daysOnSite: engineDaysOnSite(e, now) }));
  }, [props.engines, types, stageTemplates]);

  const columns = useMemo<Column[]>(
    () => [
      { id: 'engineNumber', label: 'Номер', kind: 'name', render: (e) => text(e.engineNumber) || HUMAN_LABEL_DASH, sortValue: (e) => text(e.engineNumber), alwaysVisible: true },
      { id: 'internal', label: 'Внутр. №', kind: 'num', render: (e) => text(e.internalNumberFull), sortValue: (e) => text(e.internalNumberFull) },
      { id: 'brand', label: 'Марка', kind: 'name', render: (e) => text(e.engineBrand), sortValue: (e) => text(e.engineBrand) },
      { id: 'customer', label: 'Заказчик', kind: 'name', render: (e) => text(e.customerName), sortValue: (e) => text(e.customerName) },
      { id: 'contract', label: 'Договор', kind: 'name', render: (e) => text(e.contractName), sortValue: (e) => text(e.contractName) },
      { id: 'workshop', label: 'Цех', kind: 'name', render: (e) => text(e.workshopName), sortValue: (e) => text(e.workshopName) },
      { id: 'arrivalDate', label: 'Дата прихода', kind: 'date', render: (e) => fmtDate(e.arrivalDate), sortValue: (e) => e.arrivalDate ?? 0 },
      // У строки «Возвраты» `stage.label` занят названием группы, поэтому этап берём из
      // `stageLabel` — как в отчёте «Двигатели на заводе: этапы ремонта», иначе колонка
      // называла бы группу, а не место двигателя.
      { id: 'stage', label: 'Этап на заводе', kind: 'name', render: (e) => e.stage.stageLabel ?? e.stage.label, sortValue: (e) => e.stage.rank, alwaysVisible: true },
      { id: 'stageAt', label: 'Дата этапа', kind: 'date', render: (e) => fmtDate(e.stage.at), sortValue: (e) => e.stage.at ?? 0 },
      { id: 'daysOnSite', label: 'Дней на заводе', kind: 'num', render: (e) => (e.daysOnSite == null ? HUMAN_LABEL_DASH : String(e.daysOnSite)), sortValue: (e) => e.daysOnSite ?? -1 },
      { id: 'scrap', label: 'Утиль', kind: 'text', render: (e) => yesNo(e.isScrap), sortValue: (e) => (e.isScrap ? 1 : 0) },
      { id: 'state', label: 'Состояние', kind: 'name', render: (e) => e.state, sortValue: (e) => e.state },
    ],
    [],
  );

  const columnLayout = useColumnLayout(
    'report:enginesAtPlant:columns',
    columns.map((c) => c.id),
    REPORT_HIDDEN_BY_DEFAULT,
  );
  const columnsById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const visibleColumns = useMemo(
    () => columnLayout.order.map((id) => columnsById.get(id)).filter((c): c is Column => Boolean(c) && columnLayout.isVisible(c!.id)),
    [columnLayout, columnsById],
  );

  const facets = useMemo(() => {
    const all = engineFacets(types, stageTemplates);
    return FACET_IDS.map((id) => all.find((f) => f.id === id)).filter(Boolean) as FacetDescriptor<Row>[];
  }, [types, stageTemplates]);

  const deep = useListDeepFilter(
    rows,
    (r) => r.id,
    (r) => [r.engineNumber, r.internalNumberFull, r.engineBrand, r.customerName, r.contractName, r.workshopName, r.stage.label, r.stage.stageLabel ?? '', r.state].map(text).join(' '),
    ui.query,
    { entityBacked: false, mode: searchModeOf(ui.searchSimilar) },
  );
  const faceted = useMemo(() => applyFacets(facets, deep.filtered, ui.facets), [facets, deep.filtered, ui.facets]);
  const sorted = useMemo(() => {
    const col = columnsById.get(ui.sortKey) ?? columnsById.get('engineNumber')!;
    const sv = col.sortValue ?? ((r: Row) => text(r.engineNumber));
    const dir = ui.sortDir === 'asc' ? 1 : -1;
    return [...faceted].sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru');
      return cmp * dir || text(a.engineNumber).localeCompare(text(b.engineNumber), 'ru');
    });
  }, [faceted, columnsById, ui.sortKey, ui.sortDir]);

  // Уровни группировки: этап несёт ранг (поздние выше), заказчик — по подписи,
  // месяц прихода и корзины дней — из домена (`engineAtPlantGroups`), утиль — флагом.
  const levels = useMemo<GroupLevel<Row>[]>(() => {
    const byStage: GroupLevel<Row> = { keyOf: (r) => ({ key: r.stage.key, label: r.stage.label, rank: r.stage.rank }) };
    const byCustomer: GroupLevel<Row> = {
      keyOf: (r) => {
        const label = text(r.customerName);
        return { key: text(r.customerId) || `name:${label.toLowerCase()}` || 'none', label: label || 'Без заказчика' };
      },
    };
    const byArrival: GroupLevel<Row> = { keyOf: (r) => arrivalMonthGroup(r.arrivalDate) };
    const byDays: GroupLevel<Row> = { keyOf: (r) => daysOnSiteGroup(r.daysOnSite) };
    const byScrap: GroupLevel<Row> = { keyOf: (r) => plantScrapGroup(r.isScrap === true) };
    switch (ui.groupBy) {
      case 'stage':
        return [byStage];
      case 'customer':
        return [byCustomer];
      case 'arrival':
        return [byArrival];
      case 'days':
        return [byDays];
      case 'scrap':
        return [byScrap];
      default:
        return [];
    }
  }, [ui.groupBy]);
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

  const toggleSort = (id: string) =>
    patchState(ui.sortKey === id ? { sortDir: ui.sortDir === 'asc' ? 'desc' : 'asc' } : { sortKey: id, sortDir: 'asc' });

  const thStyle: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2 };
  const header = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 120%)', color: '#fff' }}>
        <RowNumberHeaderCell style={thStyle} />
        {visibleColumns.map((col) => (
          <th key={col.id} {...listHeaderKindProps(col.kind, col.label)} {...manualWidthAttr(columnLayout.widthOf(col.id))} style={{ ...manualThAnchor(), ...thStyle, cursor: col.sortValue ? 'pointer' : 'default', ...manualWidth(columnLayout.widthOf(col.id)) }} onClick={col.sortValue ? () => toggleSort(col.id) : undefined}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <span>{col.label}</span>
              <ColumnToggleButton colId={col.id} visible alwaysVisible={col.alwaysVisible} onToggle={() => columnLayout.setVisible(col.id, false)} />
            </span>
            <ColumnResizeHandle columnId={col.id} layout={columnLayout} />
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
          <td key={col.id} {...listCellKindProps(col.kind)} style={{ ...cellStyle }}>
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
    return { onClick: () => props.onOpenEngine(it.row.id), title: 'Открыть карточку двигателя', style: { cursor: 'pointer' }, 'data-report-engine-row': it.row.id };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-engines-at-plant-report>
      <PageToolbar>
        <Button variant="ghost" onClick={props.onBack}>
          К списку Отчётов
        </Button>
        <ToolbarPin>
          <Input value={ui.query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по двигателям на заводе…" />
        </ToolbarPin>
        <ToolbarPin>
          <SearchModeToggle similar={ui.searchSimilar} onToggle={() => patchState({ searchSimilar: !ui.searchSimilar })} />
        </ToolbarPin>
        <ToolbarPin>
          <FacetToggleButton<Row> facets={facets} selection={ui.facets} open={ui.facetsOpen} onToggle={() => patchState({ facetsOpen: !ui.facetsOpen })} />
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

      <div style={{ marginTop: 8, flex: '0 0 auto' }}>
        <FacetFilter<Row>
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

      <ListCount total={rows.length} shown={sorted.length} extra="на заводе на сегодня" style={{ marginTop: 6 }} />
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
          emptyState={rows.length === 0 ? 'На заводе сейчас нет двигателей: ни у одного нет даты прихода без даты отгрузки' : 'Ничего не найдено'}
          columnWidths={visibleColumns.map((c) => ({ id: c.id, width: columnLayout.widthOf(c.id) }))}
        />
      </div>

      {printOpen ? (
        <ListPrintDialog
          title="Двигатели на заводе"
          unitLabel="Двигателей"
          columns={buildListPrintColumns(columns)}
          visibleColumnIds={visibleColumns.map((c) => c.id)}
          rows={sorted.length > 0 ? items.filter((it) => it.kind === 'row').map((it) => (it.kind === 'row' ? it.row : null)!).filter(Boolean) : []}
          selectedRows={[]}
          storageKey="report:enginesAtPlant:printFields"
          rowGroupLabel={(r) => groupLabelByRow.get(r.id) || null}
          onClose={() => setPrintOpen(false)}
        />
      ) : null}
    </div>
  );
}
