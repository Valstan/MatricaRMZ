import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SyncTableName,
  canonicalContractSectionKey,
  contractSectionToken,
  parseContractSections,
  syncSlotsWithPlan,
  type AttachedEngineRef,
  type ContractPayments,
  type ContractSections,
  type PaymentKind,
  type PaymentSlot,
  type PlannedSectionBrand,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';

/**
 * contracts:resync-slots — разовая автораскладка «двигатели без слота» по строгой модели
 * (промты КАРМАНА #18/#19, шаг 3 плана #19).
 *
 * ЗАЧЕМ. Аудит 18.11.2026 (docs/reports/engine-payments-audit-2026-11-18.md) показал:
 * двигатели с разделом, но без места («сироты»), место не получают сами — сверка слотов с
 * планом идёт только при открытии карточки договора, а карточку открывают не всегда.
 * Карточка и этот скрипт зовут ОДНО доменное правило `syncSlotsWithPlan`, поэтому
 * «карточка открыта / не открыта» — не два правила, а разный момент запуска одного.
 *
 * ИСТОЧНИК ПРАВДЫ — строгие таблицы `erp_contract_payment_slots` / `erp_contract_payments`.
 * EAV-атрибут `contract_payments` с момента cutover не пишется (запись закрыта, см.
 * electron-app/src/renderer/src/ui/utils/contractPaymentsStore.ts), и зеркала strict→EAV нет
 * намеренно. Прежняя версия этого скрипта писала в EAV — а триггер зеркала EAV→strict делает
 * ПОЛНУЮ замену по контракту и снёс бы строки, созданные парком после cutover. Перепись на
 * strict — пункт плана contract-payments-strict-2026-10 (шаг 5, «перепись resyncContractSlots
 * на strict»).
 *
 * ЧТО ДЕЛАЕТ:
 *  - читает план договора (EAV `contract_sections` — тот же, что читает карточка), привязки
 *    двигателей (строгая `erp_engine_cards`) и текущие места с деньгами (строгие таблицы);
 *  - считает целевое состояние доменным правилом `syncSlotsWithPlan` (правда одна);
 *  - пишет ТОЛЬКО upsert-ы мест: новые места плана, посадку движков, перенос привязки.
 *
 * ЧТО НЕ ДЕЛАЕТ (осознанно):
 *  - не удаляет пустые места (без денег и без двигателя). Полная сверка их убирает, но удаление
 *    гасит строку, которая ещё есть в EAV-зеркале, и паритет-проверка (`payments:parity`)
 *    начинает кричать о «потере» там, где ничего не потеряно. Чистка — отдельный шаг с
 *    отдельным решением владельца; здесь она только считается и печатается;
 *  - не трогает деньги: строки платежей не пишутся вообще, сумма по контракту до и после
 *    обязана совпасть (не совпала — этот контракт не пишется);
 *  - не придумывает раздел: двигатель без раздела (`contract_section_number` пуст) места не
 *    получает — раздел определяет, к какому ДС относится аванс, и угадывать его = misallocate
 *    деньги. Такие двигатели идут в отчёте отдельной строкой.
 *
 * ГЕЙТЫ:
 *  - dry-run по умолчанию; запись только с `--apply`;
 *  - перед записью — снимок (JSON), откат — `--rollback <файл>`;
 *  - запись идёт через `writeSyncChanges` (журнал + seq) — парк видит обычным pull;
 *  - на проде запись = гейт #025 (необратимая операция с живыми данными) — по слову владельца.
 *
 * Usage:
 *   corepack pnpm -F @matricarmz/backend-api contracts:resync-slots            # отчёт, ничего не пишет
 *   corepack pnpm -F @matricarmz/backend-api contracts:resync-slots -- --apply # запись (+ снимок)
 *   corepack pnpm -F @matricarmz/backend-api contracts:resync-slots -- --contract <uuid>
 *   corepack pnpm -F @matricarmz/backend-api contracts:resync-slots -- --rollback <снимок.json>
 *   corepack pnpm -F @matricarmz/backend-api contracts:resync-slots -- --json
 *
 * Коды возврата: 0 — ок; 1 — расхождение сумм платежей; 2 — отказ/ошибка.
 */

