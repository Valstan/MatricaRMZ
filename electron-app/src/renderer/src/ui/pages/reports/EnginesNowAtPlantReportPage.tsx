import React, { useMemo, useRef, useState } from 'react';

import {
  HUMAN_LABEL_DASH,
  applyFacets,
  arrivalMonthGroup,
  daysOnSiteGroup,
  describeFacetSelection,
  engineDaysOnSite,
  engineFacets,
  engineFactoryStage,
  engineFactoryStageOrder,
  engineScrapDate,
  engineStateLabel,
  engineStatusDate,
  flattenGrouped,
  formatEngineFactoryStageLabel,
  isEngineAtPlant,
  isFactoryStageActive,
  isStageEntriesActive,
  plantScrapGroup,
  returnsPass,
  stageByCode,
  stripStageDateWhenWhereNow,
  type EngineFacetSelection,
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
import { resolveWorkshopName, useWorkshopNames } from '../../hooks/useWorkshopNames.js';
import { useRepairStageTemplateRefs } from '../../hooks/useRepairStageTemplateRefs.js';
import { isAndroidPlatform } from '../../platform.js';
import type { ListReportPageProps } from './listReportPages.js';

/**
 * Отчёт «Сейчас на заводе» (владелец 14.10.2026) — обстановка по заводу в укладе списка:
 * вверху панель ступеней, ниже список, который можно разложить по группам. Объединяет
 * прежние «Двигатели на заводе» и «Двигатели на заводе: этапы ремонта» (оба остались
 * алиасами — ярлыки, избранное и история открывают по старым id).
 *
 * Строки — двигатели, что числятся пришедшими и ещё не отправленными (`isEngineAtPlant`).
 * По умолчанию каждый двигатель — одна строка с текущим местом («Где сейчас?»,
 * `engineFactoryStage`: побеждает поздний признак). Вопрос про движение раскрывает
 * двигатель в строки-проходы: выбранные «Все этапы» или период «Даты этапа» показывают
 * точные срезы (строка-проход несёт только свой этап), дубли двигателя в разных группах
 * допускаются. «Где сейчас?» раскрытия не даёт и гасит период.
 *
 * Группировка: по этапу / по заказчику / заказчик → этап / по дате прихода (месяц) /
 * по дням на заводе / по утилю / без. Данные — каталог двигателей приложения, тот же,
 * что у списка «Двигатели»: ничего не строится сервисом, сортировка и ступени считаются
 * на экране. Колонка зовётся «Дата операции», а не «Дата этапа» (владелец 08.10.2026):
 * она показывает дату того события, которым двигатель пришёл в текущую группу.
 */

type Column = ColumnDescriptor & {
  kind?: ListColumnKind;
  render: (e: Row) => React.ReactNode;
  sortValue?: (e: Row) => string | number;
  printValue?: (e: Row) => string;
};

type Row = EngineListItem & { stage: ReturnType<typeof engineFactoryStage>; state: string; daysOnSite: number | null };

type GroupBy = 'stage' | 'customer' | 'customer_stage' | 'arrival' | 'days' | 'scrap' | 'none';

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  stage: 'По этапу',
  customer: 'По заказчику',
  customer_stage: 'Заказчик → этап',
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

/**
 * Ступени отчёта — подмножество ступеней списка двигателей; порядок — как на панели.
 * Про этапы: «Все этапы» (проходил ли) + «Дата этапа» + «Где сейчас?». Ступень
 * «Последний этап» снята 07.10.2026 решением владельца — как в списке двигателей
 * (см. `engineListFacets.ts`). Бывшие тут «Последний этап работ» и «Дата этапа работ»
 * убраны раньше (владелец 01.10.2026): они отвечали на те же вопросы, но про узлы работ.
 */
const FACET_IDS = ['customer', 'contract', 'brand', 'workshop', 'factoryStage', 'hasRepeatPass', 'hasStage', 'stageDate', 'scrap', 'reclamation', 'arrivalYear', 'arrival', 'arrivalDate'] as const;

const REPORT_HIDDEN_BY_DEFAULT = ['state', 'contract', 'historyAt', 'repairStartedAt', 'repairedAt', 'scrapAt'];

function text(v: unknown): string {
  return String(v ?? '').trim();
}

function fmtDate(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? formatMoscowDate(ms) : HUMAN_LABEL_DASH;
}

function yesNo(v: boolean | undefined): string {
  return v ? 'Да' : 'Нет';
}

export function EnginesNowAtPlantReportPage(props: ListReportPageProps) {
  // Справочник видов работ задаёт порядок групп-этапов и полный ряд ступени «Где сейчас?»;
  // без него (офлайн, нет кэша) этап всё равно узнаётся по самой записи этапа работ.
  const types = useWorkSheetTypeRefs();
  const stageTemplates = useRepairStageTemplateRefs();
  // Цех — из того же справочника, что список двигателей: строка несёт id последнего
  // события истории, имя подставляем здесь (справочник поверх снимка строки).
  // Без этого колонка «Цех» была пустой, а ступень «Цех» — «без названия».
  const workshopNameById = useWorkshopNames();
  const [printOpen, setPrintOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { state: ui, patchState } = useListUiState<ListUiState>('report:enginesNowAtPlant:ui', {
    query: '',
    searchSimilar: false,
    facets: {},
    facetFields: ['factoryStage'],
    facetsOpen: true,
    sortKey: 'engineNumber',
    sortDir: 'asc',
    groupBy: 'stage',
  });

  // Отбор с учётом гейта «Где сейчас?»: старое сохранённое состояние могло держать
  // период вместе с «где» — чистим при чтении, а не только при смене выбора.
  const activeFacets = useMemo(
    () => stripStageDateWhenWhereNow(ui.facets as EngineFacetSelection) as FacetSelection,
    [ui.facets],
  );
  const whereNowActive = isFactoryStageActive(activeFacets as EngineFacetSelection);
  // Раскрытие в проходы — только вопрос про движение («Все этапы» / «Дата этапа»).
  const entriesActive = isStageEntriesActive(activeFacets as EngineFacetSelection);

  const rows = useMemo<Row[]>(
    () => {
      const now = Date.now();
      const expand = entriesActive;
      // Выбранные срезы «Всех этапов» (без префикса, без «этапов нет»): строка обязана
      // показать РОВНО их — иначе в срез «Укладка» попадают двигатели с чужим текущим
      // этапом (жалоба владельца 14.10.2026).
      const picked = activeFacets as EngineFacetSelection;
      const pickedCodes = (Array.isArray(picked.hasStage) ? picked.hasStage : [])
        .filter((v): v is string => typeof v === 'string' && v.startsWith('stage:'))
        .map((v) => v.slice('stage:'.length).trim().toLowerCase())
        .filter(Boolean);
      return props.engines
        .filter(isEngineAtPlant)
        .flatMap((e) => {
          const name = resolveWorkshopName(workshopNameById, e.workshopId, e.workshopName);
          const withName = name && name !== e.workshopName ? { ...e, workshopName: name } : e;
          const stage = engineFactoryStage(withName, types, stageTemplates);
          // base для раскрытия: гарантируем наличие stageCodes/stageDates для типизации
          const base = {
            ...withName,
            stage,
            state: engineStateLabel(withName),
            daysOnSite: engineDaysOnSite(withName, now),
            stageCodes: withName.stageCodes ?? [],
            stageDates: withName.stageDates ?? {},
          };

          // Строка-проход несёт ТОЛЬКО свой этап (`stageCodes: [code]`): выбор «Укладка вала»
          // в «Всех этапах» показывает один этот срез, а не все проходы двигателей, у которых
          // укладка когда-то была (владелец 14.10.2026 — «фильтры должны быть точными»).
          // Несколько выбранных этапов — несколько срезов; дубли двигателя в разных группах
          // допускаются. Без вопроса про движение — одна строка на двигатель с текущим местом.
          const entries = expand ? (withName.stageEntries ?? []) : [];
          if (entries.length > 0) {
            return entries.map((entry) => ({
              ...base,
              stageCodes: [entry.code], // для фасета hasStage — точный срез
              stageDates: { [entry.code]: entry.at }, // для колонки «Дата этапа» этого среза
              lastStageAt: entry.at, // для фасета stageDate (дата конкретного прохождения)
              id: `${withName.id}::${entry.code}::${entry.at}::${entry.pass}`,
              stage: {
                key: `stage:${entry.code}`,
                label: entry.name,
                rank: engineFactoryStageOrder(types, stageTemplates).find((s) => s.key === `stage:${entry.code}`)?.rank ?? 10,
                at: entry.at,
                repeatPass: entry.pass,
              },
            }));
          }
          // Проходов в едином списке нет (старая история, актовые этапы), но двигатель этап
          // проходил: показываем его ОДНОЙ строкой НА ВЫБРАННЫЙ этап с датой прохождения —
          // а не с текущим местом, которое к срезу отношения не имеет. Проход последнего
          // этапа помечаем возвратом, как в раскрытых строках.
          if (expand && pickedCodes.length > 0) {
            const passed = new Set((withName.stageCodes ?? []).map((c) => String(c).trim().toLowerCase()));
            const lastCode = String(withName.lastStageCode ?? '').trim().toLowerCase();
            const slices = pickedCodes
              .filter((code) => passed.has(code))
              .map((code) => {
                const at = withName.stageDates?.[code] ?? null;
                const atMs = typeof at === 'number' && at > 0 ? at : null;
                const sliceAt = atMs ?? withName.lastStageAt;
                return {
                  ...base,
                  stageCodes: [code], // для фасета hasStage — точный срез
                  ...(sliceAt != null ? { lastStageAt: sliceAt } : {}),
                  id: `${withName.id}::${code}`,
                  stage: {
                    key: `stage:${code}`,
                    label: stageByCode(code, stageTemplates)?.name ?? code,
                    rank: engineFactoryStageOrder(types, stageTemplates).find((s) => s.key === `stage:${code}`)?.rank ?? 10,
                    at: atMs,
                    repeatPass: code === lastCode ? returnsPass(withName) : 1,
                  },
                };
              });
            if (slices.length > 0) return slices;
          }
          return [base];
        });
    },
    [props.engines, types, stageTemplates, workshopNameById, entriesActive, activeFacets],
  );

  const columns = useMemo<Column[]>(
    () => [
      { id: 'engineNumber', label: 'Номер', kind: 'name', render: (e) => text(e.engineNumber) || HUMAN_LABEL_DASH, sortValue: (e) => text(e.engineNumber), alwaysVisible: true },
      { id: 'internal', label: 'Внутр. №', kind: 'num', render: (e) => text(e.internalNumberFull), sortValue: (e) => text(e.internalNumberFull) },
      { id: 'brand', label: 'Марка', kind: 'name', render: (e) => text(e.engineBrand), sortValue: (e) => text(e.engineBrand) },
      { id: 'customer', label: 'Заказчик', kind: 'name', render: (e) => text(e.customerName), sortValue: (e) => text(e.customerName) },
      { id: 'contract', label: 'Договор', kind: 'name', render: (e) => text(e.contractName), sortValue: (e) => text(e.contractName) },
      { id: 'workshop', label: 'Цех', kind: 'name', render: (e) => text(e.workshopName) || HUMAN_LABEL_DASH, sortValue: (e) => text(e.workshopName) },
      { id: 'arrivalDate', label: 'Дата прихода', kind: 'date', render: (e) => fmtDate(e.arrivalDate), sortValue: (e) => e.arrivalDate ?? 0 },
      // Повторный заход виден суффиксом «· возврат» в подписи (B4) — в поиск
      // добавляем слово явно, иначе по «возврат» повторные строки не найдутся.
      { id: 'stage', label: 'Где сейчас?', kind: 'name', render: (e) => formatEngineFactoryStageLabel(e.stage), sortValue: (e) => e.stage.rank, alwaysVisible: true },
      { id: 'stageAt', label: 'Дата операции', kind: 'date', render: (e) => fmtDate(e.stage.at), sortValue: (e) => e.stage.at ?? 0 },
      { id: 'daysOnSite', label: 'Дней на заводе', kind: 'num', render: (e) => (e.daysOnSite == null ? HUMAN_LABEL_DASH : String(e.daysOnSite)), sortValue: (e) => e.daysOnSite ?? -1 },
      { id: 'scrap', label: 'Утиль', kind: 'text', render: (e) => yesNo(e.isScrap), sortValue: (e) => (e.isScrap ? 1 : 0) },
      { id: 'state', label: 'Состояние', kind: 'name', render: (e) => e.state, sortValue: (e) => e.state },
      { id: 'repairStartedAt', label: 'Ремонт начат', kind: 'date', render: (e) => fmtDate(engineStatusDate(e, 'status_repair_started')), sortValue: (e) => engineStatusDate(e, 'status_repair_started') ?? 0 },
      { id: 'repairedAt', label: 'Отремонтирован', kind: 'date', render: (e) => fmtDate(engineStatusDate(e, 'status_repaired')), sortValue: (e) => engineStatusDate(e, 'status_repaired') ?? 0 },
      { id: 'scrapAt', label: 'Дата утиля', kind: 'date', render: (e) => fmtDate(engineScrapDate(e)), sortValue: (e) => engineScrapDate(e) ?? 0 },
      // Колонки «Последний этап» здесь нет (владелец 08.10.2026): «Где сейчас?» уже
      // показывает, где двигатель по последней записи (и учитывает больше — утиль, возвраты,
      // акты); вторая колонка с тем же смыслом читалась вторым фактом.
    ],
    [],
  );

  const columnLayout = useColumnLayout(
    'report:enginesNowAtPlant:columns',
    columns.map((c) => c.id),
    REPORT_HIDDEN_BY_DEFAULT,
  );
  const columnsById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const visibleColumns = useMemo(
    () => columnLayout.order.map((id) => columnsById.get(id)).filter((c): c is Column => Boolean(c) && columnLayout.isVisible(c!.id)),
    [columnLayout, columnsById],
  );

  // «Где сейчас?» гасит «Дату этапа» (владелец 14.10.2026): текущее место двигателя
  // и период — разные вопросы, ступень периода при активном «где» прячется и чистится.
  const onChangeFacets = (next: FacetSelection) =>
    patchState({ facets: stripStageDateWhenWhereNow(next as EngineFacetSelection) as FacetSelection });
  const visibleFacetFields = whereNowActive ? ui.facetFields.filter((f) => f !== 'stageDate') : ui.facetFields;

  const facets = useMemo(() => {
    const all = engineFacets(types, stageTemplates);
    const ids = whereNowActive ? FACET_IDS.filter((id) => id !== 'stageDate') : FACET_IDS;
    return ids.map((id) => all.find((f) => f.id === id)).filter(Boolean) as FacetDescriptor<Row>[];
  }, [types, stageTemplates, whereNowActive]);

  const deep = useListDeepFilter(
    rows,
    (r) => r.id,
    (r) => [r.engineNumber, r.internalNumberFull, r.engineBrand, r.customerName, r.contractName, r.workshopName, r.stage.label, r.stage.repeatPass >= 2 ? 'возврат' : '', r.state, r.lastSheetNode, r.lastHistoryAction].map(text).join(' '),
    ui.query,
    { entityBacked: false, mode: searchModeOf(ui.searchSimilar) },
  );
  const faceted = useMemo(() => applyFacets(facets, deep.filtered, activeFacets), [facets, deep.filtered, activeFacets]);
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
      case 'customer_stage':
        return [byCustomer, byStage];
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-engines-now-at-plant-report>
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
          <FacetToggleButton<Row> facets={facets} selection={activeFacets} open={ui.facetsOpen} onToggle={() => patchState({ facetsOpen: !ui.facetsOpen })} />
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
          selection={activeFacets}
          fields={visibleFacetFields}
          open={ui.facetsOpen}
          onChangeSelection={onChangeFacets}
          onChangeFields={(next) => patchState({ facetFields: next })}
          onReset={() => patchState({ facets: {}, facetFields: [] })}
        />
        {whereNowActive ? (
          <div className="ui-muted" style={{ fontSize: 12, marginTop: 4 }}>
            «Где сейчас?» показывает текущее место каждого двигателя одной строкой — период («Дата этапа») при нём не нужен и скрыт.
          </div>
        ) : null}
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
          title="Сейчас на заводе"
          columns={buildListPrintColumns(columns)}
          visibleColumnIds={visibleColumns.map((c) => c.id)}
          rows={sorted.length > 0 ? items.filter((it) => it.kind === 'row').map((it) => (it.kind === 'row' ? it.row : null)!).filter(Boolean) : []}
          selectedRows={[]}
          storageKey="report:enginesNowAtPlant:printFields"
          rowGroupLabel={(r) => groupLabelByRow.get(r.id) || null}
          filtersSummary={describeFacetSelection(facets, activeFacets, {
            search: ui.query,
            grouping: ui.groupBy === 'none' ? '' : GROUP_BY_LABELS[ui.groupBy],
          })}
          onClose={() => setPrintOpen(false)}
        />
      ) : null}
    </div>
  );
}
