import React, { useMemo, useState, useEffect } from 'react';
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
import { SectionCard } from '../components/SectionCard.js';
import { formatMoscowDate, formatMoscowDateTime, formatRuMoney, formatRuNumber, formatRuPercent } from '../utils/dateUtils.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';

type PreviewOk = Extract<ReportPresetPreviewResult, { ok: true }>;

function startOfDayMs(value: Date) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDayMs(value: Date) {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function toInputDate(value: unknown) {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (ms == null) return '';
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(value: string, mode: 'start' | 'end'): number | null {
  if (!value) return null;
  const [yy, mm, dd] = value.split('-').map((x) => Number(x));
  if (!yy || !mm || !dd) return null;
  const date = new Date(yy, mm - 1, dd);
  return mode === 'end' ? endOfDayMs(date) : startOfDayMs(date);
}

function formatCell(kind: ReportFilterSpec['type'] | 'date' | 'datetime' | 'number' | 'text', value: ReportCellValue): string {
  if (value == null) return '';
  if (kind === 'date' && typeof value === 'number') return formatMoscowDate(value);
  if (kind === 'datetime' && typeof value === 'number') return formatMoscowDateTime(value);
  if (kind === 'number' && typeof value === 'number') return formatRuNumber(value);
  return String(value);
}

const REPORT_TOTAL_LABELS: Record<string, string> = {
  scrapQty: 'Утиль, шт.',
  missingQty: 'Недокомплект, шт.',
  deliveredQty: 'Привезено, шт.',
  remainingNeedQty: 'Остаточная потребность, шт.',
  engines: 'Двигатели, шт.',
  contracts: 'Контракты, шт.',
  totalQty: 'Общий объем, шт.',
  totalAmountRub: 'Сумма, ₽',
  orderedQty: 'Заказано, шт.',
  remainingQty: 'Остаток, шт.',
  fulfillmentPct: '% выполнения',
  progressPct: 'Прогресс, %',
  workOrders: 'Наряды, шт.',
  lines: 'Записей, шт.',
  amountRub: 'Сумма, ₽',
  onSiteQty: 'На заводе, шт.',
  acceptance: 'Приёмка',
  shipment: 'Отгрузка',
  customer_delivery: 'Доставка заказчику',
};
const REPORT_METRIC_NOTES: Record<string, string> = {
  scrapQty: 'Утиль: количество бракованных деталей.',
  missingQty: 'Недокомплект: детали, которых не хватает по плану.',
  deliveredQty: 'Привезено: фактический объём поступивших деталей.',
  remainingNeedQty: 'Остаточная потребность: сколько нужно еще поставить.',
  totalQty: 'Общий объем: общий объем по всем строкам отчета.',
  totalAmountRub: 'Сумма: итоговая стоимость по всем выбранным данным.',
  orderedQty: 'Заказано: плановый объем по договоренностям.',
  remainingQty: 'Остаток: еще не закрытый объем.',
  fulfillmentPct: 'Процент выполнения: доля выполнения по плану.',
  progressPct: 'Прогресс: доля закрытых этапов.',
};

function reportTotalLabel(key: string): string {
  return REPORT_TOTAL_LABELS[key] ?? key;
}

function formatReportTotalValue(key: string, value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '');
  const normalizedKey = key.toLowerCase();
  const isPercent = normalizedKey.includes('pct');
  if (isPercent) {
    return formatRuPercent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  const isMoney = normalizedKey.includes('amount') && (normalizedKey.includes('rub') || normalizedKey.includes('₽'));
  if (isMoney) {
    return formatRuMoney(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return formatRuNumber(value, { maximumFractionDigits: 2 });
}

function formatReportTotals(totals: Record<string, unknown>): string[] {
  return Object.entries(totals).map(([key, value]) => {
    const label = reportTotalLabel(key);
    return `${label}: ${formatReportTotalValue(key, value)}`;
  });
}

function buildReportMetricNotes(totals: Record<string, unknown>): string[] {
  return Object.keys(totals)
    .map((key) => {
      const note = REPORT_METRIC_NOTES[key];
      if (!note) return null;
      return `<li><strong>${escapeHtml(reportTotalLabel(key))}</strong>: ${escapeHtml(note)}</li>`;
    })
    .filter((line): line is string => line !== null);
}

function csvDownload(csv: string, fileName: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function binaryDownloadBase64(contentBase64: string, fileName: string, mime: string) {
  const bytes = Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function buildDefaultFilters(preset: ReportPresetDefinition): ReportPresetFilters {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const out: ReportPresetFilters = {};
  for (const filter of preset.filters) {
    if (filter.type === 'date_range') {
      out[filter.startKey] = startOfDayMs(monthStart);
      out[filter.endKey] = endOfDayMs(now);
      continue;
    }
    if (filter.type === 'multi_select') {
      out[filter.key] = [];
      continue;
    }
    if (filter.type === 'checkbox') {
      out[filter.key] = filter.key === 'includePurchases';
      continue;
    }
    if (filter.type === 'select') {
      out[filter.key] = filter.options[0]?.value ?? '';
    }
  }
  return out;
}

function renderReportTableHtml(report: PreviewOk) {
  const head = report.columns
    .map((column) => `<th style="text-align:${column.align === 'right' ? 'right' : 'left'}">${escapeHtml(column.label)}</th>`)
    .join('');
  const body =
    report.rows.length > 0
      ? report.rows
          .map((row) => {
            const cells = report.columns
              .map((column) => {
                const value = row[column.key] ?? null;
                const text = formatCell(column.kind ?? 'text', value as ReportCellValue);
                return `<td style="text-align:${column.align === 'right' ? 'right' : 'left'}">${escapeHtml(text)}</td>`;
              })
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('')
      : `<tr><td colspan="${report.columns.length}">Нет данных</td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function ReportsPage(props: { canExport: boolean }) {
  const [presets, setPresets] = useState<ReportPresetDefinition[]>([]);
  const [optionSets, setOptionSets] = useState<Partial<Record<ReportOptionSource, ReportFilterOption[]>>>({});
  const [selectedPresetId, setSelectedPresetId] = useState<ReportPresetId | null>(null);
  const [filtersByPreset, setFiltersByPreset] = useState<Partial<Record<ReportPresetId, ReportPresetFilters>>>({});
  const [preview, setPreview] = useState<PreviewOk | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const activePreset = useMemo(
    () => (selectedPresetId ? presets.find((preset) => preset.id === selectedPresetId) ?? null : null),
    [presets, selectedPresetId],
  );
  const activeFilters = useMemo(() => {
    if (!activePreset) return {};
    return filtersByPreset[activePreset.id] ?? buildDefaultFilters(activePreset);
  }, [activePreset, filtersByPreset]);

  function patchFilter(key: string, value: unknown) {
    if (!activePreset) return;
    setFiltersByPreset((prev) => {
      const current = prev[activePreset.id] ?? buildDefaultFilters(activePreset);
      return {
        ...prev,
        [activePreset.id]: {
          ...current,
          [key]: value,
        },
      };
    });
  }

  async function loadPresetMeta() {
    setBusy(true);
    setStatus('Загрузка шаблонов...');
    try {
      const result = await window.matrica.reports.presetList();
      if (!result?.ok) {
        setStatus(`Ошибка: ${result?.error ?? 'unknown'}`);
        return;
      }
      setPresets(result.presets);
      setOptionSets(result.optionSets ?? {});
      setSelectedPresetId((current) => current ?? result.presets[0]?.id ?? null);
      setFiltersByPreset((prev) => {
        const next = { ...prev };
        for (const preset of result.presets) {
          if (!next[preset.id]) next[preset.id] = buildDefaultFilters(preset);
        }
        return next;
      });
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadPresetMeta();
  }, []);

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
      return result;
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
      setPreview(null);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function openPreviewWindow() {
    const report = preview ?? (await buildPreview());
    if (!report) return;
    const sections = [
      { id: 'table', title: 'Данные отчета', html: renderReportTableHtml(report) },
      {
        id: 'totals',
        title: 'Итого по всем контрактам',
        html:
          report.totals && Object.keys(report.totals).length > 0
            ? `<ul>${formatReportTotals(report.totals)
                .map((line) => `<li>${escapeHtml(line)}</li>`)
                .join('')}</ul>`
            : '<div class="muted">Нет итогов</div>',
      },
      {
        id: 'groups',
        title: 'Итоги по группам (ключевые метрики)',
        html:
          report.totalsByGroup && report.totalsByGroup.length > 0
            ? `<ul>${report.totalsByGroup
                .map(
                  (row) =>
                    `<li>${escapeHtml(row.group)}: ${escapeHtml(
                      formatReportTotals(row.totals).join(', '),
                    )}</li>`,
                )
                .join('')}</ul>`
            : '<div class="muted">Нет группировок</div>',
      },
      {
        id: 'metric-notes',
        title: 'Пояснение метрик',
        html:
          report.totals && Object.keys(report.totals).length > 0
            ? buildReportMetricNotes(report.totals).length > 0
              ? `<ul>${buildReportMetricNotes(report.totals).join('')}</ul>`
              : '<div class="muted">Нет пояснений</div>'
            : '<div class="muted">Нет данных</div>',
      },
    ];
    openPrintPreview({
      title: report.title,
      ...(report.subtitle ? { subtitle: report.subtitle } : {}),
      sections,
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

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <SectionCard title="Шаблоны отчетов" actions={<Button variant="ghost" onClick={() => void loadPresetMeta()} disabled={busy}>Обновить</Button>}>
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>Готовые пресеты для бухгалтерии и руководства. Фильтры можно изменять перед формированием отчета.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 8 }}>
            {presets.map((preset) => {
              const active = selectedPresetId === preset.id;
              return (
                <Button
                  key={preset.id}
                  variant={active ? 'primary' : 'ghost'}
                  onClick={() => {
                    setSelectedPresetId(preset.id);
                    setPreview(null);
                  }}
                  style={{ textAlign: 'left', display: 'grid', gap: 2, justifyItems: 'start' }}
                >
                  <span style={{ fontWeight: 800 }}>{preset.title}</span>
                  <span style={{ fontWeight: 500, fontSize: 12, whiteSpace: 'normal' }}>{preset.description}</span>
                </Button>
              );
            })}
          </div>
        </div>
      </SectionCard>

      <SectionCard title={activePreset ? `Фильтры: ${activePreset.title}` : 'Фильтры'}>
        {!activePreset ? (
          <div className="ui-muted">Выберите шаблон отчета.</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 8 }}>
              {activePreset.filters.map((filter) => {
                if (filter.type === 'date_range') {
                  return (
                    <div key={filter.key} style={{ display: 'grid', gap: 6 }}>
                      <div style={{ fontWeight: 700 }}>{filter.label}</div>
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
                    </label>
                  );
                }
                if (filter.type === 'select') {
                  const value = String(activeFilters[filter.key] ?? filter.options[0]?.value ?? '');
                  return (
                    <label key={filter.key} style={{ display: 'grid', gap: 6 }}>
                      <span style={{ fontWeight: 700 }}>{filter.label}</span>
                      <select
                        value={value}
                        onChange={(e) => patchFilter(filter.key, e.target.value)}
                        style={{ minHeight: 30, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
                      >
                        {filter.options.map((option) => (
                          <option key={`${filter.key}-${option.value}`} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                }
                const options = filter.optionsSource ? optionSets[filter.optionsSource] ?? [] : filter.options ?? [];
                const selected = Array.isArray(activeFilters[filter.key]) ? (activeFilters[filter.key] as unknown[]).map(String) : [];
                return (
                  <label key={filter.key} style={{ display: 'grid', gap: 6 }}>
                    <span style={{ fontWeight: 700 }}>{filter.label}</span>
                    <select
                      multiple
                      value={selected}
                      onChange={(e) => {
                        const values = Array.from(e.currentTarget.selectedOptions).map((opt) => opt.value);
                        patchFilter(filter.key, values);
                      }}
                      style={{ minHeight: 90, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
                    >
                      {options.map((option) => (
                        <option key={`${filter.key}-${option.value}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button onClick={() => void buildPreview()} disabled={busy}>
                Сформировать
              </Button>
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
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title={preview ? `Результат: ${preview.title}` : 'Результат'}>
        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', marginBottom: 8 }}>{status}</div> : null}
        {!preview ? (
          <div className="ui-muted">Сформируйте отчет для просмотра данных.</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {preview.subtitle ? <div className="ui-muted">{preview.subtitle}</div> : null}
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
                          {formatCell(column.kind ?? 'text', (row[column.key] ?? null) as ReportCellValue)}
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
                Итого по всем контрактам: {formatReportTotals(preview.totals).join(', ')}
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
