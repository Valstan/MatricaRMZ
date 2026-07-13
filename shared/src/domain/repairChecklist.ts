export type RepairChecklistTemplateItem = {
  id: string;
  label: string;
  kind: 'text' | 'date' | 'boolean' | 'table' | 'signature';
  required?: boolean;
  // Для kind=table: колонки и дефолтные строки (если нужны)
  columns?: { id: string; label: string; kind?: 'text' | 'boolean' | 'number' }[];
};

export type RepairChecklistTemplate = {
  id: string;
  code: string;
  name: string;
  // стадия процесса: для MVP используем 'repair'
  stage: string;
  version: number;
  active: boolean;
  items: RepairChecklistTemplateItem[];
};

export type RepairChecklistTableRow = Record<string, string | boolean | number>;

/** Один сотрудник в списке (напр. «Разборку двигателя произвёл» в акте дефектовки). */
export type RepairChecklistEmployeeRef = { employeeId: string; fio: string; position: string };

/** Стандартная (авто-заполняемая по цеху) роль члена комиссии акта комплектности. */
export type EngineCommissionRole = 'workshop_head' | 'workshop_master' | 'otk_head';

/**
 * Один член комиссии акта комплектности (динамический список — заменяет 3 фикс-слота).
 * `caption` — редактируемая подпись роли (печатается как метка подписи). `role` задан только
 * у стандартных сеяных членов (якорь для «Заполнить комиссию по цеху»); у добавленных вручную —
 * отсутствует. `employeeId` — если выбран из справочника.
 */
export type RepairChecklistCommissionMember = {
  id: string;
  fio: string;
  position: string;
  signedAt: number | null;
  caption?: string;
  role?: EngineCommissionRole;
  employeeId?: string;
};

/** Один редактируемый пункт блока «Состояние при поступлении» (label редактируется/добавляется/удаляется). */
export type RepairChecklistConditionItem = { id: string; label: string; value: string };

/** Пресет утверждающего для грифа «Утверждаю» акта (переиспользует SSOT наряда + «по качеству»). */
export type EngineActApprover = 'quality' | 'director' | 'technical';

/**
 * Редактируемый гриф «Утверждаю» акта: пресет + операторские override (своя должность / ФИО /
 * выбранный сотрудник) поверх него. Единый источник для печати. Все поля опциональны.
 */
export type RepairChecklistApproverGrif = {
  preset?: EngineActApprover;
  positionOverride?: string;
  nameOverride?: string;
  employeeId?: string;
};

export type RepairChecklistAnswers = Record<
  string,
  | { kind: 'text'; value: string }
  | { kind: 'date'; value: number | null } // ms unix-time
  | { kind: 'boolean'; value: boolean }
  | { kind: 'table'; rows: RepairChecklistTableRow[] }
  | { kind: 'signature'; fio: string; position: string; signedAt: number | null }
  | { kind: 'employees'; employees: RepairChecklistEmployeeRef[] }
  | { kind: 'commission'; members: RepairChecklistCommissionMember[] }
  | { kind: 'condition_list'; items: RepairChecklistConditionItem[] }
  | { kind: 'approver'; grif: RepairChecklistApproverGrif }
>;

import type { FileRef } from './fileStorage.js';
import type { SupplyRequestItem } from './supplyRequest.js';
import type { RepairFundInstanceClassification } from './repairFundInstance.js';
import { WORK_ORDER_APPROVERS } from './workOrder.js';

// То, что кладём в operations.metaJson
export type RepairChecklistPayload = {
  kind: 'repair_checklist';
  templateId: string;
  templateVersion: number;
  stage: string;
  engineEntityId: string;
  filledBy: string | null;
  filledAt: number | null;
  answers: RepairChecklistAnswers;
  attachments?: FileRef[];
};

/* -------------------------------------------------------------------------- *
 * Engine inventory — единый список деталей двигателя.
 * Заменяет stage='defect' + stage='completeness'. См. docs/plans/checklist-unify.md.
 *
 * Одна строка покрывает обе стадии:
 *  - Приёмка (Акт комплектности):  present, actual_qty.
 *  - Дефектовка (Лист дефектовки): repairable_qty + scrap_qty + replace_qty = quantity.
 *
 * Три варианта решения по дефектной детали взаимоисключающие (по фидбеку оператора
 * 2026-05-24): «отремонтировать» / «в утиль» / «заказать новую».
 * -------------------------------------------------------------------------- */

export const ENGINE_INVENTORY_STAGE = 'engine_inventory' as const;

/**
 * «Состояние при поступлении» — блок приёмки (акт комплектности): фиксируем состояние
 * присланного изделия на момент передачи (упаковка/пломбы/повреждения/следы вскрытия +
 * особые отметки). Мировая практика Incoming Inspection. Хранится как `text`-ответы в
 * `answers[id]`. Единый список — источник и для редактора карточки, и для печати акта.
 */