const ACTOR: SyncWriteActor = { id: 'server', username: 'contracts:resync-slots', role: 'system' };

export type SlotDbRow = {
  id: string;
  contract_id: string;
  section_key: string;
  engine_brand_id: string | null;
  engine_id: string | null;
  contract_price_kop: string | null;
  created_at: number;
  updated_at: number;
};

type PaymentDbRow = {
  id: string;
  slot_id: string;
  date: string;
  amount_kop: string;
  kind: string;
  note: string | null;
  countdown_start: boolean;
};

type EngineRefRow = {
  id: string;
  contract_id: string;
  contract_section_number: string | null;
  engine_brand_id: string | null;
  engine_number: string | null;
};

/** Состояние места — то, чем слоты сравниваются между прогонами (без id-строк БД). */
export type SlotState = {
  id: string;
  sectionKey: string;
  engineBrandId: string | null;
  engineId: string | null;
  contractPriceKop: number | null;
};

export type PlacementKind = 'placed' | 'moved' | 'kept' | 'detached';

export type Placement = {
  engineId: string;
  engineNumber: string | null;
  sectionKey: string;
  engineBrandId: string | null;
  kind: PlacementKind;
  fromSectionKey: string | null;
  toSlotId: string | null;
  /** Место заведено сверх плана (двигателей больше, чем мест по плану). */
  overPlan: boolean;
};

export type SlotUpsert = {
  row: SlotDbRow;
  /** Места раньше не было — при откате его надо погасить, а не вернуть. */
  created: boolean;
  /** Прежнее состояние места (для отката). У нового места — null. */
  prev: SlotDbRow | null;
};

export type ContractPlan = {
  contractId: string;
  number: string;
  upserts: SlotUpsert[];
  /** Пустые места, которые полная сверка убрала бы. Не пишутся — только считаются. */
  emptyRemovals: number;
  placements: Placement[];
  /** Двигатели без раздела: места не получат, решение — за владельцем. */
  enginesWithoutSection: number;
  /** Двигатели без раздела, но сидящие в месте: правило домена их отвяжет. */
  detachedWithoutSection: number;
  moneyBeforeKop: number;
  moneyAfterKop: number;
  changed: boolean;
};

/** План договора по секциям и маркам — тот же расчёт, что в карточке контракта. */
export function plannedSectionsOf(sections: ContractSections): PlannedSectionBrand[] {
  const planned: PlannedSectionBrand[] = [];
  const push = (token: string, rows: ContractSections['primary']['engineBrands']) => {
    if (!token) return;
    for (const row of rows) {
      if (!row.engineBrandId || !(row.qty > 0)) continue;
      planned.push({ sectionKey: token, engineBrandId: row.engineBrandId, qty: row.qty, unitPrice: row.unitPrice });
    }
  };
  push(contractSectionToken(sections.primary), sections.primary.engineBrands);
  for (const addon of sections.addons) push(contractSectionToken(addon), addon.engineBrands);
  return planned;
}

/** Текущее состояние платежей контракта из строгих таблиц (тот же вид, что у клиента). */
export function buildCurrentPayments(slots: SlotDbRow[], payments: PaymentDbRow[]): ContractPayments {
  const paysBySlot = new Map<string, PaymentDbRow[]>();
  for (const p of payments) {
    const arr = paysBySlot.get(p.slot_id) ?? [];
    arr.push(p);
    paysBySlot.set(p.slot_id, arr);
  }
  return {
    version: 1,
    slots: slots.map((s) => ({
      id: s.id,
      sectionKey: s.section_key,
      ...(s.engine_brand_id ? { engineBrandId: s.engine_brand_id } : {}),
      ...(s.engine_id ? { engineId: s.engine_id } : {}),
      ...(s.contract_price_kop != null ? { contractPriceKop: Number(s.contract_price_kop) } : {}),
      payments: (paysBySlot.get(s.id) ?? []).map((p) => ({
        id: p.id,
        date: p.date,
        amountKop: Number(p.amount_kop),
        kind: p.kind as PaymentKind,
        ...(p.note ? { note: p.note } : {}),
        ...(p.countdown_start ? { countdownStart: true } : {}),
      })),
    })),
  };
}

