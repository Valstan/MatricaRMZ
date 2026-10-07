import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  HUMAN_LABEL_DASH,
  HUMAN_LABEL_NO_NUMBER,
  applyFacets,
  workSheetFacets,
  workSheetFieldsSummary,
  type FacetDescriptor,
  type FacetSelection,
  type WorkSheetRow,
  type WorkSheetType,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { ColumnToggleButton } from '../components/ColumnToggleButton.js';
import { ColumnResizeHandle, manualThAnchor, manualWidth, manualWidthAttr } from '../components/ColumnResizeHandle.js';
import { FacetFilter, FacetToggleButton } from '../components/FacetFilter.js';
import { EngineQrScanButton } from '../components/EngineQrScanButton.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { ListPrintDialog } from '../components/ListPrintDialog.js';
import { PageToolbar, ToolbarPin } from '../components/PageToolbar.js';
import { RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SearchModeToggle, searchModeOf } from '../components/SearchModeToggle.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { WorkSheetTypeEditorDialog, type WorkshopOption } from '../components/WorkSheetTypeEditorDialog.js';
import { RepairStageTemplateDialog } from '../components/RepairStageTemplateDialog.js';
import { BulkStageAddDialog } from '../components/BulkStageAddDialog.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { useListDeepFilter } from '../hooks/useListDeepFilter.js';
import { useListUiState } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useRepairStageTemplateRefs } from '../hooks/useRepairStageTemplateRefs.js';
import { useWorkSheetTypeRefs } from '../hooks/useWorkSheetTypeRefs.js';
import { listCellKindProps, listHeaderKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';
import { buildListPrintColumns } from '../utils/listPrintColumns.js';
import { loadWorkSheetTypes, type WorkSheetTypesSource } from '../utils/workSheetTypesCache.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { isAndroidPlatform } from '../platform.js';

/**
 * Этапы работ — ОДИН список-сводка, как двигатели и контракты (владелец 15.09.2026).
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
 *
 * Сводка read-only (план unified-repair-stages, шаг 7→8): заполнение — только в карточке
 * двигателя, щелчок по строке открывает карточку этапа (там же удаление и поля вида).
 * Инлайн-редактор списка снят в шаге 8 — заполнение только через карточку этапа.
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

/** Ступень вида работ: по ней же берётся предвыбор для нового этапа работ. */
const TYPE_FACET_ID = 'type';

// Огрызок uuid здесь стоял как «хоть как-то опознать строку» — ровно то, что запрещает
// `humanLabels`: идентификатор не заменяет подпись, а притворяется ею. Двигатель без номера
// называется так же, как в отчётах.
function engineLabel(r: WorkSheetRow): string {
  return r.engineNumber || HUMAN_LABEL_NO_NUMBER;
}

/**
 * Подпись вида работ в списке. Осознанный возврат подписывается прямо здесь: две одинаковые
 * строки за один день законны ТОЛЬКО когда вторая — повторный проход, и это должно быть видно
 * глазом в списке. Иначе отличие, ради которого заведён гейт дублей, существует лишь в базе.
 */
function typeCellLabel(r: WorkSheetRow): string {
  return r.repeatPass >= 2 ? `${r.typeName} · проход ${r.repeatPass}` : r.typeName;
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

export function WorkSheetsPage(props: {
  canManageTypes: boolean;
  canManageStageTemplates: boolean;
  /** Открыть карточку этапа работ. */
  onOpenSheet: (id: string, opts?: { isNew?: boolean; typeCode?: string | null; title?: string }) => void;
  /** Открыть карточку двигателя строки (номер в колонке + щелчок по строке-шаблону). */
  onOpenEngine?: (id: string) => void;
  /** Справочник цехов нужен и карточке — грузим один раз здесь и отдаём наверх. */
  onWorkshopsLoaded?: (rows: WorkshopOption[]) => void;
}) {
  const [types, setTypes] = useState<WorkSheetType[]>([]);
  const [typesSource, setTypesSource] = useState<WorkSheetTypesSource>('server');
  const [rows, setRows] = useState<WorkSheetRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState('');
  const [allTime, setAllTime] = useState(false);
  const [workshops, setWorkshops] = useState<WorkshopOption[]>([]);
  const [typeEditorOpen, setTypeEditorOpen] = useState(false);
  const [stageTemplateEditorOpen, setStageTemplateEditorOpen] = useState(false);
  const [bulkAddOpen, setBulkAddOpen] = useState(false);
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
  useLiveDataRefresh(refreshRows, { enabled: true });

  // Цеха — подписи для колонки и карточки; прав на справочник может не быть — тогда снимок строки.
  const onWorkshopsLoaded = props.onWorkshopsLoaded;
  useEffect(() => {
    void (async () => {
      try {
        const r = await window.matrica.workshops.list({ activeOnly: true });
        if (r.ok) {
          const rows = r.rows.map((w) => ({ id: String(w.id), label: String(w.name || w.code) }));
          setWorkshops(rows);
          onWorkshopsLoaded?.(rows);
        }
      } catch {
        /* без справочника цехов возьмём снимок имени из самой строки */
      }
    })();
  }, [onWorkshopsLoaded]);

  const workshopFromDirectory = useCallback((id: string) => workshops.find((w) => w.id === id)?.label ?? '', [workshops]);

  /**
   * Вид работ для диалога видов: тот, что выбран в фильтре. Выбрано несколько — берём
   * первый отобранный; не выбрано ничего — решает диалог (первый вид).
   */
  const initialTypeCode = useMemo(() => {
    const selected = ui.facets?.[TYPE_FACET_ID];
    const first = Array.isArray(selected) ? selected.map((v) => String(v)).find(Boolean) : null;
    return first && types.some((t) => t.code === first) ? first : null;
  }, [ui.facets, types]);

  const openRow = (row: WorkSheetRow) =>
    props.onOpenSheet(row.id, { title: `${row.typeName}${row.engineNumber ? ` · ${row.engineNumber}` : ''}` });

  const openEngineOf = (row: WorkSheetRow) => {
    if (row.engineId && props.onOpenEngine) props.onOpenEngine(row.engineId);
  };

  const renderEngineCell = useCallback(
    (r: WorkSheetRow) => {
      const label = engineLabel(r);
      if (!r.engineId || !props.onOpenEngine) return label;
      const openEngine = props.onOpenEngine;
      const engineId = r.engineId;
      return (
        <button
          type="button"
          title="Открыть карточку двигателя"
          data-work-sheet-open-engine={engineId}
          onClick={(e) => {
            e.stopPropagation();
            openEngine(engineId);
          }}
          style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--info)', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}
        >
          {label}
        </button>
      );
    },
    [props.onOpenEngine],
  );

  const columns = useMemo<Column[]>(
    () => [
      { id: 'at', label: 'Дата', kind: 'date', render: (r) => formatMoscowDate(new Date(r.at)), sortValue: (r) => r.at, alwaysVisible: true },
      { id: 'type', label: 'Вид работ', kind: 'name', render: typeCellLabel, sortValue: (r) => r.typeName, alwaysVisible: true },
      { id: 'engine', label: 'Двигатель', kind: 'name', render: (r) => renderEngineCell(r), sortValue: (r) => engineLabel(r), alwaysVisible: true },
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
      // их в общем списке значило бы плодить пустые колонки. Сами поля — в строке этапа работ.
      { id: 'fields', label: 'Поля', kind: 'text', render: (r) => workSheetFieldsSummary(r.fields) },
      { id: 'performedBy', label: 'Кто', kind: 'name', render: (r) => r.performedBy, sortValue: (r) => r.performedBy },
      { id: 'note', label: 'Примечание', kind: 'text', render: (r) => r.note },
    ],
    [workshopFromDirectory, renderEngineCell],
  );

  const columnLayout = useColumnLayout('list:workSheets:columns', columns.map((c) => c.id));
  const columnsById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const visibleColumns = useMemo(
    () => columnLayout.order.map((id) => columnsById.get(id)).filter((c): c is Column => Boolean(c) && columnLayout.isVisible(c!.id)),
    [columnLayout, columnsById],
  );

  // Ступени — общие для всего списка: полей вида работ здесь нет (у каждого вида свои),
  // зато есть сам вид работ, заказчик, договор, цех, исполнитель и дата. Плюс движковая
  // («Есть этап») — тот же смысл, что в списке двигателей.
  const sheetTypes = useWorkSheetTypeRefs();
  const stageTemplates = useRepairStageTemplateRefs();
  const facets = useMemo(
    () => workSheetFacets([], { types: sheetTypes, stageTemplates }) as FacetDescriptor<WorkSheetRow>[],
    [sheetTypes, stageTemplates],
  );

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
            {...manualWidthAttr(columnLayout.widthOf(col.id))}
            style={{ ...manualThAnchor(), ...thStyle, cursor: col.sortValue ? 'pointer' : 'default', ...manualWidth(columnLayout.widthOf(col.id)) }}
            onClick={col.sortValue ? () => toggleSort(col.id) : undefined}
          >
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

  const cells = (r: WorkSheetRow) => (
    <>
      {visibleColumns.map((col) => (
        // `data-col-id` — чтобы щелчок по ячейке ставил курсор в ту же колонку в редакторе.
        <td key={col.id} data-col-id={col.id} {...listCellKindProps(col.kind)} style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>
          {col.render(r)}
        </td>
      ))}
      <td className="list-col-filler" aria-hidden="true" style={{ borderBottom: '1px solid #f3f4f6' }} />
    </>
  );
  // Каждая строка кликабельна: строка работ открывает свою карточку (правка, удаление,
  // смена даты), а строка шаблонного этапа из карточки двигателя (origin 'stage') своей
  // карточки не имеет — её щелчок ведёт в карточку двигателя (решение владельца: обе
  // ссылки из списка, номер — тоже ссылка, чтобы не целиться).
  const rowProps = (r: WorkSheetRow): VirtualTableRowProps => {
    if (r.origin === 'stage') {
      return r.engineId && props.onOpenEngine
        ? {
            onClick: () => void openEngineOf(r),
            title: 'Открыть карточку двигателя',
            style: { cursor: 'pointer' },
            'data-work-sheet-row': r.id,
          }
        : {
            title: 'Этап из карточки двигателя — открывается в карточке',
            'data-work-sheet-row': r.id,
          };
    }
    return {
      onClick: () => void openRow(r),
      title: 'Открыть карточку этапа работ',
      style: { cursor: 'pointer' },
      'data-work-sheet-row': r.id,
    };
  };


  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-work-sheets-page>
      <div className="ui-muted" style={{ fontSize: 12, padding: '2px 8px' }}>
        Сводка для просмотра и печати — этапы отмечаются в карточке двигателя (вкладка «История ремонта»)
      </div>
      <PageToolbar>
        <Button onClick={() => setBulkAddOpen(true)} title="Добавить этап на несколько двигателей сразу" data-bulk-stage-add-open>
          Добавить этап
        </Button>
        <ToolbarPin>
          <Input value={ui.query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по этапам работ…" />
        </ToolbarPin>
        <ToolbarPin>
          <EngineQrScanButton onEngineNumber={(n) => patchState({ query: n })} />
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
        {props.canManageTypes && (
          <Button variant="ghost" onClick={() => setTypeEditorOpen(true)} title="Виды работ: названия, цеха, колонки" data-work-sheet-edit-types>
            Виды работ
          </Button>
        )}
        {props.canManageStageTemplates && (
          <Button variant="ghost" onClick={() => setStageTemplateEditorOpen(true)} title="Шаблон этапов ремонта: названия и порядок" data-repair-stage-edit-templates>
            Шаблон этапов
          </Button>
        )}
        <Button variant="ghost" onClick={() => setAllTime((v) => !v)} title="По умолчанию показаны этапы работ с датой за последний год">
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
          Показаны не все этапы работ: выборка упёрлась в потолок. Счётчик «Всего» считает загруженное, а не всё, что есть, —
          сузьте период кнопкой «За год».
        </div>
      ) : null}
      {typesSource === 'cache' ? (
        <div className="ui-muted" style={{ fontSize: 12 }}>Список видов работ взят из кэша — сервер недоступен, набор может быть устаревшим.</div>
      ) : null}
      {typesSource === 'none' ? (
        <div className="ui-muted" style={{ fontSize: 12 }} data-work-sheet-types-unavailable>
          Справочник видов работ недоступен: сервер не ответил, а на этом устройстве он ещё ни разу не загружался. Этапы работ ниже
          читаются как есть — они несут свои поля с собой; завести новый этап работ можно будет, когда появится связь.
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
        />
      </div>

      <ListCount total={rows.length} shown={sorted.length} style={{ marginTop: 6 }} />
      <div ref={containerRef} style={{ marginTop: 2, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <VirtualTable
          scrollElementRef={containerRef}
          count={sorted.length}
          header={header}
          renderCells={(i) => {
            const r = sorted[i];
            if (!r) return null;
            return cells(r);
          }}
          getRowKey={(i) => sorted[i]?.id ?? `gap:${i}`}
          getRowProps={(i) => {
            const r = sorted[i];
            if (!r) return {};
            return rowProps(r);
          }}
          // Номера сквозные 1..N: служебных рядов больше нет.
          rowNumberOf={(i) => (sorted[i] ? i + 1 : null)}
          colCount={Math.max(1, visibleColumns.length) + 1}
          rowNumbers
          estimateSize={40}
          emptyState={rows.length === 0 ? 'Этапов работ пока нет' : 'Ничего не найдено'}
          columnWidths={visibleColumns.map((c) => ({ id: c.id, width: columnLayout.widthOf(c.id) }))}
        />
      </div>

      {/* Диалоги — ВНЕ тулбара: внутри они уехали бы в меню переполнения вместе с кнопкой. */}
      {printOpen ? (
        <ListPrintDialog
          title="Этапы ремонта"
          unitLabel="Этапов работ"
          columns={buildListPrintColumns(columns)}
          visibleColumnIds={visibleColumns.map((c) => c.id)}
          rows={sorted}
          selectedRows={[]}
          storageKey="list:workSheets:printFields"
          onClose={() => setPrintOpen(false)}
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

      {stageTemplateEditorOpen ? (
        <RepairStageTemplateDialog onClose={() => setStageTemplateEditorOpen(false)} onChanged={async () => {}} />
      ) : null}

      {bulkAddOpen ? (
        // Та же дверь, что «Добавить этап ремонта» в карточке двигателя: список этапов —
        // реестр (одни имена в обеих точках). Виды работ ввод этапов не определяют.
        <BulkStageAddDialog
          templates={stageTemplates.filter((t) => t.archivedAt == null).map((t) => ({ code: t.code, name: t.name }))}
          workshops={workshops}
          onClose={() => setBulkAddOpen(false)}
          onAdded={async () => {
            await refreshRows();
          }}
        />
      ) : null}
    </div>
  );
}