export const ENGINE_RECEIPT_CONDITION_FIELDS = [
  { id: 'receipt_packaging', label: 'Упаковка / тара' },
  { id: 'receipt_seals', label: 'Пломбы' },
  { id: 'receipt_ext_damage', label: 'Внешние повреждения' },
  { id: 'receipt_opening_traces', label: 'Следы вскрытия / ремонта' },
  { id: 'receipt_notes', label: 'Особые отметки' },
] as const;

/** Ключ ответа с динамическим списком членов комиссии акта комплектности. */
export const COMMISSION_MEMBERS_KEY = 'commission_members';

/** Легаси 3 фикс-слота комиссии → сеяные члены динамического списка. Порядок значим (печать/UI). */
const COMMISSION_SEED: ReadonlyArray<{ id: string; role: EngineCommissionRole; caption: string; legacyId: string }> = [
  { id: 'cm_workshop_head', role: 'workshop_head', caption: 'Начальник цеха', legacyId: 'commission_workshop_head' },
  { id: 'cm_workshop_master', role: 'workshop_master', caption: 'Мастер цеха', legacyId: 'commission_workshop_master' },
  { id: 'cm_otk_head', role: 'otk_head', caption: 'Начальник ОТК', legacyId: 'commission_otk_head' },
];

function readSignatureAnswer(
  answers: RepairChecklistAnswers,
  id: string,
): { fio: string; position: string; signedAt: number | null } {
  const a = (answers as Record<string, unknown>)[id] as
    | { kind?: string; fio?: unknown; position?: unknown; signedAt?: unknown }
    | undefined;
  if (!a || a.kind !== 'signature') return { fio: '', position: '', signedAt: null };
  return {
    fio: String(a.fio ?? ''),
    position: String(a.position ?? ''),
    signedAt: Number.isFinite(a.signedAt) ? Number(a.signedAt) : null,
  };
}

/**
 * Члены комиссии акта комплектности с fallback на легаси 3 фикс-слота — единый источник
 * для печати и (через миграцию) для редактора. Не мутирует answers.
 */
export function readCommissionMembers(answers: RepairChecklistAnswers): RepairChecklistCommissionMember[] {
  const a = (answers as Record<string, unknown>)[COMMISSION_MEMBERS_KEY] as
    | { kind?: string; members?: unknown }
    | undefined;
  if (a && a.kind === 'commission' && Array.isArray(a.members)) {
    return a.members.map((m) => {
      const raw = m as Record<string, unknown>;
      return {
        id: String(raw.id ?? ''),
        fio: String(raw.fio ?? ''),
        position: String(raw.position ?? ''),
        signedAt: Number.isFinite(raw.signedAt) ? Number(raw.signedAt) : null,
        ...(raw.caption != null ? { caption: String(raw.caption) } : {}),
        ...(raw.role != null ? { role: raw.role as EngineCommissionRole } : {}),
        ...(raw.employeeId != null ? { employeeId: String(raw.employeeId) } : {}),
      };
    });
  }
  // Легаси-fallback: старые снапшоты/двигатели без commission_members.
  return COMMISSION_SEED.map((s) => {
    const sig = readSignatureAnswer(answers, s.legacyId);
    return { id: s.id, fio: sig.fio, position: sig.position, signedAt: sig.signedAt, caption: s.caption, role: s.role };
  });
}

/** Ключ ответа с редактируемым списком пунктов «Состояние при поступлении». */
export const RECEIPT_CONDITION_LIST_KEY = 'receipt_condition_list';

/** Ключ ответа с редактируемым грифом «Утверждаю». */
export const APPROVER_GRIF_KEY = 'approver_grif';

/**
 * Пресеты утверждающего для грифа акта. Директор/технический — SSOT наряда (WORK_ORDER_APPROVERS),
 * «по качеству» — акт-специфичный дефолт (как печаталось раньше «Утверждаю: директор по качеству»).
 */
export const ENGINE_ACT_APPROVERS: Record<EngineActApprover, { label: string; position: string; name: string }> = {
  quality: { label: 'Директор по качеству', position: 'Директор по качеству', name: '' },
  director: WORK_ORDER_APPROVERS.director,
  technical: WORK_ORDER_APPROVERS.technical,
};
export const ENGINE_ACT_APPROVER_DEFAULT: EngineActApprover = 'quality';

/** Действующие должность и ФИО грифа: override оператора поверх пресета. SSOT печати/редактора. */
export function resolveEngineActApprover(
  grif: RepairChecklistApproverGrif | null | undefined,
): { position: string; name: string } {
  const key = grif?.preset ?? ENGINE_ACT_APPROVER_DEFAULT;
  const preset = ENGINE_ACT_APPROVERS[key] ?? ENGINE_ACT_APPROVERS[ENGINE_ACT_APPROVER_DEFAULT];
  const position = String(grif?.positionOverride ?? '').trim() || preset.position;
  const name = String(grif?.nameOverride ?? '').trim() || preset.name;
  return { position, name };
}

