/* -------------------------------------------------------------------------- *
 * Версионируемые снимки актов двигателя (engine-acts Фаза 2).
 *
 * Владелец (2026-06-09): «каждая печать = новая версия, старые сохраняются»
 * → версия акта фиксируется при печати как отдельная строка `operations`
 * (operationType = 'completeness_act' / 'defect_act', payload — плоско в
 * meta_json). НЕ EAV двигателя (§2-предохранитель). Носитель версий = новый
 * тип operations (brain одобрил «отдельный лог-носитель»).
 * -------------------------------------------------------------------------- */

import type { EngineInventoryRow } from './repairChecklist.js';
import type { RepairChecklistAnswers } from './repairChecklist.js';

/** operationType строки-снимка акта (свободный текст operations.operationType). */
export const ENGINE_COMPLETENESS_ACT_TYPE = 'completeness_act' as const;
export const ENGINE_DEFECT_ACT_TYPE = 'defect_act' as const;
/** Ф4: претензия заказчику — дефектные детали на ветке «заказчик» + недостача комплектности. */
export const ENGINE_CLAIM_ACT_TYPE = 'claim_act' as const;

export type EngineActType = 'completeness' | 'defect' | 'claim';

export function actOperationType(actType: EngineActType): string {
  if (actType === 'defect') return ENGINE_DEFECT_ACT_TYPE;
  if (actType === 'claim') return ENGINE_CLAIM_ACT_TYPE;
  return ENGINE_COMPLETENESS_ACT_TYPE;
}

/** Одна недостающая позиция акта комплектности. */
export type InventoryShortageItem = {
  part_name: string;
  /** № сборочной единицы (= артикул детали; решение владельца 2026-06-12). */
  assembly_unit_number: string;
  part_number: string;
  quantity: number;
  actual_qty: number;
  /** Сколько не хватает (quantity - actual_qty, >= 1). */
  missing: number;
};

export type InventoryShortageSummary = {
  /** Число позиций с недостачей. */
  total: number;
  /** Суммарно недостающих единиц. */
  missingUnits: number;
  items: InventoryShortageItem[];
};

/**
 * Недостача по акту комплектности: позиция «недоукомплектована», если фактически
 * принято меньше плана (`actual_qty < quantity`). Нормализация уже сводит
 * `present=false` к `actual_qty=0`, поэтому отдельная проверка present не нужна.
 */
export function computeInventoryShortage(rows: ReadonlyArray<EngineInventoryRow>): InventoryShortageSummary {
  const items: InventoryShortageItem[] = [];
  let missingUnits = 0;
  for (const r of rows) {
    const quantity = Math.max(0, Math.floor(Number(r.quantity) || 0));
    const actual = Math.max(0, Math.floor(Number(r.actual_qty) || 0));
    const missing = quantity - actual;
    if (missing <= 0) continue;
    missingUnits += missing;
    items.push({
      part_name: String(r.part_name ?? ''),
      assembly_unit_number: String(r.assembly_unit_number ?? ''),
      part_number: String(r.part_number ?? ''),
      quantity,
      actual_qty: actual,
      missing,
    });
  }
  return { total: items.length, missingUnits, items };
}

/* ----------------------------- Претензия (Ф4) ----------------------------- */

/** Одна позиция претензии: дефектная деталь, восполнение которой — за заказчиком. */
export type CustomerClaimItem = {
  part_name: string;
  assembly_unit_number: string;
  part_number: string;
  quantity: number;
  scrap_qty: number;
  replace_qty: number;
  /** Единиц к восполнению заказчиком (утиль + заменить). */
  claim_qty: number;
};

export type CustomerClaimSummary = {
  /** Число позиций претензии. */
  total: number;
  /** Суммарно единиц к восполнению заказчиком. */
  claimUnits: number;
  items: CustomerClaimItem[];
};

/**
 * Претензия заказчику = дефектные строки (утиль или замена > 0), маршрутизированные
 * на ветку восполнения «заказчик». Недостача комплектности в позиции НЕ входит —
 * она идёт отдельной секцией печатной формы (computeInventoryShortage).
 */
export function computeCustomerClaim(rows: ReadonlyArray<EngineInventoryRow>): CustomerClaimSummary {
  const items: CustomerClaimItem[] = [];
  let claimUnits = 0;
  for (const r of rows) {
    if (r.replenishment_branch !== 'customer') continue;
    const scrap = Math.max(0, Math.floor(Number(r.scrap_qty) || 0));
    const replace = Math.max(0, Math.floor(Number(r.replace_qty) || 0));
    const claim = scrap + replace;
    if (claim <= 0) continue;
    claimUnits += claim;
    items.push({
      part_name: String(r.part_name ?? ''),
      assembly_unit_number: String(r.assembly_unit_number ?? ''),
      part_number: String(r.part_number ?? ''),
      quantity: Math.max(0, Math.floor(Number(r.quantity) || 0)),
      scrap_qty: scrap,
      replace_qty: replace,
      claim_qty: claim,
    });
  }
  return { total: items.length, claimUnits, items };
}

/** Снимок акта двигателя — версионируемый payload в operations.meta_json. */
export type EngineActSnapshotPayload = {
  kind: 'engine_act_snapshot';
  actType: EngineActType;
  engineEntityId: string;
  /** Монотонная версия в пределах (двигатель, actType). 1-based. */
  version: number;
  /** Строки, вошедшие в акт (отмеченные в печать; если выбора не было — все). */
  rows: EngineInventoryRow[];
  /** Резолвленная шапка для повторной печати исторического снимка. */
  header: { engineBrand: string; engineNumber: string; contractNumber: string };
  /** Ответы шаблона на момент печати (даты, подписи) — чтобы повтор печати был точным. */
  answers: RepairChecklistAnswers;
  /** Недостача (для комплектности и претензии; для дефектовки — null). */
  shortage: InventoryShortageSummary | null;
  /** Сколько строк было отмечено в печать (0 = печатались все). */
  selectedCount: number;
  printedBy: string | null;
  printedAt: number;
};

/** Запись версии для списка истории: полный снимок + id строки operations (для повторной печати). */
export type EngineActVersionRecord = EngineActSnapshotPayload & { operationId: string };

/**
 * Сигнатура снимка для дедупа: одинаковый контент подряд → не плодим версию.
 * Учитывает логические поля строк + ответы шаблона + тип акта. Порядок строк значим.
 */
export function engineActSnapshotSignature(args: {
  actType: EngineActType;
  rows: ReadonlyArray<EngineInventoryRow>;
  answers: RepairChecklistAnswers;
}): string {
  const rowSig = args.rows.map((r) => [
    r.part_name, r.assembly_unit_number, r.part_number, r.quantity,
    r.present ? 1 : 0, r.actual_qty, r.repairable_qty, r.scrap_qty, r.replace_qty,
    r.replenishment_branch ?? '',
  ].join(':'));
  return JSON.stringify({ t: args.actType, r: rowSig, a: args.answers });
}
