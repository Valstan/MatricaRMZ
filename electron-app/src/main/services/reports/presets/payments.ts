import { isNull, max } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  CONTRACT_PAYMENTS_ATTR_CODE,
  PAYMENT_KIND_LABELS,
  countdownStatus,
  effectiveRepairDays,
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
  isEavFlagSet,
  HUMAN_LABEL_DASH,
  pickHumanText,
} from '@matricarmz/shared';

import { resolveContractLabel, normalizeText, asArray, readPeriod, msToDate, toNumber } from '../format.js';
import { getPreset, loadSnapshot, getIdsByType } from '../context.js';
import { operations } from '../../../database/schema.js';
import {
  buildOptions,
  buildCounterpartyOptions,
  resolveCounterpartyLabel,
  UNKNOWN_ENGINE_NUMBER_LABEL,
} from '../options.js';

// Отчёты по платежам за двигатели (план engine-payments-2026-07, этап 5).
// Источник — контрактный EAV-атрибут contract_payments (слоты + платежи в копейках).

// Мс → ключ суток «yyyy-mm-dd», как того ждёт `countdownStatus`. Геттеры локальные, а не
// UTC-срез: `arrival_date` карточка пишет локальной полуночью, и `toISOString()` сдвинул бы
// дату поступления на сутки назад. Пусто — даты нет (отсчёту не от чего идти).
function isoDayKey(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayIso(): string {
  return isoDayKey(Date.now());
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
  for (const code of STATUS_CODES) flags[code] = isEavFlagSet(attrs[code]);
  return flags;
}

// Ключ раздела договора: 'primary' — основной договор, «ДС n» — дополнительное
// соглашение. Оператору служебное слово primary ничего не говорит.
function sectionLabel(sectionKey: string): string {
  const key = String(sectionKey ?? '').trim();
  if (!key) return HUMAN_LABEL_DASH;
  return key === 'primary' ? 'Основной договор' : key;
}

/**
 * Дата последней ЛЮБОЙ операции по двигателю, ISO-день. Нужна, чтобы отчёт называл забытые
 * карточки так же, как список контрактов: без неё «просрочка 700 дн.» стояла бы здесь у тех
 * же двигателей, которые в списке уже помечены «без движения» (замер на проде 22.09.2026).
 */
async function loadLastActivityIsoByEngine(db: BetterSQLite3Database): Promise<Map<string, string>> {
  const rows = await db
    .select({ engineEntityId: operations.engineEntityId, lastAt: max(operations.updatedAt) })
    .from(operations)
    .where(isNull(operations.deletedAt))
    .groupBy(operations.engineEntityId);
  const out = new Map<string, string>();
  for (const row of rows as Array<{ engineEntityId: unknown; lastAt: unknown }>) {
    const id = String(row.engineEntityId ?? '').trim();
    const at = Number(row.lastAt ?? 0);
    if (!id || !Number.isFinite(at) || at <= 0) continue;
    const iso = isoDayKey(at);
    if (iso) out.set(id, iso);
  }
  return out;
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
  // Срок ремонта — из этого контракта: у каждого он свой (владелец 22.09.2026).
  const repairDays = effectiveRepairDays(sections);
  const lastActivityIsoByEngine = await loadLastActivityIsoByEngine(db);

  const rows: Array<Record<string, ReportCellValue>> = [];
  let emptySlotIndex = 0;
  // Колонка показывает «Основной договор», поэтому фильтр обязан принимать и подпись,
  // и служебный ключ — иначе введённое из отчёта значение не находит ничего.
  const slots = sectionToken
    ? cp.slots.filter((s) => s.sectionKey === sectionToken || sectionLabel(s.sectionKey) === sectionToken)
    : cp.slots;
  for (const slot of slots) {
    const engineAttrs = slot.engineId ? snapshot.attrsByEntity.get(slot.engineId) ?? {} : {};
    const engineNumber = slot.engineId ? normalizeText(engineAttrs.engine_number, '') : '';
    if (!slot.engineId) emptySlotIndex += 1;
    const engineLabel = slot.engineId
      ? engineNumber || UNKNOWN_ENGINE_NUMBER_LABEL
      : `слот №${emptySlotIndex} (без двигателя)`;
    const brandId = slot.engineBrandId ?? (slot.engineId ? normalizeText(engineAttrs.engine_brand_id, '') : '');
    const totals = slotTotals(slot);
    const repaired = slot.engineId ? isEngineRepairedForCountdown(engineRepairedFlags(engineAttrs)) : false;
    // Точка отсчёта — приезд двигателя на завод, а не аванс (владелец 22.09.2026).
    const arrivalIso = slot.engineId ? isoDayKey(toNumber(engineAttrs.arrival_date)) : '';
    const lastActivityIso = slot.engineId ? lastActivityIsoByEngine.get(slot.engineId) ?? '' : '';
    const cd = countdownStatus(slot, today, repaired, { arrivalIso, lastActivityIso, days: repairDays });
    const countdownLabel =
      cd.state === 'none'
        ? repaired
          ? 'отремонтирован'
          : slot.engineId && !arrivalIso
            // Не прочерк: отсчёта нет именно потому, что не заполнена дата поступления, —
            // это работа оператора, а не «данных нет».
            ? 'нет даты поступления'
            : '—'
        : cd.state === 'stale'
          // Срок формально вышел, но по двигателю давно не работали: это неразобранный
          // учёт, а не срыв ремонта, и называть его просрочкой отчёт не должен.
          ? `без движения ${cd.daysIdle ?? 0} дн.`
          : (cd.daysLeft ?? 0) < 0
            ? `просрочка ${Math.abs(cd.daysLeft ?? 0)} дн.`
            : `осталось ${cd.daysLeft} дн.`;
    rows.push({
      engineLabel,
      brandLabel: brandId ? pickHumanText(brandOptions.get(brandId)) : '',
      sectionToken: sectionLabel(slot.sectionKey),
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
    // Колонка «Срок ремонта» печатает только остаток — без этой строки читатель не знает,
    // от какого срока и от какого события он отсчитан.
    `срок ремонта: ${repairDays} дн. с даты поступления двигателя`,
    sectionToken ? `раздел: ${sectionLabel(sectionToken)}` : 'все разделы',
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
        ? normalizeText(engineAttrs.engine_number, '') || UNKNOWN_ENGINE_NUMBER_LABEL
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
          sectionToken: sectionLabel(slot.sectionKey),
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