/** Пункты «Состояние при поступлении» с fallback на 5 фикс-полей + их legacy text-значения. */
export function readConditionItems(answers: RepairChecklistAnswers): RepairChecklistConditionItem[] {
  const a = (answers as Record<string, unknown>)[RECEIPT_CONDITION_LIST_KEY] as
    | { kind?: string; items?: unknown }
    | undefined;
  if (a && a.kind === 'condition_list' && Array.isArray(a.items)) {
    return a.items.map((it) => {
      const raw = it as Record<string, unknown>;
      return { id: String(raw.id ?? ''), label: String(raw.label ?? ''), value: String(raw.value ?? '') };
    });
  }
  return ENGINE_RECEIPT_CONDITION_FIELDS.map((f) => {
    const t = (answers as Record<string, unknown>)[f.id] as { kind?: string; value?: unknown } | undefined;
    return { id: f.id, label: f.label, value: t && t.kind === 'text' ? String(t.value ?? '') : '' };
  });
}

/** Гриф «Утверждаю» с fallback на легаси approved_by signature (position/fio → override). */
export function readApproverGrif(answers: RepairChecklistAnswers): RepairChecklistApproverGrif {
  const a = (answers as Record<string, unknown>)[APPROVER_GRIF_KEY] as
    | { kind?: string; grif?: RepairChecklistApproverGrif }
    | undefined;
  if (a && a.kind === 'approver' && a.grif && typeof a.grif === 'object') return a.grif;
  const sig = readSignatureAnswer(answers, 'approved_by');
  return {
    ...(sig.position.trim() ? { positionOverride: sig.position } : {}),
    ...(sig.fio.trim() ? { nameOverride: sig.fio } : {}),
  };
}

/**
 * Ленивая, детерминированная, идемпотентная миграция answers единого списка деталей
 * (engine_inventory) к новым редактируемым структурам. Аддитивна — легаси-ключи НЕ удаляет.
 * Стабильные derived-id (не uuid) → снапшот-подпись воспроизводима, версий не плодит.
 * Покрывает: комиссию (3 фикс-слота → commission_members), «состояние при поступлении»
 * (5 фикс-полей → receipt_condition_list) и гриф (approved_by → approver_grif).
 * Возвращает { answers, changed }; changed=true если что-то досеяно.
 */
export function migrateEngineInventoryAnswers(
  answers: RepairChecklistAnswers,
): { answers: RepairChecklistAnswers; changed: boolean } {
  let changed = false;
  let next = answers;

  const existingCommission = (answers as Record<string, unknown>)[COMMISSION_MEMBERS_KEY] as
    | { kind?: string }
    | undefined;
  if (!existingCommission || existingCommission.kind !== 'commission') {
    const members: RepairChecklistCommissionMember[] = COMMISSION_SEED.map((s) => {
      const sig = readSignatureAnswer(answers, s.legacyId);
      return { id: s.id, fio: sig.fio, position: sig.position, signedAt: sig.signedAt, caption: s.caption, role: s.role };
    });
    next = { ...next, [COMMISSION_MEMBERS_KEY]: { kind: 'commission', members } };
    changed = true;
  }

  const existingCondition = (answers as Record<string, unknown>)[RECEIPT_CONDITION_LIST_KEY] as
    | { kind?: string }
    | undefined;
  if (!existingCondition || existingCondition.kind !== 'condition_list') {
    const items: RepairChecklistConditionItem[] = ENGINE_RECEIPT_CONDITION_FIELDS.map((f) => {
      const t = (answers as Record<string, unknown>)[f.id] as { kind?: string; value?: unknown } | undefined;
      return { id: f.id, label: f.label, value: t && t.kind === 'text' ? String(t.value ?? '') : '' };
    });
    next = { ...next, [RECEIPT_CONDITION_LIST_KEY]: { kind: 'condition_list', items } };
    changed = true;
  }

  const existingApprover = (answers as Record<string, unknown>)[APPROVER_GRIF_KEY] as
    | { kind?: string }
    | undefined;
  if (!existingApprover || existingApprover.kind !== 'approver') {
    const sig = readSignatureAnswer(answers, 'approved_by');
    const grif: RepairChecklistApproverGrif = {
      ...(sig.position.trim() ? { positionOverride: sig.position } : {}),
      ...(sig.fio.trim() ? { nameOverride: sig.fio } : {}),
    };
    next = { ...next, [APPROVER_GRIF_KEY]: { kind: 'approver', grif } };
    changed = true;
  }

  return { answers: next, changed };
}

/**
 * Ф3: ветка восполнения детали — как восполнить недостающую/негодную позицию.
 *  - customer: восполняет заказчик (закрытие в «есть» по приходу от заказчика);
 *  - repair:  свой ремонт (закрытие по готовности из ремфонда);
 *  - purchase: закупка (черновик заявки в снабжение → требование под гейтом director_approved).
 */
export type ReplenishmentBranch = 'customer' | 'repair' | 'purchase';

export const REPLENISHMENT_BRANCHES = ['customer', 'repair', 'purchase'] as const satisfies readonly ReplenishmentBranch[];

