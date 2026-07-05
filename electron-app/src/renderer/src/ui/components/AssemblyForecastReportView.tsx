import { useState } from 'react';
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

type ForecastRequiredPart = { partId: string; qty: number; partLabel: string; sourceWarehouseId?: string };
type ExistingAssemblyOrder = { operationId: string; workOrderNumber: number };

type ForecastRowView = {
  dayLabel: string;
  engineBrand: string;
  status: string;
  statusCode: string;
  parts: string[];
  brandId: string;
  variantKey: string;
  requiredParts: ForecastRequiredPart[];
  existingOrder: ExistingAssemblyOrder | null;
  /** Stage 4 followup (v1.29.2): если прогноз построен с фильтром `assemblyForecastOnSiteOnly`,
   * row уже привязан к конкретному двигателю «в ремонте» — передаём в наряд. */
  onSiteEngineId: string;
  onSiteEngineNumber: string;
};

function parseRequiredParts(raw: unknown): ForecastRequiredPart[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
      .map((p) => {
        const sourceWarehouseId = String(p.sourceWarehouseId ?? '').trim();
        return {
          partId: String(p.partId ?? '').trim(),
          qty: Math.max(0, Math.floor(Number(p.qty ?? 0))),
          partLabel: String(p.partLabel ?? '').trim(),
          ...(sourceWarehouseId ? { sourceWarehouseId } : {}),
        };
      })
      .filter((p) => p.partId && p.qty > 0);
  } catch {
    return [];
  }
}

function parseExistingOrder(raw: unknown): ExistingAssemblyOrder | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    const operationId = String(rec.operationId ?? '').trim();
    const workOrderNumber = Math.max(0, Math.floor(Number(rec.workOrderNumber ?? 0)));
    if (!operationId) return null;
    return { operationId, workOrderNumber };
  } catch {
    return null;
  }
}