export function slotStateOfSlot(slot: PaymentSlot): SlotState {
  return {
    id: slot.id,
    sectionKey: slot.sectionKey,
    engineBrandId: slot.engineBrandId ?? null,
    engineId: slot.engineId ?? null,
    contractPriceKop: slot.contractPriceKop ?? null,
  };
}

export function slotStateOfRow(row: SlotDbRow): SlotState {
  return {
    id: row.id,
    sectionKey: row.section_key,
    engineBrandId: row.engine_brand_id ?? null,
    engineId: row.engine_id ?? null,
    contractPriceKop: row.contract_price_kop != null ? Number(row.contract_price_kop) : null,
  };
}

export function sameSlotState(a: SlotState, b: SlotState): boolean {
  return (
    a.sectionKey === b.sectionKey &&
    a.engineBrandId === b.engineBrandId &&
    a.engineId === b.engineId &&
    a.contractPriceKop === b.contractPriceKop
  );
}

/** Сумма строк платежей — guard «суммы сходятся» (деньги не должны поехать). */
export function totalPaymentsKop(cp: ContractPayments): number {
  let sum = 0;
  for (const s of cp.slots) for (const p of s.payments) sum += Number(p.amountKop ?? 0);
  return sum;
}

function brandKey(sectionKey: string, brandId: string | null): string {
  return `${sectionKey}\u0000${brandId ?? ''}`;
}

/**
 * Раскладка двигателей: кто куда сядет и что изменится. `attached` — двигатели с разделом
 * (без раздела правило раздел не выдумывает), `current`/`next` — состояние до и после сверки.
 */
export function diffPlacements(
  attached: AttachedEngineRef[],
  current: ContractPayments,
  next: ContractPayments,
  numbers: Map<string, string | null>,
  planQtyByBrand: Map<string, number>,
): { placements: Placement[]; detachedWithoutSection: number } {
  const beforeByEngine = new Map<string, SlotState>();
  for (const s of current.slots) if (s.engineId) beforeByEngine.set(s.engineId, slotStateOfSlot(s));
  const afterByEngine = new Map<string, SlotState>();
  for (const s of next.slots) if (s.engineId) afterByEngine.set(s.engineId, slotStateOfSlot(s));

  // Места сверх плана: по (секция, марка) мест больше, чем по плану.
  const slotsByBrand = new Map<string, PaymentSlot[]>();
  for (const s of next.slots) {
    const key = brandKey(s.sectionKey, s.engineBrandId ?? null);
    const arr = slotsByBrand.get(key) ?? [];
    arr.push(s);
    slotsByBrand.set(key, arr);
  }
  const overPlanSlotIds = new Set<string>();
  for (const [key, slots] of slotsByBrand) {
    const planQty = planQtyByBrand.get(key) ?? 0;
    slots.forEach((s, idx) => {
      if (idx >= planQty) overPlanSlotIds.add(s.id);
    });
  }

  const placements: Placement[] = [];
  for (const a of attached) {
    const before = beforeByEngine.get(a.engineId);
    const after = afterByEngine.get(a.engineId);
    let kind: PlacementKind;
    if (!before && after) kind = 'placed';
    else if (before && after && before.sectionKey !== after.sectionKey) kind = 'moved';
    else if (before && after) kind = 'kept';
    else kind = 'detached';
    placements.push({
      engineId: a.engineId,
      engineNumber: numbers.get(a.engineId) ?? null,
      sectionKey: a.sectionKey,
      engineBrandId: a.engineBrandId ?? null,
      kind,
      fromSectionKey: before?.sectionKey ?? null,
      toSlotId: after?.id ?? null,
      overPlan: kind === 'placed' && !!after && overPlanSlotIds.has(after.id),
    });
  }
  // Двигатели без раздела в `attached` не попадают: правило их отвязывает, если они сидят в месте.
  let detachedWithoutSection = 0;
  for (const [engineId] of beforeByEngine) {
    if (attached.some((a) => a.engineId === engineId)) continue;
    if (!afterByEngine.has(engineId)) detachedWithoutSection += 1;
  }
  return { placements, detachedWithoutSection };
}

