import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReportCellValue,
  ReportFilterOption,
  ReportFilterSpec,
  ReportOptionSource,
  ReportPresetDefinition,
  ReportPresetFilters,
  ReportPresetId,
  ReportPresetPreviewResult,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { SectionCard } from '../components/SectionCard.js';
import { openPrintPreview } from '../utils/printPreview.js';
import {
  binaryDownloadBase64,
  buildDefaultFilters,
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

export function ReportPresetPage(props: { presetId: ReportPresetId; canExport: boolean; userId: string; onBack: () => void }) {
  const [presets, setPresets] = useState<ReportPresetDefinition[]>([]);
  const [optionSets, setOptionSets] = useState<Partial<Record<ReportOptionSource, ReportFilterOption[]>>>({});
  const [filtersByPreset, setFiltersByPreset] = useState<Partial<Record<ReportPresetId, ReportPresetFilters>>>({});
  const [filterSearchByPreset, setFilterSearchByPreset] = useState<Partial<Record<ReportPresetId, Record<string, string>>>>({});
  const [preview, setPreview] = useState<PreviewOk | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const autoBuildRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const activePresetId = activePreset?.id;
  const filtersKey = JSON.stringify(activeFilters);

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
        filters: activeFilters,
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${result?.error ?? 'unknown'}`);
        setPreview(null);
        return null;
      }
      setPreview(result);
      setStatus(`Сформировано строк: ${result.rows.length}`);
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

  useEffect(() => {
    if (!activePresetId) return;
    if (autoBuildRef.current) clearTimeout(autoBuildRef.current);
    autoBuildRef.current = setTimeout(() => {
      void buildPreviewRef.current();
    }, 400);
    return () => {
      if (autoBuildRef.current) clearTimeout(autoBuildRef.current);
    };
  }, [activePresetId, filtersKey]);

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
        filters: activeFilters,
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
        filters: activeFilters,
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
        filters: activeFilters,
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
        filters: activeFilters,
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

  return (
    <div style={{ display: 'grid', gap: 10 }}>
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
          <div className="ui-muted">{activePreset.description}</div>
        ) : (
          <div className="ui-muted">Шаблон не найден. Вернитесь к списку отчётов.</div>
        )}
      </SectionCard>

      <SectionCard title={activePreset ? `Фильтры: ${activePreset.title}` : 'Фильтры'}>
        {!activePreset ? (
          <div className="ui-muted">Выберите шаблон отчета.</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                Отчет формируется автоматически при изменении фильтров.
              </div>
              {activePreset.filters.length > 0 && (
                <button type="button" onClick={resetAllFilters} disabled={busy} style={{ ...filterResetBtnStyle, padding: '3px 10px', fontSize: 12 }}>
                  Сбросить все фильтры
                </button>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 8 }}>
              {activePreset.filters.map((filter) => {
                if (filter.type === 'date_range') {
                  return (
                    <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700 }}>{filter.label}</span>
                        <button type="button" onClick={() => resetFilter(filter)} title="Сбросить фильтр" style={filterResetBtnStyle}>✕</button>
                      </div>
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
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {DATE_PERIOD_PRESETS.map((p) => (
                          <button key={p.title} type="button" title={p.title} onClick={() => applyDatePreset(filter, p)} style={periodBtnStyle}>
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                }
                if (filter.type === 'checkbox') {
                  return (
                    <label key={filter.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(activeFilters[filter.key])}
                        onChange={(e) => patchFilter(filter.key, e.target.checked)}
                      />
                      <span>{filter.label}</span>
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); resetFilter(filter); }}
                        title="Сбросить фильтр"
                        style={filterResetBtnStyle}
                      >
                        ✕
                      </button>
                    </label>
                  );
                }
                if (filter.type === 'number') {
                  const raw = activeFilters[filter.key];
                  const num = typeof raw === 'number' ? raw : Number(raw);
                  const safe = Number.isFinite(num) ? num : filter.defaultValue ?? 0;
                  return (
                    <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700 }}>{filter.label}</span>
                        <button type="button" onClick={() => resetFilter(filter)} title="Сбросить фильтр" style={filterResetBtnStyle}>✕</button>
                      </div>
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
                  );
                }
                if (filter.type === 'text') {
                  const textVal = String(activeFilters[filter.key] ?? filter.defaultValue ?? '');
                  return (
                    <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700 }}>{filter.label}</span>
                        <button type="button" onClick={() => resetFilter(filter)} title="Сбросить фильтр" style={filterResetBtnStyle}>✕</button>
                      </div>
                      <Input
                        type="text"
                        value={textVal}
                        placeholder={filter.placeholder}
                        onChange={(e) => patchFilter(filter.key, e.target.value)}
                        disabled={busy}
                      />
                    </div>
                  );
                }
                if (
                  filter.type === 'select' &&
                  activePreset.id === 'assembly_forecast_7d' &&
                  filter.key === 'assemblyPriorityMode'
                ) {
                  const asmOpts = filter.options ?? [];
                  const pm = String(activeFilters[filter.key] ?? asmOpts[0]?.value ?? 'manual');
                  return (
                    <div key={filter.key} style={{ display: 'grid', gap: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700 }}>{filter.label}</span>
                        <button type="button" onClick={() => resetFilter(filter)} title="Сбросить фильтр" style={filterResetBtnStyle}>
                          ✕
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {asmOpts.map((o) => (
                          <label
                            key={o.value}
                            style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: busy ? 'default' : 'pointer' }}
                          >
                            <input
                              type="radio"
                              name="assemblyPriorityMode"
                              checked={pm === o.value}
                              disabled={busy}
                              onChange={() => patchFilter(filter.key, o.value)}
                              style={{ marginTop: 3 }}
                            />
                            <span>
                              <div style={{ fontWeight: 600 }}>{o.label}</div>
                              {o.hintText ? <div className="ui-muted" style={{ fontSize: 12, marginTop: 4 }}>{o.hintText}</div> : null}
                            </span>
                          </label>
                        ))}
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
                        <span style={{ fontWeight: 700 }}>{filter.label}</span>
                        <button type="button" onClick={() => resetFilter(filter)} title="Сбросить фильтр" style={filterResetBtnStyle}>✕</button>
                      </div>
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
                  );
                }
                const options = filter.optionsSource ? optionSets[filter.optionsSource] ?? [] : filter.options ?? [];
                const selected = Array.isArray(activeFilters[filter.key]) ? (activeFilters[filter.key] as unknown[]).map(String) : [];
                const selectedLabels = options.filter((o) => selected.includes(o.value));
                const priorityManualDisabled =
                  activePreset?.id === 'assembly_forecast_7d' &&
                  filter.key === 'priorityEngineBrandIds' &&
                  String(activeFilters.assemblyPriorityMode ?? 'manual') === 'contracts';
                return (
                  <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700 }}>{filter.label}</span>
                      <button type="button" onClick={() => resetFilter(filter)} title="Сбросить фильтр" style={filterResetBtnStyle}>✕</button>
                    </div>
                    {priorityManualDisabled ? (
                      <div className="ui-muted" style={{ fontSize: 12 }}>
                        В режиме «По отстающим контрактам» ручной список не используется — приоритетные марки подбираются автоматически.
                      </div>
                    ) : null}
                    <MultiSearchSelect
                      values={selected}
                      options={options.map((option) => ({
                        id: option.value,
                        label: option.label,
                        ...(option.hintText ? { hintText: option.hintText } : {}),
                        ...(option.searchText ? { searchText: option.searchText } : {}),
                      }))}
                      placeholder="Начните вводить или вставьте текст"
                      disabled={busy || priorityManualDisabled}
                      query={activeFilterSearch[filter.key] ?? ''}
                      onQueryChange={(next) => patchFilterSearch(filter.key, next)}
                      onChange={(next) => patchFilter(filter.key, next)}
                    />
                    {selectedLabels.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {selectedLabels.map((o) => (
                          <span key={o.value} style={selectedTagStyle} title={o.label}>
                            {o.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="ghost" tone="info" onClick={() => void openPreviewWindow()} disabled={busy}>
                Предпросмотр
              </Button>
              <Button variant="ghost" tone="neutral" onClick={() => void runPrint()} disabled={busy}>
                Печать
              </Button>
              <Button variant="ghost" tone="success" onClick={() => void savePdf()} disabled={busy || !props.canExport}>
                Сохранить PDF
              </Button>
              <Button variant="ghost" tone="success" onClick={() => void saveCsv()} disabled={busy || !props.canExport}>
                Сохранить CSV
              </Button>
              <Button variant="ghost" tone="success" onClick={() => void save1cXml()} disabled={busy || !props.canExport}>
                Выгрузка 1С (XML)
              </Button>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title={preview ? `Результат: ${preview.title}` : 'Результат'}>
        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', marginBottom: 8 }}>{status}</div> : null}
        {!preview ? (
          <div className="ui-muted">Отчет формируется автоматически при изменении фильтров.</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {preview.subtitle ? <div className="ui-muted">{preview.subtitle}</div> : null}
            {preview.presetId === 'work_order_payroll' ? (
              <div className="work-order-payroll-onscreen" dangerouslySetInnerHTML={{ __html: renderWorkOrderPayrollFormInnerHtml(preview) }} />
            ) : (
              <>
                <div className="list-table-wrap" style={{ border: '1px solid var(--border)' }}>
                  <table className="list-table">
                    <thead>
                      <tr>
                        {preview.columns.map((column) => (
                          <th key={column.key} style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}>
                            {column.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, idx) => (
                        <tr key={`report-row-${idx}`}>
                          {preview.columns.map((column) => (
                            <td key={`${idx}-${column.key}`} style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}>
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
  );
}