/** Логические колонки одной строки объединённого списка. */
export type EngineInventoryRow = {
  /** Идентификация — главный человеческий ключ для матчинга. */
  part_name: string;
  /** № узла сборки (был только в completeness). */
  assembly_unit_number: string;
  /** № детали по чертежу (был только в defect). */
  part_number: string;
  /**
   * Т6: номер, НАБИТЫЙ на самой детали (узнаётся только при осмотре) — отдельно
   * от чертёжного. Печатается пустым в чистом акте, заполняется с бумаги.
   */
  stamped_number?: string;
  /** Опциональная привязка к варианту сборки BOM (Этап 5). */
  bom_variant_group: string | null;

  /** Плановое кол-во (из BOM / brandLink). */
  quantity: number;

  /** Приёмка: галка «все на месте». */
  present: boolean;
  /** Фактически принято при приёмке. */
  actual_qty: number;

  /** Дефектовка: распределение по трём корзинам. */
  repairable_qty: number;
  scrap_qty: number;
  replace_qty: number;

  /** Ф3: ветка восполнения per-деталь; null = не выбрана. */
  replenishment_branch: ReplenishmentBranch | null;

  /**
   * Т4: эффективные галочки актов строки. При brand-resync пересчитываются из
   * привязки деталь↔марка (PartSpecBrandLink), поэтому правка шаблона марки доезжает
   * до двигателей. undefined = legacy-строка без флагов (печать актов не фильтрует).
   */
  in_completeness_act?: boolean;
  in_defect_act?: boolean;
  /**
   * Т5: операторский per-engine override (ставится только в карточке двигателя).
   * Если задан — побеждает значение марки при resync; шаблон марки не трогает.
   */
  in_completeness_act_override?: boolean;
  in_defect_act_override?: boolean;
};

const ENGINE_INVENTORY_KEYS = [
  'part_name',
  'assembly_unit_number',
  'part_number',
  'bom_variant_group',
  'quantity',
  'present',
  'actual_qty',
  'repairable_qty',
  'scrap_qty',
  'replace_qty',
  'replenishment_branch',
] as const satisfies readonly (keyof EngineInventoryRow)[];

function toBranchField(value: unknown): ReplenishmentBranch | null {
  return value === 'customer' || value === 'repair' || value === 'purchase' ? value : null;
}