/** Upsert-ы мест: новые места плана, посадка движков, перенос привязки. Удалений здесь нет. */
export function diffSlots(
  contractId: string,
  currentRows: SlotDbRow[],
  next: ContractPayments,
  now: number,
): { upserts: SlotUpsert[]; emptyRemovals: number } {
  const currentById = new Map(currentRows.map((r) => [r.id, r]));
  const nextIds = new Set(next.slots.map((s) => s.id));
  const upserts: SlotUpsert[] = [];
  for (const slot of next.slots) {
    const st = slotStateOfSlot(slot);
    const prev = currentById.get(st.id);
    const price = st.contractPriceKop == null ? null : String(st.contractPriceKop);
    if (!prev) {
      upserts.push({
        created: true,
        prev: null,
        row: {
          id: st.id,
          contract_id: contractId,
          section_key: st.sectionKey,
          engine_brand_id: st.engineBrandId,
          engine_id: st.engineId,
          contract_price_kop: price,
          created_at: now,
          updated_at: now,
        },
      });
      continue;
    }
    if (sameSlotState(slotStateOfRow(prev), st)) continue;
    upserts.push({
      created: false,
      prev,
      row: {
        ...prev,
        section_key: st.sectionKey,
        engine_brand_id: st.engineBrandId,
        engine_id: st.engineId,
        contract_price_kop: price,
        // Стальнее чужой строки: applyPushBatch отбрасывает запись, чей updated_at старее
        // серверного (фильтр по seq/updated_at) — иначе правка молча не применилась бы.
        updated_at: Math.max(now, prev.updated_at + 1),
      },
    });
  }
  const emptyRemovals = currentRows.filter((r) => !nextIds.has(r.id)).length;
  return { upserts, emptyRemovals };
}

function toSyncInput(row: SlotDbRow): SyncWriteInput {
  return {
    type: 'upsert',
    table: SyncTableName.ErpContractPaymentSlots,
    row_id: row.id,
    row: {
      id: row.id,
      contract_id: row.contract_id,
      section_key: row.section_key,
      engine_brand_id: row.engine_brand_id,
      engine_id: row.engine_id,
      contract_price_kop: row.contract_price_kop == null ? null : Number(row.contract_price_kop),
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: null,
      sync_status: 'synced',
    },
  };
}

type Snapshot = {
  version: 1;
  createdAt: string;
  script: string;
  contracts: Array<{
    contractId: string;
    number: string;
    /** Места, существовавшие до записи: их прежнее состояние возвращается откатом. */
    before: SlotDbRow[];
    /** Места, созданные записью: откат их гасит. */
    created: SlotDbRow[];
  }>;
};

