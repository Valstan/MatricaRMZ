import { useState } from 'react';
import type { ReportCellValue, ReportPresetPreviewResult } from '@matricarmz/shared';

import { formatReportCell, formatReportTotals } from '../utils/reportUtils.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';

type PreviewOk = Extract<ReportPresetPreviewResult, { ok: true }>;

const FOOTER_LEAD_PREFIXES = [
  'Недовыпуск',
  'Комплектующие:',
  'Чтобы закрыть',
  'Марки без',
  'Контракт «',
  'Авто-приоритет',
  'Авто: нет контрактов',
  'Приоритет:',
  'Приоритетные марки',
];

function isFooterLeadLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith('•')) return false;
  return FOOTER_LEAD_PREFIXES.some((p) => t.startsWith(p));
}

function footerLineClass(line: string): string {
  const t = line.trim();
  if (t.startsWith('•')) return 'report-af-foot__line report-af-foot__line--bullet';
  if (isFooterLeadLine(line)) return 'report-af-foot__line report-af-foot__line--lead';
  return 'report-af-foot__line report-af-foot__line--text';
}

function StatusBadge({ text, code }: { text: string; code: string }) {
  const tone =
    code === 'ok'
      ? 'ok'
      : code === 'absent'
        ? 'bad'
        : code === 'weekend'
          ? 'neutral'
        : code === 'waiting' || code === 'shortage'
          ? 'partial'
          : 'neutral';
  return <span className={`report-af-status report-af-status--${tone}`}>{text}</span>;
}