export function AssemblyForecastReportView(props: {
  preview: PreviewOk;
  onOpenWorkOrder?: (operationId: string) => void;
  /** Ф2 forecast-remfond-aware: открыть карточку созданной заявки в снабжение (deferred-create seed). */
  onOpenSupplyRequest?: (id: string, payload: unknown) => void;
}) {
  const { preview, onOpenWorkOrder, onOpenSupplyRequest } = props;
  const [supplyBusy, setSupplyBusy] = useState(false);
  const [supplyMsg, setSupplyMsg] = useState('');
  const purchaseDeficits = (preview.assemblyDeficits ?? []).filter((d) => d.toPurchase > 0);

  // Дефицит → предзаполненная заявка в снабжение: позиции toPurchase > 0 (то, что не
  // закрывается ремонтом из ремфонда). productId = nomenclatureId (part id == nomenclature id).
  async function handleCreateSupplyRequest() {
    if (supplyBusy || purchaseDeficits.length === 0 || !onOpenSupplyRequest) return;
    setSupplyBusy(true);
    setSupplyMsg('');
    try {
      const r = await window.matrica.supplyRequests.create();
      if (!r.ok) {
        setSupplyMsg(`Ошибка: ${r.error}`);
        return;
      }
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const payload = {
        ...(r.payload as Record<string, unknown>),
        title: `Дефицит прогноза сборки от ${dd}.${mm}.${today.getFullYear()}`,
        items: purchaseDeficits.map((d, i) => ({
          lineNo: i + 1,
          productId: d.nomenclatureId,
          name: d.partLabel,
          qty: d.toPurchase,
          note: d.coverableByRepairFund > 0 ? `Дефицит ${d.deficit}, ремонтом закрывается ${d.coverableByRepairFund}` : null,
        })),
      };
      onOpenSupplyRequest(r.id, payload);
    } catch (e) {
      setSupplyMsg(`Ошибка: ${String(e)}`);
    } finally {
      setSupplyBusy(false);
    }
  }
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyRowKey, setBusyRowKey] = useState<string | null>(null);
  const [rowMessageByKey, setRowMessageByKey] = useState<Record<string, { kind: 'success' | 'error'; text: string }>>({});
  // Локально храним только что созданные наряды — чтобы кнопка стала disabled сразу после клика,
  // не дожидаясь регенерации прогноза.
  const [locallyCreated, setLocallyCreated] = useState<Record<string, ExistingAssemblyOrder>>({});

  const toggleExpanded = (rowKey: string) =>
    setExpanded((prev) => ({
      ...prev,
      [rowKey]: !prev[rowKey],
    }));
  const subtitleParts = preview.subtitle?.split(' | ').map((s) => s.trim()).filter(Boolean) ?? [];
  const rows: ForecastRowView[] = preview.rows.map((row) => {
    const rec = row as Record<string, unknown>;
    const code = String(rec['_assemblyStatusCode'] ?? '');
    const statusCol = preview.columns.find((c) => c.key === 'status');
    const dayCol = preview.columns.find((c) => c.key === 'dayLabel');
    const brandCol = preview.columns.find((c) => c.key === 'engineBrand');
    const compCol = preview.columns.find((c) => c.key === 'requiredComponentsSummary');
    const status = formatReportCell(statusCol?.kind ?? 'text', (row['status'] ?? null) as ReportCellValue, 'status');
    const dayLabel = formatReportCell(dayCol?.kind ?? 'text', (row['dayLabel'] ?? null) as ReportCellValue, 'dayLabel');
    const engineBrand = formatReportCell(brandCol?.kind ?? 'text', (row['engineBrand'] ?? null) as ReportCellValue, 'engineBrand');
    const partsRaw = formatReportCell(compCol?.kind ?? 'text', (row['requiredComponentsSummary'] ?? null) as ReportCellValue, 'requiredComponentsSummary');
    const parts = partsRaw.split('\n').map((x) => x.trim()).filter(Boolean);
    const brandId = String(rec['_assemblyBrandId'] ?? '');
    const variantKey = String(rec['_assemblyVariantKey'] ?? '');
    const requiredParts = parseRequiredParts(rec['_assemblyRequiredPartsJson']);
    const existingOrder = parseExistingOrder(rec['_assemblyExistingOrderJson']) ?? locallyCreated[variantKey] ?? null;
    const onSiteEngineId = String(rec['_assemblyOnSiteEngineId'] ?? '');
    const onSiteEngineNumber = String(rec['_assemblyOnSiteEngineNumber'] ?? '');
    return {
      dayLabel,
      engineBrand,
      status,
      statusCode: code,
      parts,
      brandId,
      variantKey,
      requiredParts,
      existingOrder,
      onSiteEngineId,
      onSiteEngineNumber,
    };
  });
  const byDay = new Map<string, ForecastRowView[]>();
  for (const row of rows) {
    const arr = byDay.get(row.dayLabel) ?? [];
    arr.push(row);
    byDay.set(row.dayLabel, arr);
  }

  async function handleCreateWorkOrder(rowKey: string, row: ForecastRowView) {
    if (busyRowKey) return;
    if (!row.variantKey || row.requiredParts.length === 0) {
      setRowMessageByKey((prev) => ({ ...prev, [rowKey]: { kind: 'error', text: 'Нет данных варианта для создания наряда.' } }));
      return;
    }
    setBusyRowKey(rowKey);
    setRowMessageByKey((prev) => {
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
    try {
      const r = await window.matrica.workOrders.createAssemblyFromForecast({
        variantKey: row.variantKey,
        brandId: row.brandId,
        engineBrandName: row.engineBrand,
        requiredParts: row.requiredParts.map((p) => ({
          partId: p.partId,
          qty: p.qty,
          partLabel: p.partLabel,
          ...(p.sourceWarehouseId ? { sourceWarehouseId: p.sourceWarehouseId } : {}),
        })),
        ...(row.onSiteEngineId ? { engineId: row.onSiteEngineId } : {}),
        ...(row.onSiteEngineNumber ? { engineNumber: row.onSiteEngineNumber } : {}),
      });
      if (!r.ok) {
        setRowMessageByKey((prev) => ({ ...prev, [rowKey]: { kind: 'error', text: `Ошибка: ${r.error}` } }));
        return;
      }
      setLocallyCreated((prev) => ({ ...prev, [row.variantKey]: { operationId: r.id, workOrderNumber: r.workOrderNumber } }));
      setRowMessageByKey((prev) => ({
        ...prev,
        [rowKey]: { kind: 'success', text: `Наряд №${r.workOrderNumber} создан. Откройте карточку, чтобы привязать двигатель и сохранить как черновик.` },
      }));
      if (onOpenWorkOrder) onOpenWorkOrder(r.id);
    } catch (e) {
      setRowMessageByKey((prev) => ({ ...prev, [rowKey]: { kind: 'error', text: `Ошибка: ${String(e)}` } }));
    } finally {
      setBusyRowKey(null);
    }
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
        {Array.from(byDay.entries()).map(([dayLabel, dayRows], i) => {
          /** Кнопка создания наряда — только на первые 2 дня прогноза: дальше план может измениться. */
          const canCreateWorkOrder = i < 2;
          return (
            <section key={`${dayLabel}-${i}`} className="report-af-day">
              <div className="report-af-day__head">{dayLabel}</div>
              <div className="report-af-day__body">
                {dayRows.map((r, idx) => {
                  const rowKey = `${dayLabel}-${idx}`;
                  const isOpen = Boolean(expanded[rowKey]);
                  const isCreatable = canCreateWorkOrder && r.statusCode === 'ok' && r.requiredParts.length > 0 && Boolean(r.variantKey);
                  const isBlocked = Boolean(r.existingOrder);
                  const rowMessage = rowMessageByKey[rowKey];
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
                          {isCreatable && isBlocked ? (
                            <button
                              type="button"
                              className="report-af-engine__print"
                              disabled
                              title={`По этому варианту уже выписан наряд №${r.existingOrder!.workOrderNumber}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (onOpenWorkOrder) onOpenWorkOrder(r.existingOrder!.operationId);
                              }}
                            >
                              Наряд №{r.existingOrder!.workOrderNumber} выписан
                            </button>
                          ) : isCreatable ? (
                            <button
                              type="button"
                              className="report-af-engine__print"
                              disabled={busyRowKey === rowKey}
                              title="Создать сборочный наряд с предзаполненными деталями. В карточке наряда нужно будет привязать двигатель и сохранить как черновик."
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleCreateWorkOrder(rowKey, r);
                              }}
                            >
                              {busyRowKey === rowKey ? 'Создаю…' : 'Создать наряд на сборку'}
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
                      {rowMessage ? (
                        <div
                          className="report-af-engine__row-msg"
                          style={{
                            color: rowMessage.kind === 'error' ? 'var(--danger)' : 'var(--subtle)',
                            fontSize: 12,
                            padding: '4px 12px 0',
                          }}
                        >
                          {rowMessage.text}
                        </div>
                      ) : null}
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
        })}
        {rows.length === 0 ? <div className="report-af-empty">Нет данных</div> : null}
      </div>

      {preview.totals && Object.keys(preview.totals).length > 0 ? (
        <div className="report-af-totals">
          <span className="report-af-totals__label">Итого по отчёту</span>
          <span className="report-af-totals__value">{formatReportTotals(preview.totals).join(' · ')}</span>
        </div>
      ) : null}

      {purchaseDeficits.length > 0 && onOpenSupplyRequest ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="report-af-engine__print"
            disabled={supplyBusy}
            title="Создать заявку в снабжение с предзаполненными позициями закупки (дефицит минус то, что закрывается ремонтом из ремфонда)"
            onClick={() => void handleCreateSupplyRequest()}
          >
            {supplyBusy ? 'Создаю…' : `Создать заявку в снабжение (${purchaseDeficits.length} позиц.)`}
          </button>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Позиции с закупкой: дефицит, который не закрывается ремфондом.
          </span>
          {supplyMsg ? <span style={{ fontSize: 12, color: 'var(--danger)' }}>{supplyMsg}</span> : null}
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