function toIntQty(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function toStringField(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

function toBoolField(value: unknown): boolean {
  return value === true;
}

/**
 * Нормализация одной строки EngineInventoryRow.
 *
 * Инварианты после возврата:
 *  - quantity >= 0 (целое).
 *  - scrap_qty, replace_qty in [0, quantity] (input оператора); scrap+replace<=quantity
 *    (при перерасходе replace уменьшается).
 *  - **Т7 (связь комплектность→дефектовка):** деталь попадает в дефектовку только если
 *    отмечена «на месте» (present). Дефект подразумевает наличие → если scrap+replace>0,
 *    present форсится в true (миграция legacy-строк, где дефект был введён без галочки
 *    наличия). Если present=false → детали нет → actual_qty=scrap=replace=repairable=0,
 *    replenishment_branch=null (дефектовки у отсутствующей детали быть не может).
 *  - present=true → actual_qty=quantity, repairable_qty = quantity - scrap - replace (>=0).
 *  - Строковые поля приведены к string, bom_variant_group → null если пустая строка.
 *
 * Возвращает { row, changed: true } если нормализация изменила хоть одно поле.
 */
export function normalizeEngineInventoryRow(raw: Record<string, unknown>): {
  row: EngineInventoryRow;
  changed: boolean;
} {
  const partName = toStringField(raw.part_name);
  const assemblyUnit = toStringField(raw.assembly_unit_number);
  const partNumber = toStringField(raw.part_number);
  const variantGroupRaw = raw.bom_variant_group;
  const variantGroup =
    variantGroupRaw == null || String(variantGroupRaw).trim() === ''
      ? null
      : String(variantGroupRaw);
  const quantity = toIntQty(raw.quantity);

  let scrap = Math.min(quantity, toIntQty(raw.scrap_qty));
  let replace = Math.min(quantity, toIntQty(raw.replace_qty));
  // Гарантируем что sum scrap+replace <= quantity — при перерасходе уменьшаем replace.
  if (scrap + replace > quantity) {
    replace = Math.max(0, quantity - scrap);
  }

  // Т7: дефект подразумевает наличие (миграция legacy + защита). present-гейт ниже
  // обнуляет дефектовку у отсутствующей детали — «нет в комплектности → нет в дефектовке».
  let present = toBoolField(raw.present);
  if (scrap > 0 || replace > 0) present = true;

  let actualQty: number;
  let repairable: number;
  let branch: ReplenishmentBranch | null;
  if (present) {
    actualQty = quantity;
    repairable = Math.max(0, quantity - scrap - replace);
    branch = toBranchField(raw.replenishment_branch);
  } else {
    actualQty = 0;
    scrap = 0;
    replace = 0;
    repairable = 0;
    branch = null;
  }

  const row: EngineInventoryRow = {
    part_name: partName,
    assembly_unit_number: assemblyUnit,
    part_number: partNumber,
    bom_variant_group: variantGroup,
    quantity,
    present,
    actual_qty: actualQty,
    repairable_qty: repairable,
    scrap_qty: scrap,
    replace_qty: replace,
    replenishment_branch: branch,
    ...(raw.stamped_number !== undefined ? { stamped_number: toStringField(raw.stamped_number) } : {}),
    ...(raw.in_completeness_act !== undefined ? { in_completeness_act: toBoolField(raw.in_completeness_act) } : {}),
    ...(raw.in_defect_act !== undefined ? { in_defect_act: toBoolField(raw.in_defect_act) } : {}),
    ...(raw.in_completeness_act_override !== undefined
      ? { in_completeness_act_override: toBoolField(raw.in_completeness_act_override) }
      : {}),
    ...(raw.in_defect_act_override !== undefined ? { in_defect_act_override: toBoolField(raw.in_defect_act_override) } : {}),
  };

  // Detect changes by comparing key-by-key with raw input.
  let changed = false;
  for (const key of ENGINE_INVENTORY_KEYS) {
    const rawVal = (raw as Record<string, unknown>)[key];
    // replenishment_branch: legacy row без ключа (undefined) ≈ канонический null — не считаем изменением.
    if (key === 'replenishment_branch') {
      if ((rawVal ?? null) !== row[key]) {
        changed = true;
        break;
      }
      continue;
    }
    if (rawVal !== row[key]) {
      changed = true;
      break;
    }
  }
  return { row, changed };
}

export function normalizeEngineInventoryRows(rows: ReadonlyArray<Record<string, unknown>>): {
  rows: EngineInventoryRow[];
  changed: boolean;
} {
  let changed = false;
  const out: EngineInventoryRow[] = [];
  for (const r of rows) {
    const { row, changed: rowChanged } = normalizeEngineInventoryRow(r);
    if (rowChanged) changed = true;
    out.push(row);
  }
  return { rows: out, changed };
}

/**
 * Парсит фото-доказательства строки дефектовки из мета-ключа `__photos`
 * (JSON-строка `FileRef[]`, либо уже массив). Невалидные элементы отбрасываются.
 * Мета-ключ ставит электрон-клиент (см. `repairChecklistRows.ts` ROW_PHOTOS_KEY).
 */
export function parseInventoryRowPhotos(raw: unknown): FileRef[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (x): x is FileRef => !!x && typeof x === 'object' && typeof (x as any).id === 'string' && typeof (x as any).name === 'string',
  );
}

/**
 * Ф4: дефектные единицы строки — выведенные из двигателя («утиль») плюс «заменить новой».
 * Это триггер 3-веточной маршрутизации восполнения: и утиль, и замена оставляют двигатель
 * без детали, решение «кто восполняет» нужно в обоих случаях.
 */
export function rowDefectQty(row: Pick<EngineInventoryRow, 'scrap_qty' | 'replace_qty'>): number {
  return Math.max(0, Math.floor(Number(row.scrap_qty) || 0)) + Math.max(0, Math.floor(Number(row.replace_qty) || 0));
}

export function rowHasDefect(row: Pick<EngineInventoryRow, 'scrap_qty' | 'replace_qty'>): boolean {
  return rowDefectQty(row) > 0;
}

/**
 * Ф3: идёт ли строка в черновик закупки — негодна (replace_qty>0) и ветка восполнения = закупка
 * либо не выбрана (null → закупка по умолчанию, обратная совместимость с MVP-1). Явный выбор
 * «заказчик»/«свой ремонт» уводит строку из требования закупки. В закупку идут только единицы
 * «заменить новой» (утиль закупкой не восполняется — для него ветка значит заказчик/свой ремонт).
 */
/**
 * Утильные детали двигателя из payload листа дефектовки (stage `engine_inventory`,
 * `answers.engine_inventory_items.rows`): имена строк с scrap_qty > 0 (dedup, порядок строк).
 * Пустой список = утиля нет. Используется связкой «утиль ⇄ наряд на сборку»:
 * авто-отзыв выданного Assembly-наряда и блокировка кнопки «Выдать в работу».
 */
export function listScrapPartNames(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const answers = (payload as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object') return [];
  const table = (answers as Record<string, unknown>).engine_inventory_items;
  if (!table || typeof table !== 'object') return [];
  const rows = (table as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const { row } = normalizeEngineInventoryRow(raw as Record<string, unknown>);
    if (row.scrap_qty <= 0) continue;
    const name = row.part_name.trim() || row.part_number.trim() || 'Деталь без названия';
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** Авто-причина отзыва наряда по утилю в дефектовке. */
export function buildAutoWithdrawReason(partNames: ReadonlyArray<string>): string {
  const list = partNames.filter((n) => n.trim()).join(', ');
  return list
    ? (partNames.length > 1 ? `Детали признаны утильными: ${list}` : `Деталь признана утильной: ${list}`)
    : 'Утильная деталь в дефектовке двигателя';
}

export function rowGoesToPurchase(
  row: Pick<EngineInventoryRow, 'replace_qty' | 'replenishment_branch'>,
): boolean {
  return row.replace_qty > 0 && row.replenishment_branch !== 'customer' && row.replenishment_branch !== 'repair';
}

/** Ф3/Ф4: сводка по веткам восполнения (для UI и гейта). По строкам с дефектом (утиль или замена > 0). */
export type ReplenishmentSummary = {
  toReplenish: number;
  customer: number;
  repair: number;
  purchase: number;
  unrouted: number;
  /** Строк, попадающих в черновик закупки (replace_qty>0 и ветка purchase/не задана). */
  toPurchase: number;
};

export function summarizeReplenishment(rows: ReadonlyArray<Record<string, unknown>>): ReplenishmentSummary {
  const s: ReplenishmentSummary = { toReplenish: 0, customer: 0, repair: 0, purchase: 0, unrouted: 0, toPurchase: 0 };
  for (const raw of rows) {
    const { row } = normalizeEngineInventoryRow(raw);
    if (!rowHasDefect(row)) continue;
    s.toReplenish += 1;
    if (row.replenishment_branch === 'customer') s.customer += 1;
    else if (row.replenishment_branch === 'repair') s.repair += 1;
    else if (row.replenishment_branch === 'purchase') s.purchase += 1;
    else s.unrouted += 1;
    if (rowGoesToPurchase(row)) s.toPurchase += 1;
  }
  return s;
}

/**
 * Дефектовка → доказательства: собирает все фото со строк «к заказу» (replace_qty > 0),
 * дедуп по id файла. Эти FileRef'ы прикрепляются к черновику заявки (`payload.attachments`)
 * как доказательство дефекта (MVP-2). Порядок — первое вхождение каждого id.
 */
export function collectDefectPhotosFromInventory(
  rawRows: ReadonlyArray<Record<string, unknown>>,
): FileRef[] {
  const byId = new Map<string, FileRef>();
  for (const raw of rawRows) {
    const { row } = normalizeEngineInventoryRow(raw);
    if (!rowGoesToPurchase(row)) continue;
    for (const ref of parseInventoryRowPhotos((raw as Record<string, unknown>).__photos)) {
      if (!byId.has(ref.id)) byId.set(ref.id, ref);
    }
  }
  return [...byId.values()];
}

/**
 * Дефектовка → авто-список запчастей: извлекает детали «к заказу» (replace_qty > 0)
 * из строк engine_inventory в позиции черновика заявки в снабжение.
 *
 * Принимает raw-строки (`answers.engine_inventory_items.rows`), а не нормализованные —
 * чтобы прочитать опц. `__part_id` (ручной выбор детали, G3), `__part_unit` для productId/unit
 * и `__photos` (число фото-доказательств идёт в note).
 * Агрегирует по идентичности детали (по `__part_id` если есть, иначе part_name|part_number),
 * суммируя replace_qty. part_number/№ узла идут в note как ссылка-доказательство дефектовки.
 * Возвращает позиции с проставленными lineNo (1-based), пустой массив если негодных нет.
 */
export function buildSupplyRequestItemsFromInventory(
  rawRows: ReadonlyArray<Record<string, unknown>>,
): SupplyRequestItem[] {
  const byKey = new Map<string, SupplyRequestItem>();
  const photoIdsByKey = new Map<string, Set<string>>();
  for (const raw of rawRows) {
    const { row } = normalizeEngineInventoryRow(raw);
    if (!rowGoesToPurchase(row)) continue;
    const partId = typeof raw.__part_id === 'string' && raw.__part_id.trim() ? raw.__part_id.trim() : null;
    const unit = typeof raw.__part_unit === 'string' && raw.__part_unit.trim() ? raw.__part_unit.trim() : null;
    const name = row.part_name.trim();
    if (!name && !partId && !row.part_number.trim()) continue;
    const key = partId
      ? `id:${partId}`
      : `name:${name.toLowerCase()}|${row.part_number.trim().toLowerCase()}`;
    const photoIds = photoIdsByKey.get(key) ?? new Set<string>();
    for (const ref of parseInventoryRowPhotos((raw as Record<string, unknown>).__photos)) photoIds.add(ref.id);
    photoIdsByKey.set(key, photoIds);
    const existing = byKey.get(key);
    if (existing) {
      existing.qty = (existing.qty ?? 0) + row.replace_qty;
      continue;
    }
    const ref = [row.part_number, row.assembly_unit_number].map((s) => s.trim()).filter(Boolean).join(' · ');
    byKey.set(key, {
      ...(partId ? { productId: partId } : {}),
      name: name || row.part_number.trim() || 'Деталь',
      qty: row.replace_qty,
      ...(unit ? { unit } : {}),
      note: ref ? `Дефектовка: ${ref}` : 'Дефектовка',
    });
  }
  let lineNo = 0;
  return [...byKey.entries()].map(([key, it]) => {
    const photoCount = photoIdsByKey.get(key)?.size ?? 0;
    const note = photoCount > 0 ? `${it.note ?? 'Дефектовка'}; фото: ${photoCount}` : it.note;
    return { lineNo: ++lineNo, ...it, ...(note != null ? { note } : {}) };
  });
}

/**
 * Ф5 (GAP-4 вход): строки «свой ремонт» → черновик ремонтного наряда.
 *
 * Берёт строки `replenishment_branch='repair'` с дефектом (rowDefectQty>0). Для work-line
 * нужен устойчивый id детали — читается из мета-ключей `__brand_part_id` (brand-managed)
 * либо `__part_id` (ручной выбор); строки без id в наряд не попадают и считаются в
 * `skippedNoPartId` (UI подсказывает выбрать деталь из справочника).
 * Агрегация по partId, qty = Σ rowDefectQty (утиль и замена — оба выводят деталь из двигателя,
 * восполняются ремонтом единицы из ремфонда).
 */
export type RepairOrderDraftItem = { partId: string; partLabel: string; qty: number };

export function buildRepairOrderItemsFromInventory(rawRows: ReadonlyArray<Record<string, unknown>>): {
  items: RepairOrderDraftItem[];
  skippedNoPartId: number;
} {
  const byPartId = new Map<string, RepairOrderDraftItem>();
  let skipped = 0;
  for (const raw of rawRows) {
    const { row } = normalizeEngineInventoryRow(raw);
    if (row.replenishment_branch !== 'repair' || !rowHasDefect(row)) continue;
    const brandPartId = typeof raw.__brand_part_id === 'string' ? raw.__brand_part_id.trim() : '';
    const manualPartId = typeof raw.__part_id === 'string' ? raw.__part_id.trim() : '';
    const partId = brandPartId || manualPartId;
    if (!partId) {
      skipped += 1;
      continue;
    }
    const qty = rowDefectQty(row);
    const existing = byPartId.get(partId);
    if (existing) {
      existing.qty += qty;
      continue;
    }
    byPartId.set(partId, {
      partId,
      partLabel: row.part_name.trim() || row.part_number.trim() || 'Деталь',
      qty,
    });
  }
  return { items: [...byPartId.values()], skippedNoPartId: skipped };
}

/**
 * Ремфонд Ф1: годные к ремонту детали двигателя для заноса в ремонтный фонд.
 * В фонд идут детали, которые ПРИСУТСТВУЮТ (`present`) и РЕМОНТОПРИГОДНЫ
 * (`repairable_qty > 0` = quantity − scrap − replace), т.е. не утиль и не под замену —
 * именно «ожидают ремонта». qty = `repairable_qty`. Строки без привязки к справочнику
 * (`__brand_part_id`/`__part_id`) пропускаются и считаются в `skippedNoPartId`.
 * Агрегирует по partId (одинаковые детали суммируются).
 */
export function buildRepairFundIntakeFromInventory(rawRows: ReadonlyArray<Record<string, unknown>>): {
  items: RepairOrderDraftItem[];
  skippedNoPartId: number;
} {
  const byPartId = new Map<string, RepairOrderDraftItem>();
  let skipped = 0;
  for (const raw of rawRows) {
    const { row } = normalizeEngineInventoryRow(raw);
    if (!row.present || row.repairable_qty <= 0) continue;
    const brandPartId = typeof raw.__brand_part_id === 'string' ? raw.__brand_part_id.trim() : '';
    const manualPartId = typeof raw.__part_id === 'string' ? raw.__part_id.trim() : '';
    const partId = brandPartId || manualPartId;
    if (!partId) {
      skipped += 1;
      continue;
    }
    const qty = Math.max(0, Math.floor(Number(row.repairable_qty) || 0));
    if (qty <= 0) continue;
    const existing = byPartId.get(partId);
    if (existing) {
      existing.qty += qty;
      continue;
    }
    byPartId.set(partId, {
      partId,
      partLabel: row.part_name.trim() || row.part_number.trim() || 'Деталь',
      qty,
    });
  }
  return { items: [...byPartId.values()], skippedNoPartId: skipped };
}

/**
 * Ремфонд Ф3: номерные экземпляры деталей двигателя для поэкземплярного учёта.
 * Берёт строки дефектовки с непустым `stamped_number` (личный набитый номер) и
 * хоть какой-то диспозицией (repairable/scrap/replace > 0). classification — по
 * приоритету: утиль > замена > ремонт (утиль — сильнейший сигнал для претензии).
 * `partId` из мета `__brand_part_id`/`__part_id` (как соседние хелперы); строки без
 * привязки к справочнику пропускаются и считаются в `skippedNoPartId`. Дедуп по
 * `(partId, stampedNumber)` — один физический номерной экземпляр учитывается один раз.
 */
export type StampedInstanceDraft = {
  partId: string;
  partLabel: string;
  stampedNumber: string;
  classification: RepairFundInstanceClassification;
  repairableQty: number;
  scrapQty: number;
  replaceQty: number;
};

export function buildStampedInstancesFromInventory(rawRows: ReadonlyArray<Record<string, unknown>>): {
  items: StampedInstanceDraft[];
  skippedNoPartId: number;
} {
  const items: StampedInstanceDraft[] = [];
  const seen = new Set<string>();
  let skippedNoPartId = 0;
  for (const raw of rawRows) {
    const stampedNumber = toStringField(raw.stamped_number).trim();
    if (!stampedNumber) continue;
    const { row } = normalizeEngineInventoryRow(raw);
    if (row.repairable_qty + row.scrap_qty + row.replace_qty <= 0) continue;
    const brandPartId = typeof raw.__brand_part_id === 'string' ? raw.__brand_part_id.trim() : '';
    const manualPartId = typeof raw.__part_id === 'string' ? raw.__part_id.trim() : '';
    const partId = brandPartId || manualPartId;
    if (!partId) {
      skippedNoPartId += 1;
      continue;
    }
    const key = `${partId}|${stampedNumber.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const classification: RepairFundInstanceClassification =
      row.scrap_qty > 0 ? 'scrap' : row.replace_qty > 0 ? 'replace' : 'repairable';
    items.push({
      partId,
      partLabel: row.part_name.trim() || row.part_number.trim() || 'Деталь',
      stampedNumber,
      classification,
      repairableQty: row.repairable_qty,
      scrapQty: row.scrap_qty,
      replaceQty: row.replace_qty,
    });
  }
  return { items, skippedNoPartId };
}

/** Сигнатура строки для merge / dedup. Использует part_name как основной ключ. */
export function engineInventoryRowSignature(row: Pick<EngineInventoryRow, 'part_name' | 'assembly_unit_number' | 'part_number'>): string {
  const parts = [row.part_name, row.assembly_unit_number, row.part_number].map((v) =>
    String(v ?? '').trim().toLowerCase(),
  );
  return parts.join('|');
}

/**
 * Миграция legacy answers stage='defect' + stage='completeness' в новый engine_inventory.
 *
 * Семантика merge:
 *  - Сопоставление по part_name (нормализованному: trim+lowercase).
 *  - Если строка есть в обоих — поля приёмки из completeness, поля дефектовки из defect,
 *    quantity = max(оба источника).
 *  - Только defect → present=false, actual_qty=0, defect-поля сохранены.
 *  - Только completeness → repairable=quantity, scrap=0, replace=0 (default дефектовка не делалась).
 *
 * Принимает плоские raw-строки (Record<string, unknown>) — структура из `answers[tableId].rows`.
 */
export function mergeLegacyChecklistAnswers(args: {
  defectRows?: ReadonlyArray<Record<string, unknown>> | null;
  completenessRows?: ReadonlyArray<Record<string, unknown>> | null;
}): EngineInventoryRow[] {
  const defect = args.defectRows ?? [];
  const completeness = args.completenessRows ?? [];

  const completenessByName = new Map<string, Record<string, unknown>>();
  for (const c of completeness) {
    const name = String(c.part_name ?? '').trim().toLowerCase();
    if (!name) continue;
    if (!completenessByName.has(name)) completenessByName.set(name, c);
  }

  const consumedCompleteness = new Set<string>();
  const merged: EngineInventoryRow[] = [];

  for (const d of defect) {
    const name = String(d.part_name ?? '').trim().toLowerCase();
    const matchedCompleteness = name ? completenessByName.get(name) : undefined;
    if (matchedCompleteness && name) consumedCompleteness.add(name);

    const dQty = toIntQty(d.quantity);
    const cQty = matchedCompleteness ? toIntQty(matchedCompleteness.quantity) : 0;
    const quantity = Math.max(dQty, cQty);

    const { row } = normalizeEngineInventoryRow({
      part_name: d.part_name ?? matchedCompleteness?.part_name ?? '',
      assembly_unit_number: matchedCompleteness?.assembly_unit_number ?? '',
      part_number: d.part_number ?? '',
      bom_variant_group: null,
      quantity,
      present: matchedCompleteness ? toBoolField(matchedCompleteness.present) : false,
      actual_qty: matchedCompleteness ? toIntQty(matchedCompleteness.actual_qty) : 0,
      // defect-only поля из d
      scrap_qty: toIntQty(d.scrap_qty),
      replace_qty: 0,
      // repairable_qty будет вычислен из quantity - scrap - replace
    });
    merged.push(row);
  }

  // Completeness-only — не нашли пары в defect.
  for (const c of completeness) {
    const name = String(c.part_name ?? '').trim().toLowerCase();
    if (!name || consumedCompleteness.has(name)) continue;

    const quantity = toIntQty(c.quantity);
    const { row } = normalizeEngineInventoryRow({
      part_name: c.part_name ?? '',
      assembly_unit_number: c.assembly_unit_number ?? '',
      part_number: '',
      bom_variant_group: null,
      quantity,
      present: toBoolField(c.present),
      actual_qty: toIntQty(c.actual_qty),
      // дефектовка не делалась — всё ремонтопригодно по умолчанию
      scrap_qty: 0,
      replace_qty: 0,
    });
    merged.push(row);
  }

  return merged;
}