function parseArgs(argv: string[]): {
  apply: boolean;
  json: boolean;
  contract: string | null;
  rollback: string | null;
  snapshot: string | null;
  limit: number;
} {
  const out = {
    apply: false,
    json: false,
    contract: null as string | null,
    rollback: null as string | null,
    snapshot: null as string | null,
    limit: 40,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--') continue;
    else if (a === '--contract') out.contract = String(argv[++i] ?? '').trim() || null;
    else if (a === '--rollback') out.rollback = String(argv[++i] ?? '').trim() || null;
    else if (a === '--snapshot') out.snapshot = String(argv[++i] ?? '').trim() || null;
    else if (a === '--limit') {
      const next = Number(argv[++i]);
      if (Number.isFinite(next) && next >= 0) out.limit = Math.trunc(next);
    } else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function loadContracts(): Promise<Map<string, { number: string; sections: unknown }>> {
  const r = await pool.query(
    `SELECT e.id::text AS id, d.code AS code, av.value_json AS value_json
       FROM entities e
       JOIN entity_types t ON t.id = e.type_id AND t.code = 'contract' AND t.deleted_at IS NULL
       JOIN attribute_defs d ON d.entity_type_id = t.id AND d.code IN ('contract_sections', 'number') AND d.deleted_at IS NULL
       LEFT JOIN attribute_values av ON av.entity_id = e.id AND av.attribute_def_id = d.id AND av.deleted_at IS NULL
      WHERE e.deleted_at IS NULL`,
  );
  const out = new Map<string, { number: string; sections: unknown }>();
  const byContract = new Map<string, { number: string; sections: unknown }>();
  for (const row of r.rows as Array<{ id: string; code: string; value_json: unknown }>) {
    const id = String(row.id);
    const entry = byContract.get(id) ?? { number: '', sections: null };
    const raw = typeof row.value_json === 'string' ? safeJson(row.value_json) : row.value_json;
    if (row.code === 'number') entry.number = String(raw ?? '');
    else entry.sections = raw;
    byContract.set(id, entry);
  }
  for (const [id, value] of byContract) out.set(id, value);
  return out;
}

async function loadSlots(): Promise<Map<string, SlotDbRow[]>> {
  const r = await pool.query(
    `SELECT id::text AS id, contract_id::text AS contract_id, section_key, engine_brand_id::text AS engine_brand_id,
            engine_id::text AS engine_id, contract_price_kop::text AS contract_price_kop, created_at, updated_at
       FROM erp_contract_payment_slots
      WHERE deleted_at IS NULL`,
  );
  const byContract = new Map<string, SlotDbRow[]>();
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const arr = byContract.get(String(row.contract_id)) ?? [];
    arr.push({
      id: String(row.id),
      contract_id: String(row.contract_id),
      section_key: String(row.section_key ?? ''),
      engine_brand_id: row.engine_brand_id == null ? null : String(row.engine_brand_id),
      engine_id: row.engine_id == null ? null : String(row.engine_id),
      contract_price_kop: row.contract_price_kop == null ? null : String(row.contract_price_kop),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    });
    byContract.set(String(row.contract_id), arr);
  }
  return byContract;
}

async function loadPayments(): Promise<Map<string, PaymentDbRow[]>> {
  const r = await pool.query(
    `SELECT id::text AS id, slot_id::text AS slot_id, date, amount_kop::text AS amount_kop, kind, note, countdown_start
       FROM erp_contract_payments
      WHERE deleted_at IS NULL`,
  );
  const bySlot = new Map<string, PaymentDbRow[]>();
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const arr = bySlot.get(String(row.slot_id)) ?? [];
    arr.push({
      id: String(row.id),
      slot_id: String(row.slot_id),
      date: String(row.date ?? ''),
      amount_kop: String(row.amount_kop ?? '0'),
      kind: String(row.kind ?? ''),
      note: row.note == null ? null : String(row.note),
      countdown_start: row.countdown_start === true,
    });
    bySlot.set(String(row.slot_id), arr);
  }
  return bySlot;
}

async function loadEngines(): Promise<Map<string, EngineRefRow[]>> {
  const r = await pool.query(
    `SELECT id::text AS id, contract_id::text AS contract_id, contract_section_number,
            engine_brand_id::text AS engine_brand_id, engine_number
       FROM erp_engine_cards
      WHERE deleted_at IS NULL AND contract_id IS NOT NULL`,
  );
  const byContract = new Map<string, EngineRefRow[]>();
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const arr = byContract.get(String(row.contract_id)) ?? [];
    arr.push({
      id: String(row.id),
      contract_id: String(row.contract_id),
      contract_section_number: row.contract_section_number == null ? null : String(row.contract_section_number),
      engine_brand_id: row.engine_brand_id == null ? null : String(row.engine_brand_id),
      engine_number: row.engine_number == null ? null : String(row.engine_number),
    });
    byContract.set(String(row.contract_id), arr);
  }
  return byContract;
}

