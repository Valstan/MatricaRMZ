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
        : code === 'waiting' || code === 'shortage'
          ? 'partial'
          : 'neutral';
  return <span className={`report-af-status report-af-status--${tone}`}>{text}</span>;
}

function ConsumptionBlock({ text }: { text: string }) {
  const lines = text.split('\n').filter((s) => s.trim().length > 0);
  if (lines.length <= 1) {
    return <div className="report-af-consume">{text}</div>;
  }
  return (
    <div className="report-af-consume">
      {lines.map((line, i) => (
        <div key={i} className="report-af-consume__row">
          {line}
        </div>
      ))}
    </div>
  );
}

export function AssemblyForecastReportView(props: { preview: PreviewOk }) {
  const { preview } = props;
  const subtitleParts = preview.subtitle?.split(' | ').map((s) => s.trim()).filter(Boolean) ?? [];

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

      <div className="report-af__table-wrap">
        <table className="report-af-table">
          <thead>
            <tr>
              {preview.columns.map((column) => (
                <th
                  key={column.key}
                  className={`report-af-th report-af-th--${column.key}`}
                  style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, idx) => {
              const code = String((row as Record<string, unknown>)['_assemblyStatusCode'] ?? '');
              const rowMod =
                code === 'ok'
                  ? 'ok'
                  : code === 'waiting'
                    ? 'wait'
                    : code === 'shortage' || code === 'absent'
                      ? 'short'
                      : 'neutral';
              return (
                <tr key={`report-row-${idx}`} className={`report-af-tr report-af-tr--${rowMod}`}>
                  {preview.columns.map((column) => {
                    const raw = (row[column.key] ?? null) as ReportCellValue;
                    const text = formatReportCell(column.kind ?? 'text', raw, column.key);
                    return (
                      <td
                        key={`${idx}-${column.key}`}
                        className={`report-af-td report-af-td--${column.key}`}
                        style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}
                      >
                        {column.key === 'status' ? (
                          <StatusBadge text={text} code={code} />
                        ) : column.key === 'requiredComponentsSummary' ? (
                          <ConsumptionBlock text={text} />
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {preview.rows.length === 0 ? (
              <tr>
                <td colSpan={preview.columns.length} className="report-af-td report-af-td--empty">
                  Нет данных
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
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
