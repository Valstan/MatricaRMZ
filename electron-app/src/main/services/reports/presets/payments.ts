import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  CONTRACT_PAYMENTS_ATTR_CODE,
  PAYMENT_KIND_LABELS,
  countdownStatus,
  isEngineRepairedForCountdown,
  parseContractPayments,
  parseContractSections,
  slotTotals,
  type ContractPayments,
  type PaymentSlot,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  STATUS_CODES,
} from '@matricarmz/shared';

import { resolveContractLabel, normalizeText, asArray, readPeriod, msToDate } from '../format.js';
import { getPreset, loadSnapshot, getIdsByType } from '../context.js';
import { buildOptions, buildCounterpartyOptions, resolveCounterpartyLabel } from '../options.js';

// Отчёты по платежам за двигатели (план engine-payments-2026-07, этап 5).
// Источник — контрактный EAV-атрибут contract_payments (слоты + платежи в копейках).

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoToRu(iso: string | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

function kopToRub(kop: number): number {
  return Math.round(kop) / 100;
}

function sumByKind(slot: PaymentSlot, kinds: string[]): number {
  return slot.payments.filter((p) => kinds.includes(p.kind)).reduce((s, p) => s + p.amountKop, 0);
}

function engineRepairedFlags(attrs: Record<string, unknown>): Partial<Record<string, boolean>> {
  const flags: Partial<Record<string, boolean>> = {};
  for (const code of STATUS_CODES) flags[code] = Boolean(attrs[code]);
  return flags;
}

export async function buildContractPaymentsMatrixReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const contractId = normalizeText(filters?.contractId, '');
  const sectionToken = String(filters?.sectionToken ?? '').trim();
  const preset = getPreset('contract_payments_matrix');
  const snapshot = await loadSnapshot(db);
  if (!contractId) {
    return {
      ok: true,
      presetId: 'contract_payments_matrix',
      title: preset.title,
      subtitle: 'Выберите контракт в фильтрах',
      columns: preset.columns,
      rows: [],
      generatedAt: Date.now(),
    };
  }
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
  const sections = parseContractSections(attrs);
  const cp: ContractPayments = parseContractPayments(attrs[CONTRACT_PAYMENTS_ATTR_CODE]);
  const today = todayIso();

  const rows: Array<Record<string, ReportCellValue>> = [];
  let emptySlotIndex = 0;
  const slots = sectionToken ? cp.slots.filter((s) => s.sectionKey === sectionToken) : cp.slots;
  for (const slot of slots) {
    const engineAttrs = slot.engineId ? snapshot.attrsByEntity.get(slot.engineId) ?? {} : {};
    const engineNumber = slot.engineId ? normalizeText(engineAttrs.engine_number, '') : '';
    if (!slot.engineId) emptySlotIndex += 1;
    const engineLabel = slot.engineId
      ? engineNumber || slot.engineId.slice(0, 8)
      : `слот №${emptySlotIndex} (без двигателя)`;
    const brandId = slot.engineBrandId ?? (slot.engineId ? normalizeText(engineAttrs.engine_brand_id, '') : '');
    const totals = slotTotals(slot);
    const repaired = slot.engineId ? isEngineRepairedForCountdown(engineRepairedFlags(engineAttrs)) : false;
    const cd = countdownStatus(slot, today, repaired);
    const countdownLabel =
      cd.state === 'none'
        ? repaired
          ? 'отремонтирован'
          : '—'
        : (cd.daysLeft ?? 0) < 0
          ? `просрочка ${Math.abs(cd.daysLeft ?? 0)} дн.`
          : `осталось ${cd.daysLeft} дн.`;
    rows.push({
      engineLabel,
      brandLabel: brandId ? brandOptions.get(brandId) ?? '' : '',
      sectionToken: slot.sectionKey,
      priceRub: kopToRub(totals.priceKop),
      advanceRub: kopToRub(sumByKind(slot, ['advance'])),
      extraAdvanceRub: kopToRub(sumByKind(slot, ['extra_advance'])),
      finalRub: kopToRub(sumByKind(slot, ['final'])),
      paidRub: kopToRub(totals.paidKop),
      deltaRub: kopToRub(totals.deltaKop),
      lastPaymentDate: isoToRu(totals.lastPaymentDate),
      countdown: countdownLabel,
    });
  }
  rows.sort((a, b) =>
    String(a.sectionToken ?? '').localeCompare(String(b.sectionToken ?? ''), 'ru') ||
    String(a.engineLabel ?? '').localeCompare(String(b.engineLabel ?? ''), 'ru'),
  );
  const sum = (key: string) => rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
  const totals = {
    slots: rows.length,
    priceRub: sum('priceRub'),
    advanceRub: sum('advanceRub'),
    extraAdvanceRub: sum('extraAdvanceRub'),
    finalRub: sum('finalRub'),
    paidRub: sum('paidRub'),
    deltaRub: sum('deltaRub'),
  };
  const counterpartyId = normalizeText(sections.primary.customerId, '');
  const headerBits = [
    `Контракт: ${normalizeText(sections.primary.number, '') || contractOptions.get(contractId) || resolveContractLabel(contractId, contractOptions)}`,
    counterpartyId ? `Заказчик: ${resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId)}` : '',
    sections.primary.signedAt ? `заключён ${msToDate(sections.primary.signedAt)}` : '',
    sections.primary.dueAt ? `исполнение до ${msToDate(sections.primary.dueAt)}` : '',
    sectionToken ? `раздел: ${sectionToken}` : 'все разделы',
  ].filter(Boolean);
  return {
    ok: true,
    presetId: 'contract_payments_matrix',
    title: preset.title,
    subtitle: headerBits.join(' · '),
    columns: preset.columns,
    rows,
    totals,
    generatedAt: Date.now(),
  };
}

