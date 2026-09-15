import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  HUMAN_LABEL_DASH,
  HUMAN_LABEL_NO_NUMBER,
  applyFacets,
  workSheetFacets,
  workSheetFieldsSummary,
  type EngineListItem,
  type FacetDescriptor,
  type FacetSelection,
  type WorkSheetRow,
  type WorkSheetType,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { ColumnToggleButton } from '../components/ColumnToggleButton.js';
import { FacetFilter, FacetToggleButton } from '../components/FacetFilter.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { ListPrintDialog } from '../components/ListPrintDialog.js';
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
import { buildListPrintColumns } from '../utils/listPrintColumns.js';
import { loadWorkSheetTypes, type WorkSheetTypesSource } from '../utils/workSheetTypesCache.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { isAndroidPlatform } from '../platform.js';

/**
 * Ведомости работ — ОДИН список, как двигатели и контракты (владелец 15.09.2026).
 *
 * Вкладок по видам работ больше нет: они разрезали экран на копии одного и того же списка,
 * каждая со своим тулбаром, своими ступенями и своей раскладкой колонок, — а отобрать одно
 * значение умеет обычная ступень фильтра. Вид работы стал колонкой и ступенью.
 *
 * «Вид работ» — то, что раньше называлось узлом: укладка вала в картер, сборка, обкатка.
 * Слово сменилось по слову владельца: узлом в программе зовётся сборочная единица
 * (`warehouse.ts`, «№ узла сборки» в дефектовке), и два значения одного слова путали.
 *
 * Строки живут записями истории ремонта (`operations`, см. `workSheetService`), справочник
 * видов работ — серверный REST.
 */

type Column = ColumnDescriptor & {
  kind?: ListColumnKind;
  render: (r: WorkSheetRow) => React.ReactNode;
  sortValue?: (r: WorkSheetRow) => string | number;
  printValue?: (r: WorkSheetRow) => string;
};