async function loadStrictContracts(): Promise<Map<string, { number: string; sections: unknown }>> {
  const r = await pool.query(
    `SELECT id::text AS id, number, sections_json FROM erp_contracts WHERE deleted_at IS NULL`,
  );
  const out = new Map<string, { number: string; sections: unknown }>();
  for (const row of r.rows as Array<{ id: string; number: unknown; sections_json: unknown }>) {
    const raw = typeof row.sections_json === 'string' ? safeJson(row.sections_json) : row.sections_json;
    out.set(String(row.id), { number: String(row.number ?? ''), sections: raw });
  }
  return out;
}

async function planContracts(contractFilter: string | null): Promise<{ plans: ContractPlan[]; missingContracts: string[] }> {
  const now = Date.now();
  const [eavContracts, strictContracts, slotsByContract, paysBySlot, enginesByContract] = await Promise.all([
    loadContracts(),
    loadStrictContracts(),
    loadSlots(),
    loadPayments(),
    loadEngines(),
  ]);

  // Контракт — это объединение: EAV-сущность и строка в `erp_contracts`. План берётся из
  // EAV-атрибута `contract_sections` (его же читает карточка), а при его отсутствии — из
  // зеркала `erp_contracts.sections_json`. Иначе контракт, созданный парком после cutover,
  // молча выпал бы из обработки.
  const contractIds = new Set<string>([...eavContracts.keys(), ...strictContracts.keys()]);
  const knownContracts = new Set<string>([...eavContracts.keys(), ...strictContracts.keys()]);
  const missingContracts = new Set<string>();
  for (const engineRows of enginesByContract.values()) {
    for (const e of engineRows) if (!knownContracts.has(e.contract_id)) missingContracts.add(e.contract_id);
  }

  const plans: ContractPlan[] = [];
  for (const contractId of contractIds) {
    if (contractFilter && contractId !== contractFilter) continue;
    const engineRows = enginesByContract.get(contractId) ?? [];
    if (engineRows.length === 0) continue;
    const eav = eavContracts.get(contractId);
    const strict = strictContracts.get(contractId);
    const meta = {
      number: eav?.number || strict?.number || '',
      sections: eav && eav.sections ? eav.sections : (strict?.sections ?? null),
    };
    const slotRows = slotsByContract.get(contractId) ?? [];
    const payments = slotRows.flatMap((s) => paysBySlot.get(s.id) ?? []);
    const current = buildCurrentPayments(slotRows, payments);

    const sections = parseContractSections({ contract_sections: meta.sections });
    const planned = plannedSectionsOf(sections);
    const attached: AttachedEngineRef[] = [];
    const numbers = new Map<string, string | null>();
    let enginesWithoutSection = 0;
    for (const e of engineRows) {
      numbers.set(e.id, e.engine_number);
      const sectionKey = canonicalContractSectionKey(e.contract_section_number);
      if (!sectionKey) {
        enginesWithoutSection += 1;
        continue;
      }
      attached.push({
        engineId: e.id,
        sectionKey,
        ...(e.engine_brand_id ? { engineBrandId: e.engine_brand_id } : {}),
      });
    }

    const next = syncSlotsWithPlan(current, planned, attached, randomUUID);
    const planQtyByBrand = new Map<string, number>();
    for (const p of planned) {
      const key = brandKey(p.sectionKey, p.engineBrandId);
      planQtyByBrand.set(key, (planQtyByBrand.get(key) ?? 0) + p.qty);
    }
    const { placements, detachedWithoutSection } = diffPlacements(attached, current, next, numbers, planQtyByBrand);
    const { upserts, emptyRemovals } = diffSlots(contractId, slotRows, next, now);

    plans.push({
      contractId,
      number: meta.number,
      upserts,
      emptyRemovals,
      placements,
      enginesWithoutSection,
      detachedWithoutSection,
      moneyBeforeKop: totalPaymentsKop(current),
      moneyAfterKop: totalPaymentsKop(next),
      changed: upserts.length > 0,
    });
  }
  return { plans, missingContracts: [...missingContracts] };
}