export async function buildPaymentsOverviewReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const contractFilter = asArray(filters?.contractIds);
  const preset = getPreset('payments_overview');
  const snapshot = await loadSnapshot(db);
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));

  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    if (contractFilter.length > 0 && !contractFilter.includes(contractId)) continue;
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const cp = parseContractPayments(attrs[CONTRACT_PAYMENTS_ATTR_CODE]);
    if (cp.slots.length === 0) continue;
    const sections = parseContractSections(attrs);
    const counterpartyId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    // Fallback на номер из секций: у deferred-create контракта displayName ещё пуст.
    const contractLabel =
      normalizeText(sections.primary.number, '') ||
      contractOptions.get(contractId) ||
      resolveContractLabel(contractId, contractOptions);
    const counterpartyLabel = resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId);
    let emptySlotIndex = 0;
    for (const slot of cp.slots) {
      if (!slot.engineId) emptySlotIndex += 1;
      const engineAttrs = slot.engineId ? snapshot.attrsByEntity.get(slot.engineId) ?? {} : {};
      const engineLabel = slot.engineId
        ? normalizeText(engineAttrs.engine_number, '') || slot.engineId.slice(0, 8)
        : `слот №${emptySlotIndex} (без двигателя)`;
      for (const p of slot.payments) {
        if (p.kind === 'contract_price') continue;
        const paymentMs = p.date ? Date.parse(`${p.date}T00:00:00`) : null;
        if (paymentMs != null) {
          if (period.startMs != null && paymentMs < period.startMs) continue;
          if (paymentMs > period.endMs) continue;
        }
        rows.push({
          paymentDate: isoToRu(p.date) || '—',
          contractLabel,
          counterpartyLabel,
          engineLabel,
          sectionToken: slot.sectionKey,
          kindLabel: PAYMENT_KIND_LABELS[p.kind],
          amountRub: kopToRub(p.amountKop),
          // скрытый ключ сортировки
          _sortDate: p.date,
        });
      }
    }
  }
  rows.sort((a, b) => String(b._sortDate ?? '').localeCompare(String(a._sortDate ?? '')));
  for (const r of rows) delete r._sortDate;
  const totals = {
    payments: rows.length,
    amountRub: rows.reduce((acc, r) => acc + Number(r.amountRub ?? 0), 0),
  };
  return {
    ok: true,
    presetId: 'payments_overview',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals,
    generatedAt: Date.now(),
  };
}