type ListUiState = {
  query: string;
  searchSimilar: boolean;
  facets: FacetSelection;
  facetFields: string[];
  facetsOpen: boolean;
  sortKey: string;
  sortDir: 'asc' | 'desc';
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Ступень вида работ: по ней же берётся предвыбор для новой ведомости. */
const TYPE_FACET_ID = 'type';

// Огрызок uuid здесь стоял как «хоть как-то опознать строку» — ровно то, что запрещает
// `humanLabels`: идентификатор не заменяет подпись, а притворяется ею. Двигатель без номера
// называется так же, как в отчётах.
function engineLabel(r: WorkSheetRow): string {
  return r.engineNumber || HUMAN_LABEL_NO_NUMBER;
}

/**
 * Имя цеха: справочник → снимок в строке → прочерк. Справочник спрашивается первым (там имя
 * свежее), снимок выручает, когда справочника нет — прав `masterdata.view` не выдали, клиент
 * офлайн, цех деактивирован (`activeOnly: true` не отдаёт его и онлайн). Uuid не показывается
 * никогда: строку он не опознаёт, а читается как испорченные данные.
 */
function workshopLabel(r: WorkSheetRow, fromDirectory: (id: string) => string): string {
  if (!r.workshopId) return '';
  return fromDirectory(r.workshopId) || r.workshopName || HUMAN_LABEL_DASH;
}

export function WorkSheetsPage(props: { canEdit: boolean; canManageTypes: boolean; onOpenEngine: (id: string) => void }) {
  const [types, setTypes] = useState<WorkSheetType[]>([]);
  const [typesSource, setTypesSource] = useState<WorkSheetTypesSource>('server');
  const [rows, setRows] = useState<WorkSheetRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState('');
  const [allTime, setAllTime] = useState(false);
  const [workshops, setWorkshops] = useState<WorkshopOption[]>([]);
  const [engines, setEngines] = useState<EngineListItem[]>([]);
  const [enginesReady, setEnginesReady] = useState(false);
  const [rowDialog, setRowDialog] = useState<{ row: WorkSheetRow | null } | null>(null);
  const [typeEditorOpen, setTypeEditorOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { state: ui, patchState } = useListUiState<ListUiState>('list:workSheets:ui', {
    query: '',
    searchSimilar: false,
    facets: {},
    facetFields: [],
    facetsOpen: false,
    sortKey: 'at',
    sortDir: 'desc',
  });

  const refreshTypes = useCallback(async () => {
    const res = await loadWorkSheetTypes();
    setTypes(res.rows);
    setTypesSource(res.source);
  }, []);

  const refreshRows = useCallback(async () => {
    try {
      const res = await window.matrica.workSheets.rows.list({ sinceMs: allTime ? null : Date.now() - YEAR_MS });
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
  }, [allTime]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshTypes(), refreshRows()]);
  }, [refreshTypes, refreshRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useLiveDataRefresh(refreshRows);

  // Цеха — подписи для колонки и диалогов; прав на справочник может не быть — тогда снимок строки.
  useEffect(() => {
    void (async () => {
      try {
        const r = await window.matrica.workshops.list({ activeOnly: true });
        if (r.ok) setWorkshops(r.rows.map((w) => ({ id: String(w.id), label: String(w.name || w.code) })));
      } catch {
        /* без справочника цехов возьмём снимок имени из самой строки */
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

  const workshopFromDirectory = useCallback((id: string) => workshops.find((w) => w.id === id)?.label ?? '', [workshops]);

  /**
   * Вид работ для НОВОЙ ведомости: тот, что выбран в фильтре. Мастер отобрал обкатку и жмёт
   * «Добавить» — он заводит обкатку, а не то, что стоит первым в справочнике. Выбрано
   * несколько — берём первый отобранный; не выбрано ничего — решает диалог (первый вид).
   */
  const initialTypeCode = useMemo(() => {
    const selected = ui.facets?.[TYPE_FACET_ID];
    const first = Array.isArray(selected) ? selected.map((v) => String(v)).find(Boolean) : null;
    return first && types.some((t) => t.code === first) ? first : null;
  }, [ui.facets, types]);

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

  const columns = useMemo<Column[]>(
    () => [
      { id: 'at', label: 'Дата', kind: 'date', render: (r) => formatMoscowDate(new Date(r.at)), sortValue: (r) => r.at, alwaysVisible: true },
      { id: 'type', label: 'Вид работ', kind: 'name', render: (r) => r.typeName, sortValue: (r) => r.typeName, alwaysVisible: true },
      { id: 'engine', label: 'Двигатель', kind: 'name', render: (r) => engineLabel(r), sortValue: (r) => engineLabel(r), alwaysVisible: true },
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
      { id: 'workshop', label: 'Цех', kind: 'name', render: (r) => workshopLabel(r, workshopFromDirectory), sortValue: (r) => workshopLabel(r, workshopFromDirectory) },
      // Поля вида работ — одной сводной колонкой: у каждого вида свой набор, и разворачивать
      // их в общем списке значило бы плодить пустые колонки. Сами поля — в строке ведомости.
      { id: 'fields', label: 'Поля', kind: 'text', render: (r) => workSheetFieldsSummary(r.fields) },
      { id: 'performedBy', label: 'Кто', kind: 'name', render: (r) => r.performedBy, sortValue: (r) => r.performedBy },
      { id: 'note', label: 'Примечание', kind: 'text', render: (r) => r.note },
    ],
    [workshopFromDirectory],
  );

  const columnLayout = useColumnLayout('list:workSheets:columns', columns.map((c) => c.id));
  const columnsById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const visibleColumns = useMemo(
    () => columnLayout.order.map((id) => columnsById.get(id)).filter((c): c is Column => Boolean(c) && columnLayout.isVisible(c!.id)),
    [columnLayout, columnsById],
  );

  // Ступени — общие для всего списка: полей вида работ здесь нет (у каждого вида свои),
  // зато есть сам вид работ, заказчик, договор, цех, исполнитель и дата.
  const facets = useMemo(() => workSheetFacets([]) as FacetDescriptor<WorkSheetRow>[], []);

  const deep = useListDeepFilter(
    rows,
    (r) => r.id,
    (r) =>
      [engineLabel(r), r.engineBrand, r.internalNumber, r.typeName, r.customerName, r.contractNumber, r.note, r.performedBy, workSheetFieldsSummary(r.fields)].join(' '),
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

  const toggleSort = (id: string) =>
    patchState(ui.sortKey === id ? { sortDir: ui.sortDir === 'asc' ? 'desc' : 'asc' } : { sortKey: id, sortDir: id === 'at' ? 'desc' : 'asc' });

  const thStyle: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2 };
  const header = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 120%)', color: '#fff' }}>
        <RowNumberHeaderCell style={thStyle} />
        {visibleColumns.map((col) => (
          <th
            key={col.id}
            {...listHeaderKindProps(col.kind, col.label)}
            style={{ ...thStyle, cursor: col.sortValue ? 'pointer' : 'default' }}
            onClick={col.sortValue ? () => toggleSort(col.id) : undefined}
          >
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
    onClick: () => void openRow(r),
    title: props.canEdit ? 'Открыть строку ведомости' : 'Открыть карточку двигателя',
    style: { cursor: 'pointer' },
    'data-work-sheet-row': r.id,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-work-sheets-page>
      <PageToolbar>
        {props.canEdit && (
          <Button onClick={() => void openNewRow()} data-work-sheet-add-row>
            Добавить ведомость
          </Button>
        )}
        <ToolbarPin>
          <Input value={ui.query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по ведомостям…" />
        </ToolbarPin>
        <ToolbarPin>
          <SearchModeToggle similar={ui.searchSimilar} onToggle={() => patchState({ searchSimilar: !ui.searchSimilar })} />
        </ToolbarPin>
        <ToolbarPin>
          <FacetToggleButton<WorkSheetRow> facets={facets} selection={ui.facets} open={ui.facetsOpen} onToggle={() => patchState({ facetsOpen: !ui.facetsOpen })} />
        </ToolbarPin>
        {props.canManageTypes && (
          <Button variant="ghost" onClick={() => setTypeEditorOpen(true)} title="Виды работ: названия, цеха, колонки" data-work-sheet-edit-types>
            Виды работ
          </Button>
        )}
        <Button variant="ghost" onClick={() => setAllTime((v) => !v)} title="По умолчанию показаны ведомости с датой за последний год">
          {allTime ? 'За год' : 'За всё время'}
        </Button>
        {!isAndroidPlatform() && (
          <Button variant="ghost" onClick={() => setPrintOpen(true)} title="Печать текущего списка (по фильтру) с выбором полей">
            Печать списка
          </Button>
        )}
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </PageToolbar>

      {truncated ? (
        <div className="ui-muted" style={{ fontSize: 12 }} data-work-sheet-truncated>
          Показаны не все ведомости: выборка упёрлась в потолок. Счётчик «Всего» считает загруженное, а не всё, что есть, —
          сузьте период кнопкой «За год».
        </div>
      ) : null}
      {typesSource === 'cache' ? (
        <div className="ui-muted" style={{ fontSize: 12 }}>Список видов работ взят из кэша — сервер недоступен, набор может быть устаревшим.</div>
      ) : null}
      {typesSource === 'none' ? (
        <div className="ui-muted" style={{ fontSize: 12 }} data-work-sheet-types-unavailable>
          Справочник видов работ недоступен: сервер не ответил, а на этом устройстве он ещё ни разу не загружался. Ведомости ниже
          читаются как есть — они несут свои поля с собой; завести новую можно будет, когда появится связь.
        </div>
      ) : null}
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
          emptyState={rows.length === 0 ? 'Ведомостей пока нет' : 'Ничего не найдено'}
        />
      </div>

      {/* Диалоги — ВНЕ тулбара: внутри они уехали бы в меню переполнения вместе с кнопкой. */}
      {printOpen ? (
        <ListPrintDialog
          title="Ведомости работ"
          unitLabel="Ведомостей"
          columns={buildListPrintColumns(columns)}
          visibleColumnIds={visibleColumns.map((c) => c.id)}
          rows={sorted}
          selectedRows={[]}
          storageKey="list:workSheets:printFields"
          onClose={() => setPrintOpen(false)}
        />
      ) : null}

      {rowDialog ? (
        <WorkSheetRowDialog
          types={types}
          initialTypeCode={initialTypeCode}
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
            if (repair?.applied) setStatus(`Ведомость «${typeName}» записана; двигателю поставлен «Отремонтирован» датой ведомости.`);
            else if (repair && repair.reason === 'already-repaired') setStatus(`Ведомость «${typeName}» записана; двигатель уже был отремонтирован — дата не менялась.`);
            else if (repair && repair.reason === 'scrap-engine') setStatus(`Ведомость «${typeName}» записана; двигатель в утиле — статус ремонта не трогали.`);
            else setStatus('');
          }}
          onDeleted={({ repairRolledBack, askedRollback, reason }) => {
            setRowDialog(null);
            void refreshRows();
            if (repairRolledBack && reason === 'partial') setStatus('Ведомость удалена; «Отремонтирован» снят — часть отметок с тех пор меняли, их не трогали.');
            else if (repairRolledBack) setStatus('Ведомость удалена; «Отремонтирован» снят, запись о завершении ремонта убрана из истории.');
            else if (askedRollback && reason === 'changed-elsewhere') setStatus('Ведомость удалена; отметку «Отремонтирован» после неё меняли в другом месте — она осталась как есть.');
            else if (askedRollback) setStatus('Ведомость удалена; отметка «Отремонтирован» оставлена.');
            else setStatus('');
          }}
        />
      ) : null}

      {typeEditorOpen ? (
        <WorkSheetTypeEditorDialog
          types={types}
          initialTypeCode={initialTypeCode}
          workshops={workshops}
          onClose={() => setTypeEditorOpen(false)}
          onChanged={async () => {
            await refreshTypes();
          }}
        />
      ) : null}
    </div>
  );
}