function printReport(plans: ContractPlan[], limit: number): void {
  const changed = plans.filter((p) => p.changed);
  const placed = plans.flatMap((p) => p.placements.filter((x) => x.kind === 'placed'));
  const moved = plans.flatMap((p) => p.placements.filter((x) => x.kind === 'moved'));
  const detached = plans.flatMap((p) => p.placements.filter((x) => x.kind === 'detached'));
  const withoutSection = plans.reduce((s, p) => s + p.enginesWithoutSection, 0);
  const detachedNoSection = plans.reduce((s, p) => s + p.detachedWithoutSection, 0);
  const emptyRemovals = plans.reduce((s, p) => s + p.emptyRemovals, 0);
  const upserts = plans.reduce((s, p) => s + p.upserts.length, 0);

  console.log(`Контрактов с двигателями: ${plans.length}; изменяется: ${changed.length}; строк к записи: ${upserts}`);
  console.log(
    `Двигатели: получат место — ${placed.length}; переедут в другой раздел — ${moved.length}; ` +
      `отвяжутся — ${detached.length + detachedNoSection}; без раздела (решение за владельцем) — ${withoutSection}`,
  );
  console.log(`Пустых мест, которые полная сверка убрала бы (не трогаем): ${emptyRemovals}`);

  let shown = 0;
  for (const plan of changed) {
    const interesting = plan.placements.filter((x) => x.kind === 'placed' || x.kind === 'moved');
    if (interesting.length === 0) continue;
    console.log(`\nКонтракт ${plan.number || plan.contractId.slice(0, 8)} (${plan.contractId.slice(0, 8)}):`);
    for (const x of interesting) {
      if (shown >= limit) break;
      shown += 1;
      const from = x.fromSectionKey ? `${x.fromSectionKey} → ` : '';
      console.log(
        `  ${x.engineNumber ?? x.engineId.slice(0, 8)}: ${from}${x.sectionKey}` +
          `${x.engineBrandId ? ` (марка ${x.engineBrandId.slice(0, 8)})` : ' (марка не указана)'}` +
          `${x.overPlan ? ' — сверх плана' : ''}`,
      );
    }
  }
  const total = placed.length + moved.length;
  if (total > shown) console.log(`\n… и ещё ${total - shown} двигателей (полный список — с --json)`);

  const moneyMismatch = plans.filter((p) => p.moneyBeforeKop !== p.moneyAfterKop);
  if (moneyMismatch.length > 0) {
    console.log(`\n✗ Расхождение сумм платежей в ${moneyMismatch.length} контрактах — запись не выполняется:`);
    for (const p of moneyMismatch) {
      console.log(`  ${p.number || p.contractId.slice(0, 8)}: ${p.moneyBeforeKop} → ${p.moneyAfterKop} коп.`);
    }
  }
}

async function applyPlans(plans: ContractPlan[], snapshotPath: string | null): Promise<void> {
  const rows = plans.flatMap((p) => p.upserts);
  if (rows.length === 0) {
    console.log('Менять нечего.');
    return;
  }
  const snapshot: Snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    script: 'contracts:resync-slots',
    contracts: plans
      .filter((p) => p.upserts.length > 0)
      .map((p) => ({
        contractId: p.contractId,
        number: p.number,
        before: p.upserts.filter((u) => u.prev).map((u) => u.prev!),
        created: p.upserts.filter((u) => u.created).map((u) => u.row),
      })),
  };
  const target = snapshotPath ?? join(tmpdir(), `matricarmz-resync-slots-${Date.now()}.json`);
  writeFileSync(target, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`Снимок (откат): ${target}`);

  const CHUNK = 500;
  let applied = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await writeSyncChanges(chunk.map((u) => toSyncInput(u.row)), ACTOR, { allowSyncConflicts: true });
    applied += chunk.length;
    console.log(`  записано ${applied}/${rows.length}`);
  }
  console.log(`Готово: ${applied} строк мест.`);
}

