import type { ReportCellValue, ReportPresetPreviewResult } from '@matricarmz/shared';

import { formatReportCell, formatReportTotals } from '../utils/reportUtils.js';

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

export function AssemblyForecastReportView(props: { preview: PreviewOk }) {
  const { preview } = props;
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
        {Array.from(byDay.entries()).map(([dayLabel, dayRows], i) => (
          <section key={`${dayLabel}-${i}`} className="report-af-day">
            <div className="report-af-day__head">{dayLabel}</div>
            <div className="report-af-day__body">
              {dayRows.map((r, idx) => (
                <article key={`${dayLabel}-${idx}`} className="report-af-engine">
                  <div className="report-af-engine__head">
                    <div className="report-af-engine__brand">{r.engineBrand}</div>
                    <StatusBadge text={r.status} code={r.statusCode} />
                  </div>
                  {r.parts.length > 0 ? (
                    <div className="report-af-engine__parts">
                      {r.parts.map((line, li) => (
                        <div key={`${idx}-${li}`} className="report-af-engine__part-line">
                          {line}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ))}
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
