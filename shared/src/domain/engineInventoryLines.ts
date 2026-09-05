import type { FileRef } from './fileStorage.js';
import { normalizeEngineInventoryRow, parseInventoryRowPhotos, type ReplenishmentBranch } from './repairChecklist.js';

/**
 * Список деталей двигателя как строгая таблица `erp_engine_inventory_lines`.
 *
 * До 2026-09 список жил целиком в `operations.meta_json` (`answers.engine_inventory_items.rows`),
 * и одна галочка оператора означала новую версию всего листа (48–255 КБ шифротекста в ledger'е,
 * `PENDING` §«Ledger state.json — 194 МБ»). Здесь — одна строка = одна деталь одного листа.
 *
 * Это ЧИСТАЯ половина: конвертация в обе стороны и ключ строки. Ни одной новой правилы
 * нормализации тут нет — она одна и живёт в `normalizeEngineInventoryRow`. Все нынешние
 * потребители продолжают получать raw-строки списка (`inventoryRowFromLine`), поэтому
 * shared-хелперы (снабжение, ремфонд, утиль, номерные экземпляры) не меняются.
 *
 * План — `docs/plans/engine-inventory-lines-2026-09.md`.
 */

/** DTO-строка таблицы, как она едет по синку (snake_case, как у прочих `erp_*`). */
export type EngineInventoryLineRow = {
  id: string;
  operation_id: string;
  engine_entity_id: string;
  /** Ключ сверки внутри листа — см. `inventoryLineKey`. */
  line_key: string;
  sort_order: number;
  part_id: string | null;
  brand_managed: boolean;
  part_name: string;
  assembly_unit_number: string;
  part_number: string;
  stamped_number: string;
  bom_variant_group: string | null;
  quantity: number;
  present: boolean;
  actual_qty: number;
  repairable_qty: number;
  scrap_qty: number;
  replace_qty: number;
  replenishment_branch: ReplenishmentBranch | null;
  scrap_reason: string;
  in_completeness_act: boolean | null;
  in_defect_act: boolean | null;
  in_completeness_act_override: boolean | null;
  in_defect_act_override: boolean | null;
  selected: boolean;
  photos_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at?: number | null;
  last_server_seq?: number | null;
  sync_status?: 'synced' | 'pending' | 'error';
};

/* Мета-ключи строки списка — те же, что у клиента (`repairChecklistRows.ts`). Дублируются
 * здесь, а не импортируются: renderer-модуль в shared не тянем, а значения — контракт данных. */
const BRAND_SOURCE_KEY = '__brand_source';
const BRAND_SOURCE_VALUE = 'engine_brand';
const BRAND_PART_ID_KEY = '__brand_part_id';
const PART_ID_KEY = '__part_id';
const PHOTOS_KEY = '__photos';
const SELECTED_KEY = '__selected';

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function optBool(v: unknown): boolean | null {
  return v === undefined ? null : v === true;
}

function isSelected(v: unknown): boolean {
  return v === true || v === '1' || v === 1;
}

/**
 * Ключ строки внутри листа: id детали, иначе текст-сигнатура (как `getRowPartId` +
 * `engineInventoryRowSignature` у клиента). Дубли ключа внутри одного листа получают
 * суффикс `#n` в порядке следования — иначе две одинаковые ручные строки схлопнулись бы
 * при сверке в одну. Ключ стабилен к перестановке строк, поэтому reorder не рождает
 * новых строк таблицы.
 */