async function rollback(file: string): Promise<void> {
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
  const ts = Date.now();
  const inputs: SyncWriteInput[] = [];
  for (const c of snapshot.contracts) {
    for (const row of c.before) {
      inputs.push(toSyncInput({ ...row, updated_at: Math.max(ts, row.updated_at + 1) }));
    }
    for (const row of c.created) {
      inputs.push({
        type: 'delete',
        table: SyncTableName.ErpContractPaymentSlots,
        row_id: row.id,
        row: {
          id: row.id,
          contract_id: row.contract_id,
          section_key: row.section_key,
          engine_brand_id: row.engine_brand_id,
          engine_id: row.engine_id,
          contract_price_kop: row.contract_price_kop == null ? null : Number(row.contract_price_kop),
          created_at: row.created_at,
          updated_at: ts,
          deleted_at: ts,
          sync_status: 'synced',
        },
      });
    }
  }
  const CHUNK = 500;
  for (let i = 0; i < inputs.length; i += CHUNK) {
    await writeSyncChanges(inputs.slice(i, i + CHUNK), ACTOR, { allowSyncConflicts: true });
  }
  console.log(`Откат выполнен: строк ${inputs.length}.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.rollback) {
    await rollback(args.rollback);
    await pool.end();
    return;
  }
  console.log(`contracts:resync-slots — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);
  const { plans, missingContracts } = await planContracts(args.contract);
  const moneyMismatch = plans.filter((p) => p.moneyBeforeKop !== p.moneyAfterKop);
  if (missingContracts.length > 0) {
    console.log(
      `⚠ Движки ссылаются на ${missingContracts.length} контрактов, которых нет ни в EAV, ни в ` +
        `erp_contracts — они не обработаны: ${missingContracts.slice(0, 5).map((c) => c.slice(0, 8)).join(', ')}`,
    );
  }
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: moneyMismatch.length === 0,
          contracts: plans.length,
          changed: plans.filter((p) => p.changed).length,
          upserts: plans.reduce((s, p) => s + p.upserts.length, 0),
          emptyRemovals: plans.reduce((s, p) => s + p.emptyRemovals, 0),
          missingContracts,
          plans: plans.map((p) => ({
            contractId: p.contractId,
            number: p.number,
            upserts: p.upserts.length,
            emptyRemovals: p.emptyRemovals,
            enginesWithoutSection: p.enginesWithoutSection,
            detachedWithoutSection: p.detachedWithoutSection,
            placements: p.placements.filter((x) => x.kind !== 'kept'),
            moneyBeforeKop: p.moneyBeforeKop,
            moneyAfterKop: p.moneyAfterKop,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    printReport(plans, args.limit);
  }
  if (moneyMismatch.length > 0) {
    console.error('Суммы платежей разошлись — запись не выполняется.');
    await pool.end();
    process.exit(1);
  }
  if (!args.apply) {
    if (plans.some((p) => p.changed)) {
      console.log('\nDRY-RUN: ничего не записано. Повторить с --apply (на проде — по слову владельца, гейт #025).');
    }
    await pool.end();
    return;
  }
  await applyPlans(plans, args.snapshot);
  await pool.end();
}

/**
 * Импорт ради чистых функций не должен запускать прогон: тесты зовут `diffSlots` и
 * `diffPlacements` без базы. `realpathSync` — потому что pnpm водит скрипты через
 * симлинки, и голое сравнение путей дало бы ложное «не точка входа».
 */
function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return realpathSync(resolve(argv)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(2);
  });
}
