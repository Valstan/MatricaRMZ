import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  applyFacets,
  formatWorkSheetValue,
  workSheetFacets,
  workSheetFieldsSummary,
  type EngineListItem,
  type FacetDescriptor,
  type FacetSelection,
  type WorkSheetRow,
  type WorkSheetType,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { CardTabs, type CardTab } from '../components/CardTabs.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { ColumnToggleButton } from '../components/ColumnToggleButton.js';
import { FacetFilter, FacetToggleButton } from '../components/FacetFilter.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { PageToolbar, ToolbarPin } from '../components/PageToolbar.js';
import { RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SearchModeToggle, searchModeOf } from '../components/SearchModeToggle.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { WorkSheetRowDialog, type WorkshopOption } from '../components/WorkSheetRowDialog.js';
import { WorkSheetTypeEditorDialog } from '../components/WorkSheetTypeEditorDialog.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { useListDeepFilter } from '../hooks/useListDeepFilter.js';
import { useListUiState } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { listCellKindProps, listHeaderKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';
import { loadWorkSheetTypes } from '../utils/workSheetTypesCache.js';
import { formatMoscowDate } from '../utils/dateUtils.js';

/**
 * Ведомости работ (владелец 15.09.2026): общий журнал движений двигателя по узлам завода.
 * Вкладка «Все» — строки всех узлов по дате; дальше — вкладка на узел со своими колонками.
 * Строки живут записями истории ремонта (`operations`, см. `workSheetService`), узлы — REST-справочник.
 * Панели вкладок смонтированы всегда и скрыты `hidden` (контракт `CardTabs`, GOTCHAS M78).
 */

const ALL_TAB = 'all';

type Column = ColumnDescriptor & {
  kind?: ListColumnKind;
  render: (r: WorkSheetRow) => React.ReactNode;
  sortValue?: (r: WorkSheetRow) => string | number;
};

type TabUiState = {
  query: string;
  searchSimilar: boolean;
  facets: FacetSelection;
  facetFields: string[];
  facetsOpen: boolean;
  sortKey: string;
  sortDir: 'asc' | 'desc';
};

const defaultTabUi = (): TabUiState => ({ query: '', searchSimilar: false, facets: {}, facetFields: [], facetsOpen: false, sortKey: 'at', sortDir: 'desc' });

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function engineLabel(r: WorkSheetRow): string {
  return r.engineNumber || r.engineId.slice(0, 8);
}

export function WorkSheetsPage(props: { canEdit: boolean; canManageTypes: boolean; onOpenEngine: (id: string) => void }) {
  const [types, setTypes] = useState<WorkSheetType[]>([]);
  const [typesFromCache, setTypesFromCache] = useState(false);
  const [rows, setRows] = useState<WorkSheetRow[]>([]);
  const [status, setStatus] = useState('');
  const [allTime, setAllTime] = useState(false);
  const [workshops, setWorkshops] = useState<WorkshopOption[]>([]);
  const [engines, setEngines] = useState<EngineListItem[]>([]);
  const [enginesReady, setEnginesReady] = useState(false);
  const [rowDialog, setRowDialog] = useState<{ row: WorkSheetRow | null } | null>(null);
  const [typeEditorOpen, setTypeEditorOpen] = useState(false);

  const { state: ui, patchState } = useListUiState<{ activeTab: string; tabs: Record<string, TabUiState> }>('list:workSheets:ui', {
    activeTab: ALL_TAB,
    tabs: {},
  });
  const activeTab = ui.activeTab ?? ALL_TAB;
  const tabUi = (key: string): TabUiState => ({ ...defaultTabUi(), ...(ui.tabs?.[key] ?? {}) });
  const patchTab = (key: string, patch: Partial<TabUiState>) => patchState({ tabs: { ...(ui.tabs ?? {}), [key]: { ...tabUi(key), ...patch } } });

  const refreshTypes = useCallback(async () => {
    const res = await loadWorkSheetTypes();
    setTypes(res.rows);
    setTypesFromCache(res.fromCache);
  }, []);

  const refreshRows = useCallback(async () => {
    try {
      const res = await window.matrica.workSheets.rows.list({ sinceMs: allTime ? null : Date.now() - YEAR_MS });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setRows(res.rows);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [allTime]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshTypes(), refreshRows()]);
  }, [refreshTypes, refreshRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useLiveDataRefresh(refreshRows);

  // Цеха — подписи для колонки и диалогов; прав на справочник может не быть — тогда id.
  useEffect(() => {
    void (async () => {
      try {
        const r = await window.matrica.workshops.list({ activeOnly: true });
        if (r.ok) setWorkshops(r.rows.map((w) => ({ id: String(w.id), label: String(w.name || w.code) })));
      } catch {
        /* без справочника цехов — покажем id */
      }
    })();
  }, []);

  const ensureEngines = useCallback(async () => {
    if (enginesReady) return;
    try {
      setEngines(await window.matrica.engines.list());
    } finally {
      setEnginesReady(true);
    }
  }, [enginesReady]);

  const workshopName = useCallback((id: string) => workshops.find((w) => w.id === id)?.label || id, [workshops]);

  const tabs: CardTab<string>[] = useMemo(
    () => [{ key: ALL_TAB, label: 'Все' }, ...types.map((t) => ({ key: t.code, label: t.name }))],
    [types],
  );
  useEffect(() => {
    if (activeTab !== ALL_TAB && types.length > 0 && !types.some((t) => t.code === activeTab)) patchState({ activeTab: ALL_TAB });
  }, [activeTab, types, patchState]);

  const openNewRow = async () => {
    await ensureEngines();
    setRowDialog({ row: null });
  };
  const openRow = async (row: WorkSheetRow) => {
    if (!props.canEdit) {
      props.onOpenEngine(row.engineId);
      return;
    }
    await ensureEngines();
    setRowDialog({ row });
  };

  const activeType = types.find((t) => t.code === activeTab) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-work-sheets-page>
      <CardTabs tabs={tabs} active={tabs.some((t) => t.key === activeTab) ? activeTab : ALL_TAB} onChange={(key) => patchState({ activeTab: key })} className="" />
      {typesFromCache ? <div className="ui-muted" style={{ fontSize: 12 }}>Список узлов взят из кэша — сервер недоступен, набор может быть устаревшим.</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      {tabs.map((tab) => {
        const type = tab.key === ALL_TAB ? null : types.find((t) => t.code === tab.key) ?? null;
        const tabRows = type ? rows.filter((r) => r.typeCode === type.code) : rows;
        // Обёртка панели — без инлайнового display у скрытой: он бы перебил атрибут hidden (M78).
        return (
          <div key={tab.key} data-card-tab={tab.key} hidden={activeTab !== tab.key} style={{ flex: '1 1 auto', minHeight: 0, ...(activeTab === tab.key ? { display: 'flex', flexDirection: 'column' } : {}) }}>
            <WorkSheetTab
              tabKey={tab.key}
              type={type}
              rows={tabRows}
              ui={tabUi(tab.key)}
              onPatch={(patch) => patchTab(tab.key, patch)}
              workshopName={workshopName}
              canEdit={props.canEdit}
              canManageTypes={props.canManageTypes}
              allTime={allTime}
              onToggleAllTime={() => setAllTime((v) => !v)}
              onAddRow={openNewRow}
              onOpenRow={openRow}
              onEditTypes={() => setTypeEditorOpen(true)}
              onRefresh={refresh}
              active={activeTab === tab.key}
            />
          </div>
        );
      })}

      {rowDialog ? (
        <WorkSheetRowDialog
          types={types}
          initialTypeCode={activeType?.code ?? null}
          row={rowDialog.row}
          engines={engines}
          enginesReady={enginesReady}
          workshops={workshops}
          canDelete={props.canEdit}
          onClose={() => setRowDialog(null)}
          onOpenEngine={props.onOpenEngine}
          onSaved={({ repair, typeName }) => {
            setRowDialog(null);
            void refreshRows();
            if (repair?.applied) setStatus(`Строка «${typeName}» записана; двигателю поставлен «Отремонтирован» датой строки.`);
            else if (repair && repair.reason === 'already-repaired') setStatus(`Строка «${typeName}» записана; двигатель уже был отремонтирован — дата не менялась.`);
            else if (repair && repair.reason === 'scrap-engine') setStatus(`Строка «${typeName}» записана; двигатель в утиле — статус ремонта не трогали.`);
            else setStatus('');
          }}
          onDeleted={() => {
            setRowDialog(null);
            void refreshRows();
          }}
        />
      ) : null}

      {typeEditorOpen ? (
        <WorkSheetTypeEditorDialog
          types={types}
          initialTypeCode={activeType?.code ?? null}
          workshops={workshops}
          onClose={() => setTypeEditorOpen(false)}
          onChanged={refreshTypes}
        />
      ) : null}
    </div>
  );
}

function WorkSheetTab(props: {
  tabKey: string;
  type: WorkSheetType | null;
  rows: WorkSheetRow[];
  ui: TabUiState;
  onPatch: (patch: Partial<TabUiState>) => void;
  workshopName: (id: string) => string;
  canEdit: boolean;
  canManageTypes: boolean;
  allTime: boolean;
  onToggleAllTime: () => void;
  onAddRow: () => void;
  onOpenRow: (row: WorkSheetRow) => void;
  onEditTypes: () => void;
  onRefresh: () => Promise<void>;
  active: boolean;
}) {
  const { type, rows, ui, onPatch, workshopName } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  const columns = useMemo<Column[]>(() => {
    const base: Column[] = [
      { id: 'at', label: 'Дата', kind: 'date', render: (r) => formatMoscowDate(new Date(r.at)), sortValue: (r) => r.at, alwaysVisible: true },
      { id: 'engine', label: 'Двигатель', kind: 'name', render: (r) => engineLabel(r), sortValue: (r) => engineLabel(r), alwaysVisible: true },
      { id: 'brand', label: 'Марка', kind: 'name', render: (r) => r.engineBrand, sortValue: (r) => r.engineBrand },
      { id: 'internal', label: 'Внутр. №', kind: 'num', render: (r) => r.internalNumber, sortValue: (r) => r.internalNumber },
      ...(type ? [] : [{ id: 'type', label: 'Узел', kind: 'name' as ListColumnKind, render: (r: WorkSheetRow) => r.typeName, sortValue: (r: WorkSheetRow) => r.typeName }]),
      { id: 'workshop', label: 'Цех', kind: 'name', render: (r) => (r.workshopId ? workshopName(r.workshopId) : ''), sortValue: (r) => (r.workshopId ? workshopName(r.workshopId) : '') },
    ];
    const dynamic: Column[] = type
      ? type.columns.map((c) => ({
          id: `f:${c.code}`,
          label: c.label,
          kind: (c.type === 'number' ? 'num' : c.type === 'date' ? 'date' : c.type === 'boolean' ? 'flag' : 'text') as ListColumnKind,
          render: (r) => {
            const f = r.fields.find((x) => x.code === c.code);
            return f ? formatWorkSheetValue(f) : '';
          },
          sortValue: (r) => {
            const f = r.fields.find((x) => x.code === c.code);
            return typeof f?.value === 'number' ? f.value : f ? formatWorkSheetValue(f) : '';
          },
        }))
      : [{ id: 'fields', label: 'Поля', kind: 'text', render: (r: WorkSheetRow) => workSheetFieldsSummary(r.fields) }];
    const tail: Column[] = [
      { id: 'performedBy', label: 'Кто', kind: 'name', render: (r) => r.performedBy, sortValue: (r) => r.performedBy },
      { id: 'note', label: 'Примечание', kind: 'text', render: (r) => r.note },
    ];
    return [...base, ...dynamic, ...tail];
  }, [type, workshopName]);

  const columnLayout = useColumnLayout(`list:workSheets:${props.tabKey}:columns`, columns.map((c) => c.id));
  const columnsById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const visibleColumns = useMemo(
    () => columnLayout.order.map((id) => columnsById.get(id)).filter((c): c is Column => Boolean(c) && columnLayout.isVisible(c!.id)),
    [columnLayout, columnsById],
  );

  const facets = useMemo(() => workSheetFacets(type?.columns ?? []) as FacetDescriptor<WorkSheetRow>[], [type]);

  const deep = useListDeepFilter(
    rows,
    (r) => r.id,
    (r) => [engineLabel(r), r.engineBrand, r.internalNumber, r.typeName, r.note, r.performedBy, workSheetFieldsSummary(r.fields)].join(' '),
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

  const toggleSort = (id: string) => onPatch(ui.sortKey === id ? { sortDir: ui.sortDir === 'asc' ? 'desc' : 'asc' } : { sortKey: id, sortDir: id === 'at' ? 'desc' : 'asc' });

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

  const cells = (r: WorkSheetRow) => (
    <>
      {visibleColumns.map((col) => (
        <td key={col.id} {...listCellKindProps(col.kind)} style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>
          {col.render(r)}
        </td>
      ))}
      <td className="list-col-filler" aria-hidden="true" style={{ borderBottom: '1px solid #f3f4f6' }} />
    </>
  );
  const rowProps = (r: WorkSheetRow): VirtualTableRowProps => ({
    onClick: () => props.onOpenRow(r),
    title: props.canEdit ? 'Открыть строку' : 'Открыть карточку двигателя',
    style: { cursor: 'pointer' },
    'data-work-sheet-row': r.id,
  });

  return (
    <div style={{ display: props.active ? 'flex' : undefined, flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageToolbar>
        {props.canEdit && (
          <Button onClick={props.onAddRow} data-work-sheet-add-row>
            Добавить строку
          </Button>
        )}
        <ToolbarPin>
          <Input value={ui.query} onChange={(e) => onPatch({ query: e.target.value })} placeholder="Поиск по строкам ведомости…" />
        </ToolbarPin>
        <ToolbarPin>
          <SearchModeToggle similar={ui.searchSimilar} onToggle={() => onPatch({ searchSimilar: !ui.searchSimilar })} />
        </ToolbarPin>
        <ToolbarPin>
          <FacetToggleButton<WorkSheetRow> facets={facets} selection={ui.facets} open={ui.facetsOpen} onToggle={() => onPatch({ facetsOpen: !ui.facetsOpen })} />
        </ToolbarPin>
        {props.canManageTypes && (
          <Button variant="ghost" onClick={props.onEditTypes} title="Узлы ведомостей: названия, цеха, колонки" data-work-sheet-edit-types>
            {type ? 'Колонки узла' : 'Узлы'}
          </Button>
        )}
        <Button variant="ghost" onClick={props.onToggleAllTime} title="По умолчанию показаны строки за последний год">
          {props.allTime ? 'За год' : 'За всё время'}
        </Button>
        <Button variant="ghost" onClick={() => void props.onRefresh()}>
          Обновить
        </Button>
      </PageToolbar>

      <div style={{ marginTop: 8, flex: '0 0 auto' }}>
        <FacetFilter<WorkSheetRow>
          facets={facets}
          rows={deep.filtered}
          selection={ui.facets}
          fields={ui.facetFields}
          open={ui.facetsOpen}
          onChangeSelection={(next) => onPatch({ facets: next })}
          onChangeFields={(next) => onPatch({ facetFields: next })}
          onReset={() => onPatch({ facets: {}, facetFields: [] })}
          columnsControl={
            <ColumnSettingsButton
              label="Колонки списка"
              columns={columns}
              order={columnLayout.order}
              isVisible={columnLayout.isVisible}
              onToggleVisible={columnLayout.setVisible}
              onMove={columnLayout.moveColumn}
              onReset={columnLayout.resetToDefault}
            />
          }
        />
      </div>

      <ListCount total={rows.length} shown={sorted.length} style={{ marginTop: 6 }} />
      <div ref={containerRef} style={{ marginTop: 2, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <VirtualTable
          scrollElementRef={containerRef}
          count={sorted.length}
          header={header}
          renderCells={(i) => cells(sorted[i]!)}
          getRowKey={(i) => sorted[i]!.id}
          getRowProps={(i) => rowProps(sorted[i]!)}
          colCount={Math.max(1, visibleColumns.length) + 1}
          rowNumbers
          estimateSize={40}
          emptyState={rows.length === 0 ? (type ? `В ведомости «${type.name}» пока нет строк` : 'Строк ведомостей пока нет') : 'Ничего не найдено'}
        />
      </div>
    </div>
  );
}