export function inventoryLineKeys(rawRows: ReadonlyArray<Record<string, unknown>>): string[] {
  const seen = new Map<string, number>();
  return rawRows.map((raw) => {
    const partId = str(raw[BRAND_PART_ID_KEY]).trim() || str(raw[PART_ID_KEY]).trim();
    const base = partId
      ? `id:${partId}`
      : `sig:${[raw.part_name, raw.assembly_unit_number, raw.part_number].map((v) => str(v).trim().toLowerCase()).join('|')}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

export type LineContext = {
  id: string;
  operationId: string;
  engineEntityId: string;
  lineKey: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

/** Строка таблицы из raw-строки списка. Нормализует теми же правилами, что и лист. */
export function lineFromInventoryRow(raw: Record<string, unknown>, ctx: LineContext): EngineInventoryLineRow {
  const { row } = normalizeEngineInventoryRow(raw);
  const brandPartId = str(raw[BRAND_PART_ID_KEY]).trim();
  const manualPartId = str(raw[PART_ID_KEY]).trim();
  const brandManaged = str(raw[BRAND_SOURCE_KEY]) === BRAND_SOURCE_VALUE && brandPartId !== '';
  const photos = parseInventoryRowPhotos(raw[PHOTOS_KEY]);
  return {
    id: ctx.id,
    operation_id: ctx.operationId,
    engine_entity_id: ctx.engineEntityId,
    line_key: ctx.lineKey,
    sort_order: ctx.sortOrder,
    part_id: brandPartId || manualPartId || null,
    brand_managed: brandManaged,
    part_name: row.part_name,
    assembly_unit_number: row.assembly_unit_number,
    part_number: row.part_number,
    stamped_number: row.stamped_number ?? '',
    bom_variant_group: row.bom_variant_group,
    quantity: row.quantity,
    present: row.present,
    actual_qty: row.actual_qty,
    repairable_qty: row.repairable_qty,
    scrap_qty: row.scrap_qty,
    replace_qty: row.replace_qty,
    replenishment_branch: row.replenishment_branch,
    scrap_reason: row.scrap_reason ?? '',
    in_completeness_act: optBool(row.in_completeness_act),
    in_defect_act: optBool(row.in_defect_act),
    in_completeness_act_override: optBool(row.in_completeness_act_override),
    in_defect_act_override: optBool(row.in_defect_act_override),
    selected: isSelected(raw[SELECTED_KEY]),
    photos_json: photos.length > 0 ? JSON.stringify(photos) : null,
    created_at: ctx.createdAt,
    updated_at: ctx.updatedAt,
    deleted_at: null,
  };
}

/**
 * Raw-строка списка из строки таблицы — ровно та форма, которую сегодня читают панель,
 * отчёты, поиск и shared-хелперы. Мета-ключи восстанавливаются только если несут значение:
 * пустой `__photos` / снятый `__selected` в списке отсутствуют (см. `withRowPhotos`), и
 * лишний ключ двоил бы sync-сигнатуру снимков актов.
 */
export function inventoryRowFromLine(line: EngineInventoryLineRow): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    part_name: line.part_name,
    assembly_unit_number: line.assembly_unit_number,
    part_number: line.part_number,
    bom_variant_group: line.bom_variant_group,
    quantity: line.quantity,
    present: line.present,
    actual_qty: line.actual_qty,
    repairable_qty: line.repairable_qty,
    scrap_qty: line.scrap_qty,
    replace_qty: line.replace_qty,
    replenishment_branch: line.replenishment_branch,
    scrap_reason: line.scrap_reason,
  };
  if (line.stamped_number) raw.stamped_number = line.stamped_number;
  if (line.in_completeness_act != null) raw.in_completeness_act = line.in_completeness_act;
  if (line.in_defect_act != null) raw.in_defect_act = line.in_defect_act;
  if (line.in_completeness_act_override != null) raw.in_completeness_act_override = line.in_completeness_act_override;
  if (line.in_defect_act_override != null) raw.in_defect_act_override = line.in_defect_act_override;
  if (line.part_id) {
    if (line.brand_managed) {
      raw[BRAND_SOURCE_KEY] = BRAND_SOURCE_VALUE;
      raw[BRAND_PART_ID_KEY] = line.part_id;
    } else {
      raw[PART_ID_KEY] = line.part_id;
    }
  }
  if (line.photos_json) {
    const photos: FileRef[] = parseInventoryRowPhotos(line.photos_json);
    if (photos.length > 0) raw[PHOTOS_KEY] = JSON.stringify(photos);
  }
  if (line.selected) raw[SELECTED_KEY] = true;
  return raw;
}

/** Строки листа из payload (`answers.engine_inventory_items.rows`), без нормализации. */
export function inventoryRawRowsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') return [];
  const answers = (payload as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object') return [];
  const table = (answers as Record<string, unknown>).engine_inventory_items;
  if (!table || typeof table !== 'object') return [];
  const rows = (table as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
}

/** Живые строки таблицы → raw-строки списка в порядке `sort_order`. */
export function inventoryRowsFromLines(lines: ReadonlyArray<EngineInventoryLineRow>): Array<Record<string, unknown>> {
  return [...lines]
    .filter((l) => l.deleted_at == null)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(inventoryRowFromLine);
}

/** Поля, по которым две строки таблицы считаются одинаковыми по содержанию (без служебных). */
const CONTENT_FIELDS = [
  'engine_entity_id',
  'sort_order',
  'part_id',
  'brand_managed',
  'part_name',
  'assembly_unit_number',
  'part_number',
  'stamped_number',
  'bom_variant_group',
  'quantity',
  'present',
  'actual_qty',
  'repairable_qty',
  'scrap_qty',
  'replace_qty',
  'replenishment_branch',
  'scrap_reason',
  'in_completeness_act',
  'in_defect_act',
  'in_completeness_act_override',
  'in_defect_act_override',
  'selected',
  'photos_json',
] as const satisfies readonly (keyof EngineInventoryLineRow)[];

export function sameLineContent(a: EngineInventoryLineRow, b: EngineInventoryLineRow): boolean {
  for (const k of CONTENT_FIELDS) {
    if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  }
  return true;
}

export type LinesDiff = {
  /** Строк с этим листом в таблице ещё нет — вставить. */
  insert: EngineInventoryLineRow[];
  /** Ключ есть, содержание отличается (или строка была погашена) — обновить, `id` прежний. */
  update: EngineInventoryLineRow[];
  /** Живая строка таблицы, которой в листе больше нет — погасить. */
  tombstone: EngineInventoryLineRow[];
  unchanged: number;
};

/**
 * Сверка листа со строками таблицы по `line_key`. Именно так одна галочка становится одной
 * транзакцией: меняется одна строка — одна запись в ledger, а не 130. Возвращает строки в
 * форме, готовой к записи: у update/tombstone — `id` и `created_at` существующей строки.
 */
export function diffInventoryLines(
  existing: ReadonlyArray<EngineInventoryLineRow>,
  desired: ReadonlyArray<EngineInventoryLineRow>,
  ts: number,
): LinesDiff {
  const byKey = new Map<string, EngineInventoryLineRow>();
  for (const e of existing) byKey.set(e.line_key, e);
  const out: LinesDiff = { insert: [], update: [], tombstone: [], unchanged: 0 };
  const seen = new Set<string>();
  for (const d of desired) {
    seen.add(d.line_key);
    const cur = byKey.get(d.line_key);
    if (!cur) {
      out.insert.push(d);
      continue;
    }
    const alive = cur.deleted_at == null;
    if (alive && sameLineContent(cur, d)) {
      out.unchanged += 1;
      continue;
    }
    out.update.push({ ...d, id: cur.id, created_at: cur.created_at, updated_at: ts, deleted_at: null });
  }
  for (const e of existing) {
    if (seen.has(e.line_key) || e.deleted_at != null) continue;
    out.tombstone.push({ ...e, updated_at: ts, deleted_at: ts });
  }
  return out;
}
