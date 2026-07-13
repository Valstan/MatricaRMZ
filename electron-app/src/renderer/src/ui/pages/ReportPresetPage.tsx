import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReportCellValue,
  ReportFilterOption,
  ReportFilterSpec,
  ReportOptionSource,
  ReportPresetDefinition,
  ReportPresetFilters,
  ReportPresetFilterTemplate,
  ReportPresetId,
  ReportPresetPreviewResult,
} from '@matricarmz/shared';
import { formatWorkOrdersStatusCountsLine, WORK_ORDERS_STATUS_COUNT_LABELS } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { AssemblyForecastReportView } from '../components/AssemblyForecastReportView.js';
import { SectionCard } from '../components/SectionCard.js';
import { openPrintPreview } from '../utils/printPreview.js';
import {
  binaryDownloadBase64,
  buildDefaultFilters,
  omitDisabledFilterKeys,
  buildReportPrintPreviewSections,
  csvDownload,
  endOfDayMs,
  formatReportCell,
  formatReportTotals,
  fromInputDate,
  startOfDayMs,
  textDownload,
  toInputDate,
} from '../utils/reportUtils.js';
import { renderWorkOrderPayrollFormInnerHtml } from '../utils/workOrderPayrollReportLayoutHtml.js';

type PreviewOk = Extract<ReportPresetPreviewResult, { ok: true }>;

const DATE_PERIOD_PRESETS: { label: string; title: string; days?: number; months?: number }[] = [
  { label: 'Нед.', title: 'Неделя', days: 7 },
  { label: '2 нед.', title: '2 недели', days: 14 },
  { label: 'Мес.', title: 'Месяц', months: 1 },
  { label: '2 мес.', title: '2 месяца', months: 2 },
  { label: '3 мес.', title: '3 месяца', months: 3 },
  { label: '½ года', title: 'Полгода', months: 6 },
  { label: 'Год', title: 'Год', months: 12 },
];

const filterResetBtnStyle: React.CSSProperties = {
  padding: '2px 6px',
  border: '1px solid var(--button-ghost-border)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: 11,
  lineHeight: 1,
};

const periodBtnStyle: React.CSSProperties = {
  padding: '2px 6px',
  border: '1px solid var(--button-ghost-border)',
  borderRadius: 6,
  background: 'var(--button-ghost-bg)',
  color: 'var(--text)',
  cursor: 'pointer',
  fontSize: 11,
};

const selectedTagStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: 4,
  background: 'rgba(96, 165, 250, 0.14)',
  color: 'var(--text)',
  fontSize: 11,
  maxWidth: 200,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function filterLabelHint(filter: ReportFilterSpec): string | undefined {
  return 'labelHint' in filter && filter.labelHint ? filter.labelHint : undefined;
}

// Stage 3 нитки assembly-work-order-from-forecast: localStorage-кеш «Прогноза сборки
// двигателей». Сохраняется последний preview + filtersKey того прогноза. Переживает
// navigate away и restart приложения. Применяется только к assembly_forecast_7d —
// другие пресеты продолжают auto-build по filtersKey.
const ASSEMBLY_FORECAST_PRESET_ID = 'assembly_forecast_7d';
const ASSEMBLY_FORECAST_CACHE_KEY = 'matrica.reports.persistedPreview.assembly_forecast_7d';