type ForecastRowView = { dayLabel: string; engineBrand: string; status: string; statusCode: string; parts: string[] };

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function todayWorkOrderPrefix(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function printWorkOrder(args: { orderNumber: string; dayLabel: string; engineBrand: string; parts: string[] }) {
  const createdAt = new Date().toLocaleString('ru-RU');
  const headerTable = `
<table class="wo-header">
  <tbody>
    <tr><th>Номер наряда</th><td>${escapeHtml(args.orderNumber)}</td></tr>
    <tr><th>Дата создания</th><td>${escapeHtml(createdAt)}</td></tr>
    <tr><th>Плановый день сборки</th><td>${escapeHtml(args.dayLabel)}</td></tr>
    <tr><th>Двигатель</th><td>${escapeHtml(args.engineBrand)}</td></tr>
    <tr><th>Мастер / бригада</th><td class="wo-empty">&nbsp;</td></tr>
  </tbody>
</table>`;

  const partsRows =
    args.parts.length === 0
      ? '<tr><td colspan="2" class="muted">Нет данных о комплектующих</td></tr>'
      : args.parts
          .map((line, i) => {
            const sepIdx = line.indexOf(':');
            const name = sepIdx >= 0 ? line.slice(0, sepIdx).trim() : line.trim();
            const rest = sepIdx >= 0 ? line.slice(sepIdx + 1).trim() : '';
            return `<tr><td class="wo-num">${i + 1}</td><td class="wo-part"><div class="wo-part-name">${escapeHtml(name)}</div>${rest ? `<div class="wo-part-rest">${escapeHtml(rest)}</div>` : ''}</td></tr>`;
          })
          .join('');
  const partsTable = `
<table class="wo-parts">
  <thead><tr><th class="wo-num">№</th><th>Наименование, количество, место хранения</th></tr></thead>
  <tbody>${partsRows}</tbody>
</table>`;

  const signaturesTable = `
<table class="wo-sign">
  <tbody>
    <tr>
      <td><div class="wo-sign-role">Начальник цеха</div><div class="wo-sign-line">&nbsp;</div><div class="wo-sign-hint">подпись / Ф. И. О.</div></td>
      <td><div class="wo-sign-role">Мастер / бригадир</div><div class="wo-sign-line">&nbsp;</div><div class="wo-sign-hint">подпись / Ф. И. О.</div></td>
    </tr>
  </tbody>
</table>`;

  openPrintPreview({
    title: `Наряд-задание на сборку: ${args.orderNumber}`,
    subtitle: `${args.engineBrand} · ${args.dayLabel}`,
    sections: [
      { id: 'wo-header', title: 'Шапка наряда', html: `<style>${WORK_ORDER_PRINT_STYLES}</style>${headerTable}` },
      { id: 'wo-parts', title: 'Комплектующие', html: partsTable },
      { id: 'wo-sign', title: 'Подписи', html: signaturesTable },
    ],
  });
}

const WORK_ORDER_PRINT_STYLES = `
table.wo-header, table.wo-parts, table.wo-sign { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
table.wo-header th, table.wo-header td { border: 1px solid #111; padding: 6px 10px; vertical-align: top; text-align: left; }
table.wo-header th { width: 220px; background: #f3f4f6; font-weight: 600; }
table.wo-header td.wo-empty { min-height: 28px; }
table.wo-parts th, table.wo-parts td { border: 1px solid #111; padding: 6px 10px; vertical-align: top; text-align: left; }
table.wo-parts th { background: #f3f4f6; font-weight: 600; }
table.wo-parts td.wo-num, table.wo-parts th.wo-num { width: 36px; text-align: right; }
.wo-part-name { font-weight: 600; }
.wo-part-rest { color: #374151; font-size: 12px; margin-top: 2px; }
table.wo-sign td { border: 1px solid #111; padding: 14px 12px 6px 12px; width: 50%; vertical-align: bottom; }
.wo-sign-role { font-weight: 600; margin-bottom: 28px; }
.wo-sign-line { border-bottom: 1px solid #111; height: 1px; margin-bottom: 4px; }
.wo-sign-hint { font-size: 11px; color: #6b7280; }
`;

export function AssemblyForecastReportView(props: { preview: PreviewOk }) {
  const { preview } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (rowKey: string) =>
    setExpanded((prev) => ({
      ...prev,
      [rowKey]: !prev[rowKey],
    }));
  const subtitleParts = preview.subtitle?.split(' | ').map((s) => s.trim()).filter(Boolean) ?? [];
  const rows: ForecastRowView[] = preview.rows.map((row) => {
    const code = String((row as Record<string, unknown>)['_assemblyStatusCode'] ?? '');
    const statusCol = preview.columns.find((c) => c.key === 'status');
    const dayCol = preview.columns.find((c) => c.key === 'dayLabel');
    const brandCol = preview.columns.find((c) => c.key === 'engineBrand');
    const compCol = preview.columns.find((c) => c.key === 'requiredComponentsSummary');
    const status = formatReportCell(statusCol?.kind ?? 'text', (row['status'] ?? null) as ReportCellValue, 'status');
    const dayLabel = formatReportCell(dayCol?.kind ?? 'text', (row['dayLabel'] ?? null) as ReportCellValue, 'dayLabel');
    const engineBrand = formatReportCell(brandCol?.kind ?? 'text', (row['engineBrand'] ?? null) as ReportCellValue, 'engineBrand');
    const partsRaw = formatReportCell(compCol?.kind ?? 'text', (row['requiredComponentsSummary'] ?? null) as ReportCellValue, 'requiredComponentsSummary');
    const parts = partsRaw.split('\n').map((x) => x.trim()).filter(Boolean);
    return { dayLabel, engineBrand, status, statusCode: code, parts };
  });
  const byDay = new Map<string, ForecastRowView[]>();
  for (const row of rows) {
    const arr = byDay.get(row.dayLabel) ?? [];
    arr.push(row);
    byDay.set(row.dayLabel, arr);
  }

  return (
    <div className="report-af">
      {subtitleParts.length > 0 ? (
        <div className="report-af__meta" aria-label="Параметры расчёта">
          {subtitleParts.map((chunk, i) => (
            <span key={i} className="report-af__chip">
              {chunk}
            </span>
          ))}
        </div>
      ) : null}

      <div className="report-af-day-list">
        {(() => {
          let woCounter = 0;
          const woPrefix = todayWorkOrderPrefix();
          return Array.from(byDay.entries()).map(([dayLabel, dayRows], i) => {
            /** Печать наряда — только на первые 2 дня прогноза: дальше план может измениться. */
            const canPrintWorkOrder = i < 2;
            return (
              <section key={`${dayLabel}-${i}`} className="report-af-day">
                <div className="report-af-day__head">{dayLabel}</div>
                <div className="report-af-day__body">
                  {dayRows.map((r, idx) => {
                    const rowKey = `${dayLabel}-${idx}`;
                    const isOpen = Boolean(expanded[rowKey]);
                    const printable = canPrintWorkOrder && r.statusCode === 'ok' && r.parts.length > 0;
                    let orderNumberForRow = '';
                    if (printable) {
                      woCounter += 1;
                      orderNumberForRow = `НЗ-${woPrefix}-${pad2(woCounter)}`;
                    }
                    return (
                      <article key={rowKey} className="report-af-engine">
                        <div
                          className={`report-af-engine__head${r.parts.length > 0 ? ' report-af-engine__head--clickable' : ''}`}
                          role={r.parts.length > 0 ? 'button' : undefined}
                          tabIndex={r.parts.length > 0 ? 0 : undefined}
                          aria-expanded={r.parts.length > 0 ? isOpen : undefined}
                          onClick={r.parts.length > 0 ? () => toggleExpanded(rowKey) : undefined}
                          onKeyDown={
                            r.parts.length > 0
                              ? (e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    toggleExpanded(rowKey);
                                  }
                                }
                              : undefined
                          }
                        >
                          <div className="report-af-engine__brand">{r.engineBrand}</div>
                          <div className="report-af-engine__actions">
                            <StatusBadge text={r.status} code={r.statusCode} />
                            {printable ? (
                              <button
                                type="button"
                                className="report-af-engine__print"
                                title={`Распечатать наряд-задание ${orderNumberForRow}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  printWorkOrder({
                                    orderNumber: orderNumberForRow,
                                    dayLabel,
                                    engineBrand: r.engineBrand,
                                    parts: r.parts,
                                  });
                                }}
                              >
                                Распечатать наряд-задание
                              </button>
                            ) : null}
                            {r.parts.length > 0 ? (
                              <span
                                className={`report-af-engine__chevron${isOpen ? ' report-af-engine__chevron--open' : ''}`}
                                aria-hidden
                              />
                            ) : null}
                          </div>
                        </div>
                        {r.parts.length > 0 && isOpen ? (
                          <div className="report-af-engine__parts">
                            {r.parts.map((line, li) => (
                              <div key={`${idx}-${li}`} className="report-af-engine__part-line">
                                {line}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          });
        })()}
        {rows.length === 0 ? <div className="report-af-empty">Нет данных</div> : null}
      </div>

      {preview.totals && Object.keys(preview.totals).length > 0 ? (
        <div className="report-af-totals">
          <span className="report-af-totals__label">Итого по отчёту</span>
          <span className="report-af-totals__value">{formatReportTotals(preview.totals).join(' · ')}</span>
        </div>
      ) : null}

      {preview.footerNotes && preview.footerNotes.length > 0 ? (
        <div className="report-af-foot">
          <div className="report-af-foot__head">Пояснения</div>
          <div className="report-af-foot__body">
            {preview.footerNotes.map((line, i) => (
              <div key={`fn-${i}`} className={footerLineClass(line)}>
                {line}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