export function ReportPresetPage(props: {
  presetId: ReportPresetId;
  canExport: boolean;
  userId: string;
  onBack: () => void;
  /** Stage 4 нитки assembly-work-order-from-forecast: callback для перехода в карточку наряда,
   * созданного через «Создать наряд на сборку» в Прогнозе сборки двигателей. */
  onOpenWorkOrder?: (operationId: string) => void;
  /** Ф2 forecast-remfond-aware: открыть карточку заявки в снабжение, созданной из дефицитов прогноза. */
  onOpenSupplyRequest?: (id: string, payload: unknown) => void;
}) {
  const [presets, setPresets] = useState<ReportPresetDefinition[]>([]);
  const [optionSets, setOptionSets] = useState<Partial<Record<ReportOptionSource, ReportFilterOption[]>>>({});
  const [filtersByPreset, setFiltersByPreset] = useState<Partial<Record<ReportPresetId, ReportPresetFilters>>>({});
  // Ф4: отключённые фильтры (кнопка «выкл» у фильтра) — по пресету, набор filter.key.
  // Отключённый фильтр не участвует в отборе (его ключи вырезаются из payload).
  const [disabledFiltersByPreset, setDisabledFiltersByPreset] = useState<Partial<Record<ReportPresetId, string[]>>>({});
  const [filterSearchByPreset, setFilterSearchByPreset] = useState<Partial<Record<ReportPresetId, Record<string, string>>>>({});
  // Именованные шаблоны фильтров (per-user, per-preset) — чтобы не выставлять одни
  // и те же фильтры каждый раз. Хранятся в локальном sys-store (как favorites/history).
  const [filterTemplates, setFilterTemplates] = useState<ReportPresetFilterTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [preview, setPreview] = useState<PreviewOk | null>(null);
  // filtersKey, под который был сформирован последний preview. Используется для
  // индикатора «фильтры изменились — нажмите Сформировать прогноз». Только для
  // assembly_forecast_7d (для остальных пресетов всё ещё auto-build).
  const [cachedFiltersKey, setCachedFiltersKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const buildPreviewRef = useRef<() => Promise<PreviewOk | null>>(async () => null);

  const activePreset = useMemo(
    () => presets.find((preset) => preset.id === props.presetId) ?? null,
    [presets, props.presetId],
  );
  const activeFilters = useMemo(() => {
    if (!activePreset) return {};
    return filtersByPreset[activePreset.id] ?? buildDefaultFilters(activePreset);
  }, [activePreset, filtersByPreset]);
  const activeFilterSearch = useMemo(() => {
    if (!activePreset) return {};
    return filterSearchByPreset[activePreset.id] ?? {};
  }, [activePreset, filterSearchByPreset]);

  const activeDisabled = useMemo(
    () => (activePreset ? disabledFiltersByPreset[activePreset.id] ?? [] : []),
    [activePreset, disabledFiltersByPreset],
  );
  // Payload для backend: без ключей отключённых фильтров (Ф4). UI-инпуты по-прежнему
  // биндятся к activeFilters (значения сохраняются), в отбор идёт requestFilters.
  const requestFilters = useMemo(
    () => (activePreset ? omitDisabledFilterKeys(activePreset, activeFilters, activeDisabled) : activeFilters),
    [activePreset, activeFilters, activeDisabled],
  );

  const activePresetId = activePreset?.id;
  // filtersKey строится по requestFilters → переключение «выкл/вкл» фильтра
  // перезапускает auto-build и меняет индикатор «фильтры изменились».
  const filtersKey = JSON.stringify(requestFilters);

  function toggleFilterDisabled(filter: ReportFilterSpec) {
    if (!activePreset) return;
    setDisabledFiltersByPreset((prev) => {
      const cur = prev[activePreset.id] ?? [];
      const next = cur.includes(filter.key) ? cur.filter((k) => k !== filter.key) : [...cur, filter.key];
      return { ...prev, [activePreset.id]: next };
    });
  }

  function patchFilter(key: string, value: unknown) {
    if (!activePreset) return;
    setFiltersByPreset((prev) => {
      const current = prev[activePreset.id] ?? buildDefaultFilters(activePreset);
      return { ...prev, [activePreset.id]: { ...current, [key]: value } };
    });
  }

  function patchFilterSearch(key: string, value: string) {
    if (!activePreset) return;
    setFilterSearchByPreset((prev) => {
      const current = prev[activePreset.id] ?? {};
      return { ...prev, [activePreset.id]: { ...current, [key]: value } };
    });
  }

  function resetFilter(filter: ReportFilterSpec) {
    if (!activePreset) return;
    const defaults = buildDefaultFilters(activePreset);
    if (filter.type === 'date_range') {
      patchFilter(filter.startKey, defaults[filter.startKey] ?? null);
      patchFilter(filter.endKey, defaults[filter.endKey] ?? null);
    } else if (filter.type === 'multi_select') {
      patchFilter(filter.key, Array.isArray(defaults[filter.key]) ? (defaults[filter.key] as string[]) : []);
    } else if (filter.type === 'number') {
      const d = defaults[filter.key];
      patchFilter(filter.key, typeof d === 'number' ? d : filter.defaultValue ?? 0);
    } else if (filter.type === 'text') {
      const d = defaults[filter.key];
      patchFilter(filter.key, typeof d === 'string' ? d : filter.defaultValue ?? '');
    } else if (filter.type === 'checkbox') {
      patchFilter(filter.key, Boolean(defaults[filter.key]));
    } else if (filter.type === 'select') {
      patchFilter(filter.key, defaults[filter.key] ?? filter.options?.[0]?.value ?? '');
    }
  }

  function resetAllFilters() {
    if (!activePreset) return;
    setFiltersByPreset((prev) => ({ ...prev, [activePreset.id]: buildDefaultFilters(activePreset) }));
  }

  useEffect(() => {
    setFilterTemplates([]);
    setSelectedTemplateId(null);
    setTemplateName('');
    if (!activePresetId) return;
    let alive = true;
    void window.matrica.reports
      .filterTemplatesList({ userId: props.userId, presetId: activePresetId })
      .then((r) => {
        if (alive && r.ok) setFilterTemplates(r.templates);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activePresetId, props.userId]);

  function applyFilterTemplate(templateId: string | null) {
    setSelectedTemplateId(templateId);
    if (!activePreset || !templateId) return;
    const tpl = filterTemplates.find((t) => t.id === templateId);
    if (!tpl) return;
    // Дефолты + сохранённые значения: фильтры, добавленные после сохранения шаблона,
    // получают дефолт, а не «дырку».
    setFiltersByPreset((prev) => ({ ...prev, [activePreset.id]: { ...buildDefaultFilters(activePreset), ...tpl.filters } }));
    setDisabledFiltersByPreset((prev) => ({ ...prev, [activePreset.id]: [...tpl.disabled] }));
    setTemplateName(tpl.name);
  }

  async function saveFilterTemplate() {
    if (!activePreset) return;
    const name = templateName.trim();
    if (!name) return;
    const r = await window.matrica.reports.filterTemplateSave({
      userId: props.userId,
      presetId: activePreset.id,
      template: { name, filters: activeFilters, disabled: activeDisabled },
    });
    if (!r.ok) {
      setStatus(`Ошибка сохранения шаблона: ${r.error}`);
      return;
    }
    setFilterTemplates(r.templates);
    setSelectedTemplateId(r.templates.find((t) => t.name === name)?.id ?? null);
    setStatus(`Шаблон «${name}» сохранён`);
  }

  async function deleteFilterTemplate() {
    if (!activePreset || !selectedTemplateId) return;
    const tpl = filterTemplates.find((t) => t.id === selectedTemplateId);
    const r = await window.matrica.reports.filterTemplateDelete({
      userId: props.userId,
      presetId: activePreset.id,
      templateId: selectedTemplateId,
    });
    if (!r.ok) {
      setStatus(`Ошибка удаления шаблона: ${r.error}`);
      return;
    }
    setFilterTemplates(r.templates);
    setSelectedTemplateId(null);
    setTemplateName('');
    if (tpl) setStatus(`Шаблон «${tpl.name}» удалён`);
  }

  function applyDatePreset(filter: Extract<ReportFilterSpec, { type: 'date_range' }>, preset: (typeof DATE_PERIOD_PRESETS)[number]) {
    const now = new Date();
    const start = new Date(now);
    if (preset.months) start.setMonth(start.getMonth() - preset.months);
    else if (preset.days) start.setDate(start.getDate() - preset.days);
    patchFilter(filter.startKey, startOfDayMs(start));
    patchFilter(filter.endKey, endOfDayMs(now));
  }

  async function loadPresetMeta() {
    setBusy(true);
    setStatus('Загрузка шаблона...');
    try {
      const result = await window.matrica.reports.presetList();
      if (!result?.ok) {
        setStatus(`Ошибка: ${result?.error ?? 'unknown'}`);
        return;
      }
      setPresets(result.presets);
      setOptionSets(result.optionSets ?? {});
      setFiltersByPreset((prev) => {
        const next = { ...prev };
        for (const preset of result.presets) {
          if (!next[preset.id]) next[preset.id] = buildDefaultFilters(preset);
        }
        return next;
      });
      if (!result.presets.some((preset) => preset.id === props.presetId)) {
        setStatus('Шаблон отчёта не найден.');
      } else {
        setStatus('');
      }
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadPresetMeta();
  }, []);

  useEffect(() => {
    if (!activePreset) return;
    setFiltersByPreset((prev) => {
      const current = prev[activePreset.id] ?? buildDefaultFilters(activePreset);
      let changed = false;
      const next: ReportPresetFilters = { ...current };
      for (const filter of activePreset.filters) {
        if (filter.type !== 'multi_select' || !filter.selectAllByDefault) continue;
        const currentValues = Array.isArray(next[filter.key]) ? (next[filter.key] as unknown[]).map(String).filter(Boolean) : [];
        if (currentValues.length > 0) continue;
        const options = filter.optionsSource ? optionSets[filter.optionsSource] ?? [] : filter.options ?? [];
        const allValues = options.map((option) => String(option.value)).filter(Boolean);
        if (allValues.length === 0) continue;
        next[filter.key] = allValues;
        changed = true;
      }
      if (!changed) return prev;
      return { ...prev, [activePreset.id]: next };
    });
  }, [activePreset, optionSets]);

  useEffect(() => {
    setPreview(null);
    setStatus('');
    setCachedFiltersKey(null);
  }, [props.presetId]);

  async function appendHistory(report: PreviewOk) {
    try {
      await window.matrica.reports.historyAdd({
        userId: props.userId,
        entry: {
          presetId: report.presetId,
          title: report.title,
          generatedAt: report.generatedAt,
        },
      });
    } catch {
      // History persistence should not block report generation.
    }
  }

  async function buildPreview() {
    if (!activePreset) return null;
    setBusy(true);
    setStatus('Формирование отчета...');
    try {
      const result = await window.matrica.reports.presetPreview({
        presetId: activePreset.id,
        filters: requestFilters,
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${result?.error ?? 'unknown'}`);
        setPreview(null);
        return null;
      }
      setPreview(result);
      setStatus(`Сформировано строк: ${result.rows.length}`);
      // Отчёты строятся только по кнопке: помним filtersKey построенного отчёта,
      // чтобы показать «фильтры изменились» после правки фильтров.
      setCachedFiltersKey(filtersKey);
      // Stage 3: для прогноза сборки дополнительно persist в localStorage,
      // чтобы при следующем открытии страницы (или после navigate away/restart)
      // восстановить состояние без принудительной регенерации.
      if (activePreset.id === ASSEMBLY_FORECAST_PRESET_ID) {
        try {
          localStorage.setItem(
            ASSEMBLY_FORECAST_CACHE_KEY,
            JSON.stringify({ filtersKey, preview: result, generatedAt: Date.now() }),
          );
        } catch {
          // QuotaExceeded — кеш просто не сохранится, ошибку не пробрасываем.
        }
      }
      void appendHistory(result);
      return result;
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
      setPreview(null);
      return null;
    } finally {
      setBusy(false);
    }
  }

  buildPreviewRef.current = buildPreview;

  // Stage 3: восстановление кеша «Прогноза сборки» из localStorage при первом
  // открытии страницы или возврате к этому пресету. Кеш переживает navigate away
  // и restart. Если фильтры с момента кеша изменились, оператор увидит индикатор.
  useEffect(() => {
    if (activePresetId !== ASSEMBLY_FORECAST_PRESET_ID) return;
    try {
      const raw = localStorage.getItem(ASSEMBLY_FORECAST_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { filtersKey?: string; preview?: PreviewOk; generatedAt?: number };
      if (parsed && parsed.preview && typeof parsed.filtersKey === 'string') {
        setPreview(parsed.preview);
        setCachedFiltersKey(parsed.filtersKey);
        const ts = typeof parsed.generatedAt === 'number' ? new Date(parsed.generatedAt).toLocaleString('ru-RU') : '';
        setStatus(ts ? `Загружен сохранённый прогноз от ${ts}.` : 'Загружен сохранённый прогноз.');
      }
    } catch {
      // Битый кеш — игнорируем, оператор пересформирует.
    }
  }, [activePresetId]);

  async function openPreviewWindow() {
    const report = preview ?? (await buildPreview());
    if (!report) return;
    openPrintPreview({
      title: report.title,
      ...(report.subtitle ? { subtitle: report.subtitle } : {}),
      sections: buildReportPrintPreviewSections(report),
    });
  }

  async function runPrint() {
    if (!activePreset) return;
    setBusy(true);
    setStatus('Отправка на печать...');
    try {
      const result = await window.matrica.reports.presetPrint({
        presetId: activePreset.id,
        filters: requestFilters,
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${result?.error ?? 'unknown'}`);
        return;
      }
      setStatus('Диалог печати открыт.');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function savePdf() {
    if (!activePreset) return;
    setBusy(true);
    setStatus('Подготовка PDF...');
    try {
      const result = await window.matrica.reports.presetPdf({
        presetId: activePreset.id,
        filters: requestFilters,
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${result?.error ?? 'unknown'}`);
        return;
      }
      binaryDownloadBase64(result.contentBase64, result.fileName, result.mime);
      setStatus('PDF сохранен.');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveCsv() {
    if (!activePreset) return;
    setBusy(true);
    setStatus('Подготовка CSV...');
    try {
      const result = await window.matrica.reports.presetCsv({
        presetId: activePreset.id,
        filters: requestFilters,
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${result?.error ?? 'unknown'}`);
        return;
      }
      csvDownload(result.csv, result.fileName);
      setStatus('CSV сохранен.');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function save1cXml() {
    if (!activePreset) return;
    setBusy(true);
    setStatus('Подготовка выгрузки 1С (XML)...');
    try {
      const result = await window.matrica.reports.preset1cXml({
        presetId: activePreset.id,
        filters: requestFilters,
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${result?.error ?? 'unknown'}`);
        return;
      }
      textDownload(result.xml, result.fileName, result.mime);
      setStatus('XML для 1С сохранен.');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const filterGroups = useMemo(() => {
    if (!activePreset) return { selection: [] as ReportFilterSpec[], settings: [] as ReportFilterSpec[] };
    const isSetting = (filter: ReportFilterSpec) => filter.type === 'number' || filter.type === 'text' || filter.type === 'checkbox';
    return {
      selection: activePreset.filters.filter((f) => !isSetting(f)),
      settings: activePreset.filters.filter((f) => isSetting(f)),
    };
  }, [activePreset]);

  function renderAssemblyForecastFilters() {
    if (!activePreset || activePreset.id !== 'assembly_forecast_7d') return null;
    const filterOf = (key: string) => activePreset.filters.find((fl) => 'key' in fl && (fl as { key: string }).key === key) as ReportFilterSpec | undefined;
    const prio = filterOf('assemblyPriorityMode');
    const contF = filterOf('assemblyContractIds');
    const whF = filterOf('warehouseIds');
    const engF = filterOf('engineBrandIds');
    const priF = filterOf('priorityEngineBrandIds');
    const onSiteF = filterOf('assemblyForecastOnSiteOnly');
    const tgtF = filterOf('targetEnginesPerDay');
    const batchF = filterOf('sameBrandBatchSize');
    const horF = filterOf('horizonDays');
    const wkF = filterOf('workingWeekdays');
    if (!prio || !contF || !onSiteF || !whF || !engF || !priF || !tgtF || !batchF || !horF || !wkF) return null;
    if (prio.type !== 'select' || contF.type !== 'multi_select' || whF.type !== 'multi_select' || engF.type !== 'multi_select' || priF.type !== 'multi_select') return null;
    if (onSiteF.type !== 'checkbox') return null;
    if (tgtF.type !== 'number' || batchF.type !== 'number' || horF.type !== 'number' || wkF.type !== 'multi_select') return null;

    const warehouseOpts = optionSets.warehouses ?? [];
    const brandOpts = optionSets.brands ?? [];
    const contractOpts = optionSets.assembly_forecast_contracts ?? [];
    const pm = String(activeFilters.assemblyPriorityMode ?? prio.options?.[0]?.value ?? 'manual');
    const contractsDisabled = busy || pm === 'manual';
    const selWh = Array.isArray(activeFilters.warehouseIds) ? (activeFilters.warehouseIds as string[]) : [];
    const selBrand = Array.isArray(activeFilters.engineBrandIds) ? (activeFilters.engineBrandIds as string[]) : [];
    const selPriBrand = Array.isArray(activeFilters.priorityEngineBrandIds) ? (activeFilters.priorityEngineBrandIds as string[]) : [];
    const selContracts = Array.isArray(activeFilters.assemblyContractIds) ? (activeFilters.assemblyContractIds as string[]) : [];
    const onSiteOnlyChecked = Boolean(activeFilters.assemblyForecastOnSiteOnly);
    const selWorkingWeekdays = Array.isArray(activeFilters.workingWeekdays) ? (activeFilters.workingWeekdays as string[]) : [];
    const weekdayOpts = wkF.options ?? [];
    const allWeekdayIds = weekdayOpts.map((o) => String(o.value));
    const allWeekdaysSelected =
      allWeekdayIds.length > 0 && selWorkingWeekdays.length === allWeekdayIds.length && allWeekdayIds.every((id) => selWorkingWeekdays.includes(id));

    const allWhIds = warehouseOpts.map((o) => String(o.value));
    const allBrandIds = brandOpts.map((o) => String(o.value));
    const allContractIds = contractOpts.map((o) => String(o.value));
    const allWhSelected = allWhIds.length > 0 && selWh.length === allWhIds.length && allWhIds.every((id) => selWh.includes(id));
    const allBrandsSelected =
      allBrandIds.length > 0 && selBrand.length === allBrandIds.length && allBrandIds.every((id) => selBrand.includes(id));
    const allContractsSelected =
      allContractIds.length > 0 && selContracts.length === allContractIds.length && allContractIds.every((id) => selContracts.includes(id));

    const whLabels = warehouseOpts.filter((o) => selWh.includes(String(o.value)));
    const brandLabels = brandOpts.filter((o) => selBrand.includes(String(o.value)));
    const priBrandLabels = brandOpts.filter((o) => selPriBrand.includes(String(o.value)));
    const contractLabels = contractOpts.filter((o) => selContracts.includes(String(o.value)));

    const priorityManualDisabled = pm === 'contracts';

    function renderAfNumber(filter: Extract<ReportFilterSpec, { type: 'number' }>) {
      const raw = activeFilters[filter.key];
      const num = typeof raw === 'number' ? raw : Number(raw);
      const safe = Number.isFinite(num) ? num : filter.defaultValue ?? 0;
      return (
        <div className="report-preset-af-row" key={filter.key}>
          <div className="report-preset-af-label" title={filterLabelHint(filter)}>
            {filter.label}
          </div>
          <div className="report-preset-af-main">
            <Input
              type="number"
              min={filter.min}
              max={filter.max}
              step={filter.step ?? 1}
              value={String(safe)}
              onChange={(e) => patchFilter(filter.key, Number(e.target.value))}
              disabled={busy}
              style={{ width: '100%', minHeight: 36 }}
            />
          </div>
          <button type="button" onClick={() => resetFilter(filter)} title="Сбросить" style={filterResetBtnStyle}>
            ✕
          </button>
        </div>
      );
    }

    return (
      <div className="report-preset-af-stack">
        <Button type="button" variant="primary" size="lg" className="report-preset-af-reset-all" onClick={resetAllFilters} disabled={busy}>
          Сбросить все фильтры
        </Button>

        <div className="report-preset-af-row">
          <div className="report-preset-af-label" title={filterLabelHint(prio)}>
            {prio.label}
          </div>
          <div className="report-preset-af-main">
            <div className="report-preset-af-toggle">
              <button
                type="button"
                className="report-preset-af-pill"
                data-active={pm === 'manual' ? 'true' : 'false'}
                disabled={busy}
                title="Приоритет задаётся списком «Приоритетные марки»."
                onClick={() => patchFilter('assemblyPriorityMode', 'manual')}
              >
                Вручную
              </button>
              <button
                type="button"
                className="report-preset-af-pill"
                data-active={pm === 'contracts' ? 'true' : 'false'}
                disabled={busy}
                title="Автовыбор по непросрочным контрактам с отставанием от линейного графика."
                onClick={() => patchFilter('assemblyPriorityMode', 'contracts')}
              >
                По контрактам
              </button>
            </div>
          </div>
          <button type="button" onClick={() => resetFilter(prio)} title="Сбросить" style={filterResetBtnStyle}>
            ✕
          </button>
        </div>

        <div className="report-preset-af-block">
          <div className="report-preset-af-label" title={filterLabelHint(contF)}>
            {contF.label}
          </div>
          <div className="report-preset-af-main" style={{ width: '100%', minWidth: 0 }}>
            <MultiSearchSelect
              values={selContracts}
              options={contractOpts.map((option) => ({
                id: option.value,
                label: option.label,
                ...(option.hintText ? { hintText: option.hintText } : {}),
                ...(option.searchText ? { searchText: option.searchText } : {}),
              }))}
              placeholder="Номер контракта, внутр. номер или заказчик"
              disabled={contractsDisabled}
              query={activeFilterSearch[contF.key] ?? ''}
              onQueryChange={(next) => patchFilterSearch(contF.key, next)}
              onChange={(next) => patchFilter(contF.key, next)}
            />
          </div>
          <button type="button" onClick={() => resetFilter(contF)} title="Сбросить" style={filterResetBtnStyle} disabled={contractsDisabled}>
            ✕
          </button>
          {contractsDisabled ? (
            <div className="report-preset-af-meta">Доступно в режиме «По контрактам».</div>
          ) : contractOpts.length === 0 ? (
            <div className="report-preset-af-meta">Загрузка списка контрактов…</div>
          ) : allContractsSelected ? (
            <div className="report-preset-af-meta">Учитываются все контракты ({contractLabels.length}): авто-приоритет по отставанию среди них.</div>
          ) : selContracts.length === 0 ? (
            <div className="report-preset-af-meta">Пустой список — как «все контракты» после загрузки опций.</div>
          ) : (
            <div className="report-preset-af-meta report-preset-af-tags">
              {contractLabels.map((o) => (
                <span key={o.value} className="report-preset-af-tag" title={o.label}>
                  {o.label}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="report-preset-af-block">
          <div className="report-preset-af-label" title={filterLabelHint(onSiteF)}>
            {onSiteF.label}
          </div>
          <div className="report-preset-af-main" style={{ display: 'flex', alignItems: 'center', minHeight: 36 }}>
            <input
              type="checkbox"
              checked={onSiteOnlyChecked}
              disabled={busy || contractsDisabled}
              title={contractsDisabled ? 'Доступно в режиме «По контрактам».' : filterLabelHint(onSiteF)}
              onChange={(e) => patchFilter('assemblyForecastOnSiteOnly', e.target.checked)}
              aria-label={onSiteF.label}
            />
          </div>
          <button
            type="button"
            onClick={() => resetFilter(onSiteF)}
            title="Сбросить"
            style={filterResetBtnStyle}
            disabled={contractsDisabled}
          >
            ✕
          </button>
          {contractsDisabled ? (
            <div className="report-preset-af-meta">Доступно в режиме «По контрактам»: учёт объёма по контракту vs только двигатели на заводе со статусом «Начат ремонт».</div>
          ) : onSiteOnlyChecked ? (
            <div className="report-preset-af-meta">
              Включено: прогноз по прикреплённым к выбранным контрактам двигателям со статусом «Начат ремонт» (на заводе к ремонту).
            </div>
          ) : (
            <div className="report-preset-af-meta">
              Выключено: ориентир по суммарным количествам по маркам из первичного договора и ДС (остаток к исполнению).
            </div>
          )}
        </div>

        <div className="report-preset-af-block">
          <div className="report-preset-af-label" title={filterLabelHint(whF)}>
            {whF.label}
          </div>
          <div className="report-preset-af-main" style={{ width: '100%', minWidth: 0 }}>
            <MultiSearchSelect
              values={selWh}
              options={warehouseOpts.map((option) => ({
                id: option.value,
                label: option.label,
                ...(option.hintText ? { hintText: option.hintText } : {}),
                ...(option.searchText ? { searchText: option.searchText } : {}),
              }))}
              placeholder="Нажмите и выберите склады"
              disabled={busy}
              query={activeFilterSearch[whF.key] ?? ''}
              onQueryChange={(next) => patchFilterSearch(whF.key, next)}
              onChange={(next) => patchFilter(whF.key, next)}
            />
          </div>
          <button type="button" onClick={() => resetFilter(whF)} title="Сбросить" style={filterResetBtnStyle}>
            ✕
          </button>
          {warehouseOpts.length === 0 ? (
            <div className="report-preset-af-meta">Загрузка списка складов…</div>
          ) : (
            <div className="report-preset-af-meta">
              {allWhSelected
                ? `В расчёте все склады (${whLabels.length}): ${whLabels.map((o) => o.label).join(' · ')}`
                : `Участвуют: ${whLabels.map((o) => o.label).join(' · ')}`}
            </div>
          )}
        </div>

        <div className="report-preset-af-block">
          <div className="report-preset-af-label" title={filterLabelHint(engF)}>
            {engF.label}
          </div>
          <div className="report-preset-af-main" style={{ width: '100%', minWidth: 0 }}>
            <MultiSearchSelect
              values={selBrand}
              options={brandOpts.map((option) => ({
                id: option.value,
                label: option.label,
                ...(option.hintText ? { hintText: option.hintText } : {}),
                ...(option.searchText ? { searchText: option.searchText } : {}),
              }))}
              placeholder="Нажмите и выберите марки"
              disabled={busy}
              query={activeFilterSearch[engF.key] ?? ''}
              onQueryChange={(next) => patchFilterSearch(engF.key, next)}
              onChange={(next) => patchFilter(engF.key, next)}
            />
          </div>
          <button type="button" onClick={() => resetFilter(engF)} title="Сбросить" style={filterResetBtnStyle}>
            ✕
          </button>
          {brandOpts.length === 0 ? (
            <div className="report-preset-af-meta">Загрузка списка марок…</div>
          ) : allBrandsSelected ? (
            <div className="report-preset-af-meta">Выбраны все марки двигателей (с активной default BOM).</div>
          ) : (
            <div className="report-preset-af-meta report-preset-af-tags">
              {brandLabels.map((o) => (
                <span key={o.value} className="report-preset-af-tag" title={o.label}>
                  {o.label}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="report-preset-af-block">
          <div className="report-preset-af-label" title={filterLabelHint(priF)}>
            {priF.label}
          </div>
          <div className="report-preset-af-main" style={{ width: '100%', minWidth: 0 }}>
            <MultiSearchSelect
              values={selPriBrand}
              options={brandOpts.map((option) => ({
                id: option.value,
                label: option.label,
                ...(option.hintText ? { hintText: option.hintText } : {}),
                ...(option.searchText ? { searchText: option.searchText } : {}),
              }))}
              placeholder="Нажмите и выберите марки"
              disabled={busy || priorityManualDisabled}
              query={activeFilterSearch[priF.key] ?? ''}
              onQueryChange={(next) => patchFilterSearch(priF.key, next)}
              onChange={(next) => patchFilter(priF.key, next)}
            />
          </div>
          <button type="button" onClick={() => resetFilter(priF)} title="Сбросить" style={filterResetBtnStyle}>
            ✕
          </button>
          {priorityManualDisabled ? (
            <div className="report-preset-af-meta">В режиме «По контрактам» список задаётся автоматически.</div>
          ) : selPriBrand.length === 0 ? (
            <div className="report-preset-af-meta">Приоритет по маркам не задан.</div>
          ) : (
            <div className="report-preset-af-meta report-preset-af-tags">
              {priBrandLabels.map((o) => (
                <span key={o.value} className="report-preset-af-tag" title={o.label}>
                  {o.label}
                </span>
              ))}
            </div>
          )}
        </div>

        {renderAfNumber(tgtF)}
        {renderAfNumber(batchF)}
        {renderAfNumber(horF)}
        <div className="report-preset-af-block">
          <div className="report-preset-af-label" title={filterLabelHint(wkF)}>
            {wkF.label}
          </div>
          <div className="report-preset-af-main">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              {weekdayOpts.map((option) => {
                const id = String(option.value);
                const checked = selWorkingWeekdays.includes(id);
                return (
                  <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={(e) => {
                        const set = new Set(selWorkingWeekdays);
                        if (e.target.checked) set.add(id);
                        else set.delete(id);
                        patchFilter(wkF.key, Array.from(set));
                      }}
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <button type="button" onClick={() => resetFilter(wkF)} title="Сбросить" style={filterResetBtnStyle}>
            ✕
          </button>
          <div className="report-preset-af-meta">
            {allWeekdaysSelected
              ? 'Рабочие: все дни недели.'
              : selWorkingWeekdays.length === 0
                ? 'Рабочие дни не выбраны: весь горизонт будет выходным.'
                : `Рабочие: ${weekdayOpts.filter((o) => selWorkingWeekdays.includes(String(o.value))).map((o) => o.label).join(', ')}`}
          </div>
        </div>
      </div>
    );
  }

  // Ф4: шапка каждого фильтра — «выкл/вкл» (не участвует в отборе) + ✕ (сброс к умолчанию).
  function filterHeaderControls(filter: ReportFilterSpec, off: boolean) {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); toggleFilterDisabled(filter); }}
          title={off ? 'Включить фильтр — снова участвует в отборе данных' : 'Отключить фильтр — не участвует в отборе данных'}
          style={{ ...filterResetBtnStyle, ...(off ? { color: 'var(--text)', borderColor: 'var(--warning, #b45309)', fontWeight: 700 } : {}) }}
        >
          {off ? 'вкл' : 'выкл'}
        </button>
        <button type="button" onClick={(e) => { e.preventDefault(); resetFilter(filter); }} title="Сбросить к значению по умолчанию" style={filterResetBtnStyle}>✕</button>
      </div>
    );
  }

  function renderFilterControl(filter: ReportFilterSpec) {
    const off = activeDisabled.includes(filter.key);
    const bodyStyle: React.CSSProperties = off ? { opacity: 0.4, pointerEvents: 'none' } : {};
    const labelSuffix = off ? ' (откл.)' : '';
    if (filter.type === 'date_range') {
      return (
        <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700 }}>{filter.label}{labelSuffix}</span>
            {filterHeaderControls(filter, off)}
          </div>
          <div style={bodyStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <Input
                type="date"
                value={toInputDate(activeFilters[filter.startKey])}
                onChange={(e) => patchFilter(filter.startKey, fromInputDate(e.target.value, 'start'))}
              />
              <Input
                type="date"
                value={toInputDate(activeFilters[filter.endKey])}
                onChange={(e) => patchFilter(filter.endKey, fromInputDate(e.target.value, 'end'))}
              />
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
              {DATE_PERIOD_PRESETS.map((p) => (
                <button key={p.title} type="button" title={p.title} onClick={() => applyDatePreset(filter, p)} style={periodBtnStyle}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      );
    }
    if (filter.type === 'checkbox') {
      return (
        <div key={filter.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, ...bodyStyle }}>
            <input
              type="checkbox"
              checked={Boolean(activeFilters[filter.key])}
              onChange={(e) => patchFilter(filter.key, e.target.checked)}
            />
            <span>{filter.label}{labelSuffix}</span>
          </label>
          {filterHeaderControls(filter, off)}
        </div>
      );
    }
    if (filter.type === 'number') {
      const raw = activeFilters[filter.key];
      const num = typeof raw === 'number' ? raw : Number(raw);
      const safe = Number.isFinite(num) ? num : filter.defaultValue ?? 0;
      return (
        <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700 }}>{filter.label}{labelSuffix}</span>
            {filterHeaderControls(filter, off)}
          </div>
          <div style={bodyStyle}>
            <Input
              type="number"
              min={filter.min}
              max={filter.max}
              step={filter.step ?? 1}
              value={String(safe)}
              onChange={(e) => patchFilter(filter.key, Number(e.target.value))}
              disabled={busy}
            />
          </div>
        </div>
      );
    }
    if (filter.type === 'text') {
      const textVal = String(activeFilters[filter.key] ?? filter.defaultValue ?? '');
      return (
        <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700 }}>{filter.label}{labelSuffix}</span>
            {filterHeaderControls(filter, off)}
          </div>
          <div style={bodyStyle}>
            <Input
              type="text"
              value={textVal}
              placeholder={filter.placeholder}
              onChange={(e) => patchFilter(filter.key, e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
      );
    }
    if (filter.type === 'select') {
      const sourceOptions = filter.optionsSource ? optionSets[filter.optionsSource] ?? [] : filter.options ?? [];
      const value = String(activeFilters[filter.key] ?? sourceOptions[0]?.value ?? '');
      const options = sourceOptions.map((option) => ({
        id: option.value,
        label: option.label,
        ...(option.hintText ? { hintText: option.hintText } : {}),
        ...(option.searchText ? { searchText: option.searchText } : {}),
      }));
      return (
        <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700 }}>{filter.label}{labelSuffix}</span>
            {filterHeaderControls(filter, off)}
          </div>
          <div style={bodyStyle}>
            <SearchSelect
              value={value || null}
              options={options}
              placeholder="Начните вводить для поиска"
              disabled={busy}
              showAllWhenEmpty
              emptyQueryLimit={100}
              query={activeFilterSearch[filter.key] ?? ''}
              onQueryChange={(next) => patchFilterSearch(filter.key, next)}
              onChange={(next) => patchFilter(filter.key, next ?? sourceOptions[0]?.value ?? '')}
            />
          </div>
        </div>
      );
    }
    const options = filter.optionsSource ? optionSets[filter.optionsSource] ?? [] : filter.options ?? [];
    const selected = Array.isArray(activeFilters[filter.key]) ? (activeFilters[filter.key] as unknown[]).map(String) : [];
    const selectedLabels = options.filter((o) => selected.includes(o.value));
    return (
      <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700 }}>{filter.label}{labelSuffix}</span>
          {filterHeaderControls(filter, off)}
        </div>
        <div style={bodyStyle}>
          <MultiSearchSelect
            values={selected}
            options={options.map((option) => ({
              id: option.value,
              label: option.label,
              ...(option.hintText ? { hintText: option.hintText } : {}),
              ...(option.searchText ? { searchText: option.searchText } : {}),
            }))}
            placeholder="Начните вводить или вставьте текст"
            disabled={busy}
            query={activeFilterSearch[filter.key] ?? ''}
            onQueryChange={(next) => patchFilterSearch(filter.key, next)}
            onChange={(next) => patchFilter(filter.key, next)}
          />
          {selectedLabels.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
              {selectedLabels.map((o) => (
                <span key={o.value} style={selectedTagStyle} title={o.label}>
                  {o.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="report-preset-page" style={{ display: 'grid', gap: 10 }}>
      <SectionCard
        title={activePreset ? activePreset.title : 'Шаблон отчёта'}
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={props.onBack}>
              К списку Отчётов
            </Button>
            <Button variant="ghost" onClick={() => void loadPresetMeta()} disabled={busy}>
              Обновить
            </Button>
          </div>
        }
      >
        {activePreset ? (
          activePreset.description.trim() ? <div className="ui-muted">{activePreset.description}</div> : null
        ) : (
          <div className="ui-muted">Шаблон не найден. Вернитесь к списку отчётов.</div>
        )}
      </SectionCard>

      <div className="card-action-bar" style={{ position: 'sticky', top: 0, zIndex: 8, background: 'var(--surface)', padding: '6px 0' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="ghost" tone="info" onClick={() => void openPreviewWindow()} disabled={busy || !activePreset}>
            Предпросмотр
          </Button>
          <Button variant="ghost" tone="neutral" onClick={() => void runPrint()} disabled={busy || !activePreset}>
            Печать
          </Button>
          <Button variant="ghost" tone="success" onClick={() => void savePdf()} disabled={busy || !props.canExport || !activePreset}>
            Сохранить PDF
          </Button>
          <Button variant="ghost" tone="success" onClick={() => void saveCsv()} disabled={busy || !props.canExport || !activePreset}>
            Сохранить CSV
          </Button>
          <Button variant="ghost" tone="success" onClick={() => void save1cXml()} disabled={busy || !props.canExport || !activePreset}>
            Выгрузка 1С (XML)
          </Button>
        </div>
      </div>

      <div className="report-preset-split-layout">
      <SectionCard title={activePreset ? `Фильтры и настройки: ${activePreset.title}` : 'Фильтры и настройки'}>
        {!activePreset ? (
          <div className="ui-muted">Выберите шаблон отчета.</div>
        ) : activePreset.id === ASSEMBLY_FORECAST_PRESET_ID ? (
          // Stage 3: ручная генерация. Кнопка + индикатор актуальности кеша.
          (() => {
            const filtersChangedSinceCache = cachedFiltersKey !== null && cachedFiltersKey !== filtersKey;
            return (
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button onClick={() => void buildPreview()} disabled={busy} tone="success">
                    Сформировать прогноз
                  </Button>
                  {filtersChangedSinceCache ? (
                    <div style={{ color: 'var(--danger)', fontSize: 12 }}>
                      Фильтры изменились — нажмите «Сформировать прогноз», чтобы пересчитать.
                    </div>
                  ) : preview && cachedFiltersKey === filtersKey ? (
                    <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Прогноз актуален для текущих фильтров.</div>
                  ) : (
                    <div style={{ color: 'var(--muted)', fontSize: 12 }}>Нажмите «Сформировать прогноз», чтобы построить отчёт.</div>
                  )}
                </div>
                {renderAssemblyForecastFilters()}
              </div>
            );
          })()
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button onClick={() => void buildPreview()} disabled={busy} tone="success">
                  Сформировать отчёт
                </Button>
                {cachedFiltersKey !== null && cachedFiltersKey !== filtersKey ? (
                  <div style={{ color: 'var(--danger)', fontSize: 12 }}>
                    Фильтры изменились — нажмите «Сформировать отчёт», чтобы пересчитать.
                  </div>
                ) : preview && cachedFiltersKey === filtersKey ? (
                  <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Отчёт актуален для текущих фильтров.</div>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>Настройте фильтры и нажмите «Сформировать отчёт».</div>
                )}
              </div>
              {activePreset.filters.length > 0 && (
                <button type="button" onClick={resetAllFilters} disabled={busy} style={{ ...filterResetBtnStyle, padding: '3px 10px', fontSize: 12 }}>
                  Сбросить все фильтры
                </button>
              )}
            </div>
            <div className="report-preset-filter-block">
              <div className="report-preset-filter-block-title">Шаблоны фильтров</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 200 }}>
                  <SearchSelect
                    value={selectedTemplateId}
                    options={filterTemplates.map((t) => ({ id: t.id, label: t.name }))}
                    placeholder={filterTemplates.length ? 'Выберите шаблон' : 'Шаблонов пока нет'}
                    showAllWhenEmpty
                    disabled={busy}
                    onChange={(next) => applyFilterTemplate(next)}
                  />
                </div>
                <Input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="Название шаблона"
                  disabled={busy}
                  style={{ width: 180 }}
                />
                <Button variant="ghost" onClick={() => void saveFilterTemplate()} disabled={busy || !templateName.trim()}>
                  Сохранить шаблон
                </Button>
                {selectedTemplateId ? (
                  <Button variant="ghost" tone="danger" onClick={() => void deleteFilterTemplate()} disabled={busy}>
                    Удалить шаблон
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="report-preset-filter-block report-preset-filter-block-selection">
              <div className="report-preset-filter-block-title">Фильтры отбора</div>
              <div className="report-preset-filter-grid">{filterGroups.selection.map((filter) => renderFilterControl(filter))}</div>
            </div>
            <div className="report-preset-filter-block report-preset-filter-block-settings">
              <div className="report-preset-filter-block-title">Настройки расчёта</div>
              <div className="report-preset-filter-grid">{filterGroups.settings.map((filter) => renderFilterControl(filter))}</div>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title={preview ? `Результат: ${preview.title}` : 'Результат'}>
        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', marginBottom: 8 }}>{status}</div> : null}
        {!preview ? (
          activePresetId === ASSEMBLY_FORECAST_PRESET_ID ? (
            <div className="ui-muted">Нажмите «Сформировать прогноз» в фильтрах слева.</div>
          ) : (
            <div className="ui-muted">Нажмите «Сформировать отчёт» в фильтрах слева.</div>
          )
        ) : (
          <div className="report-preview-root" style={{ display: 'grid', gap: 8 }}>
            {preview.presetId !== 'assembly_forecast_7d' && preview.subtitle ? (
              <div className="ui-muted">{preview.subtitle}</div>
            ) : null}
            {preview.presetId === 'work_order_payroll' ? (
              <div className="work-order-payroll-onscreen" dangerouslySetInnerHTML={{ __html: renderWorkOrderPayrollFormInnerHtml(preview) }} />
            ) : preview.presetId === 'assembly_forecast_7d' ? (
              <AssemblyForecastReportView
                preview={preview}
                {...(props.onOpenWorkOrder ? { onOpenWorkOrder: props.onOpenWorkOrder } : {})}
                {...(props.onOpenSupplyRequest ? { onOpenSupplyRequest: props.onOpenSupplyRequest } : {})}
              />
            ) : (
              <>
                <div className="list-table-wrap" style={{ border: '1px solid var(--border)' }}>
                  <table className="list-table">
                    <thead>
                      <tr>
                        {preview.columns.map((column) => (
                          <th
                            key={column.key}
                            data-col-kind={column.kind === 'number' ? 'num' : column.kind === 'date' || column.kind === 'datetime' ? 'date' : 'name'}
                            {...((column.kind === 'number' || column.kind === 'date' || column.kind === 'datetime') ? { title: column.label } : {})}
                            style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}
                          >
                            {column.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, idx) => (
                        <tr key={`report-row-${idx}`}>
                          {preview.columns.map((column) => (
                            <td
                              key={`${idx}-${column.key}`}
                              data-col-kind={column.kind === 'number' ? 'num' : column.kind === 'date' || column.kind === 'datetime' ? 'date' : 'name'}
                              style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}
                            >
                              {formatReportCell(column.kind ?? 'text', (row[column.key] ?? null) as ReportCellValue, column.key)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {preview.rows.length === 0 && (
                        <tr>
                          <td colSpan={preview.columns.length}>Нет данных</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {preview.totals && Object.keys(preview.totals).length > 0 ? (
                  <div style={{ fontWeight: 700 }}>
                    Итого по отчету: {formatReportTotals(preview.totals).join(', ')}
                  </div>
                ) : null}
                {preview.workOrdersStatusSummary ? (
                  <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ fontWeight: 700 }}>{formatWorkOrdersStatusCountsLine(preview.workOrdersStatusSummary.counts)}</div>
                    {preview.workOrdersStatusSummary.byBrand && preview.workOrdersStatusSummary.byBrand.length > 0 ? (
                      <div className="list-table-wrap" style={{ border: '1px solid var(--border)' }}>
                        <table className="list-table">
                          <thead>
                            <tr>
                              <th>Марка</th>
                              {WORK_ORDERS_STATUS_COUNT_LABELS.map((c) => (
                                <th key={c.key} style={{ textAlign: 'right' }}>{c.label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {preview.workOrdersStatusSummary.byBrand.map((b) => (
                              <tr key={b.brand}>
                                <td>{b.brand}</td>
                                {WORK_ORDERS_STATUS_COUNT_LABELS.map((c) => (
                                  <td key={c.key} style={{ textAlign: 'right' }}>{b.counts[c.key]}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {preview.footerNotes && preview.footerNotes.length > 0 ? (
                  <div style={{ display: 'grid', gap: 6, marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 700 }}>Пояснения</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {preview.footerNotes.map((line, i) => (
                        <li key={`fn-${i}`} className="ui-muted">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </SectionCard>
      </div>
    </div>
  );
}
