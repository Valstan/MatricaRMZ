/**
 * Зеркало справочника сотрудников (EAV `employee`) в строгую `erp_employee_cards`.
 *
 * Зачем: субъект модуля «Кладовщик» — `erp_employee_cards`, а наполнял её только
 * импорт 1С:ЗУП. На проде импорт ни разу не запускался: 408 сотрудников живут в
 * справочнике программы, карточек — 0, и пикеры СИЗ (карточки, группы,
 * коллективная выдача) не показывали никого. Модуль был выпущен, но на живых
 * данных не работал.
 *
 * Правила (план `docs/plans/ppe-employee-directory-bridge-2026-10.md`):
 *  - связь «строгая карточка ↔ карточка справочника» — колонка `entity_id`;
 *  - матчинг: `entity_id` → табельный номер (снимая ведущие нули) → ФИО, если
 *    карточка без табельного и такое ФИО в карточках ровно одно; иначе новая
 *    строка с `id = entity_id` (идемпотентно при следующем проходе);
 *  - пишем только реальные расхождения: иначе каждый тик плодил бы журнальные
 *    строки и трафик клиентам;
 *  - удалённый в справочнике сотрудник → мягкое удаление карточки (история
 *    выдач на неё ссылается и должна остаться);
 *  - `is_active` ← `employment_status ≠ 'fired'`, должность ← атрибут `role`
 *    (тот же, что читает `employeeAuthService`).
 *
 * Строка, записанная здесь, дальше идёт обычным путём зеркала
 * (`ppeSyncPublisherService`): `sync_status='pending'` → журнал → реплика клиента.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { erpEmployeeCards } from '../database/schema.js';
import { logError, logInfo } from '../utils/logger.js';
import { kickPpeSyncPublisher } from './sync/ppeSyncPublisherService.js';

export type DirectoryEmployee = {
  entityId: string;
  fullName: string;
  personnelNo: string | null;
  roleCode: string | null;
  isActive: boolean;
};

export type ExistingCard = {
  id: string;
  entityId: string | null;
  personnelNo: string | null;
  fullName: string;
  roleCode: string | null;
  isActive: boolean;
  deleted: boolean;
};

export type MirrorPatch = {
  entityId?: string;
  fullName?: string;
  personnelNo?: string;
  roleCode?: string | null;
  isActive?: boolean;
  revive?: true;
};

export type MirrorOp =
  | { kind: 'create'; id: string; row: DirectoryEmployee }
  | { kind: 'update'; id: string; patch: MirrorPatch }
  | { kind: 'delete'; id: string };

export type MirrorPlan = {
  ops: MirrorOp[];
  ambiguous: Array<{ entityId: string; fullName: string; reason: string }>;
};

/** Ключ табельного номера: `00675` и `675` — один человек. */
export function personnelKey(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return /^\d+$/.test(raw) ? String(Number(raw)) : raw.toLowerCase();
}

function nameKey(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Чистое ядро: что сделать с карточками, чтобы они совпали со справочником.
 * Вынесено из БД, чтобы матчинг и идемпотентность держал тест, а не живой прод.
 */
export function planEmployeeMirror(
  employees: DirectoryEmployee[],
  cards: ExistingCard[],
  deletedEntityIds: string[] = [],
): MirrorPlan {
  const ops: MirrorOp[] = [];
  const ambiguous: MirrorPlan['ambiguous'] = [];
  const byEntity = new Map<string, ExistingCard>();
  const byPersonnel = new Map<string, ExistingCard[]>();
  const byName = new Map<string, ExistingCard[]>();
  const claimed = new Set<string>();
  const plannedPersonnel = new Set<string>();

  for (const card of cards) {
    if (card.entityId) byEntity.set(card.entityId, card);
    if (!card.deleted && personnelKey(card.personnelNo)) {
      const key = personnelKey(card.personnelNo);
      byPersonnel.set(key, [...(byPersonnel.get(key) ?? []), card]);
    }
    if (!card.deleted) {
      const key = nameKey(card.fullName);
      byName.set(key, [...(byName.get(key) ?? []), card]);
    }
  }

  for (const entityId of deletedEntityIds) {
    const linked = byEntity.get(entityId);
    if (linked && !linked.deleted && !claimed.has(linked.id)) {
      claimed.add(linked.id);
      ops.push({ kind: 'delete', id: linked.id });
    }
  }

  for (const emp of employees) {
    let card = byEntity.get(emp.entityId) ?? null;
    if (!card) {
      const pno = personnelKey(emp.personnelNo);
      const candidates = (pno ? byPersonnel.get(pno) ?? [] : []).filter((c) => !c.entityId && !claimed.has(c.id));
      if (candidates.length === 1) card = candidates[0]!;
      else if (candidates.length > 1) {
        ambiguous.push({ entityId: emp.entityId, fullName: emp.fullName, reason: 'табельный номер у нескольких карточек' });
        continue;
      }
    }
    if (!card) {
      // Сотрудник без табельного: единственная строгая карточка с тем же ФИО и без
      // табельного — это он (завёл импорт, где колонка была пуста). Двух совпадений не трогаем.
      const sameName = (byName.get(nameKey(emp.fullName)) ?? []).filter(
        (c) => !c.entityId && !c.personnelNo && !claimed.has(c.id),
      );
      if (sameName.length === 1) card = sameName[0]!;
      else if (sameName.length > 1) {
        ambiguous.push({ entityId: emp.entityId, fullName: emp.fullName, reason: 'однофамильцы без табельного' });
        continue;
      }
    }

    if (!card || claimed.has(card.id)) {
      if (card) {
        ambiguous.push({ entityId: emp.entityId, fullName: emp.fullName, reason: 'карточка уже сведена с другим сотрудником' });
        continue;
      }
      // Табельный уже занят другой строгой карточкой (дубль сотрудника в справочнике):
      // вторую строку с тем же `personnel_no` не заводим — упадёт unique-индекс.
      const pno = personnelKey(emp.personnelNo);
      if (pno && (plannedPersonnel.has(pno) || (byPersonnel.get(pno) ?? []).some((c) => c.entityId && !c.deleted))) {
        ambiguous.push({ entityId: emp.entityId, fullName: emp.fullName, reason: 'табельный номер уже занят другой карточкой' });
        continue;
      }
      if (pno) plannedPersonnel.add(pno);
      ops.push({ kind: 'create', id: emp.entityId, row: emp });
      continue;
    }
    claimed.add(card.id);

    const patch: MirrorPatch = {};
    if (card.entityId !== emp.entityId) patch.entityId = emp.entityId;
    if (card.deleted) patch.revive = true;
    if (card.fullName !== emp.fullName) patch.fullName = emp.fullName;
    if (!card.personnelNo && emp.personnelNo) patch.personnelNo = emp.personnelNo;
    if ((card.roleCode ?? null) !== emp.roleCode) patch.roleCode = emp.roleCode;
    if (card.isActive !== emp.isActive) patch.isActive = emp.isActive;
    if (Object.keys(patch).length > 0) ops.push({ kind: 'update', id: card.id, patch });
  }

  return { ops, ambiguous };
}

type EmployeeAttrRow = { id: string; code: string | null; value_json: string | null };

/**
 * Значение EAV-атрибута как текст: в `value_json` лежит JSON, но исторически попадались и
 * голые строки. Читается и карточкой сотрудника (зеркало), и списком карточек СИЗ — чтобы
 * «р. 48» в обоих местах означало одно и то же.
 */
export function parseEavValue(raw: string | null): string {
  if (raw == null) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null) return '';
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return String(raw);
  }
}

/**
 * Справочник сотрудников как он есть у программы (EAV). Возвращает живых (с ФИО)
 * и отдельно id удалённых/слитых — по ним карточки гасятся, даже если значений
 * атрибутов у сущности уже нет.
 */
export async function loadDirectoryEmployees(): Promise<{
  employees: DirectoryEmployee[];
  deletedEntityIds: string[];
}> {
  const [live, deleted] = await Promise.all([
    pool.query<EmployeeAttrRow>(
      `select e.id::text as id, d.code as code, v.value_json as value_json
         from entities e
         join entity_types t on t.id = e.type_id and t.code = 'employee'
         left join attribute_values v on v.entity_id = e.id and v.deleted_at is null
         left join attribute_defs d on d.id = v.attribute_def_id and d.deleted_at is null
        where e.deleted_at is null`,
    ),
    pool.query<{ id: string }>(
      `select e.id::text as id
         from entities e
         join entity_types t on t.id = e.type_id and t.code = 'employee'
        where e.deleted_at is not null`,
    ),
  ]);

  const byId = new Map<string, Map<string, string>>();
  for (const row of live.rows) {
    const attrs = byId.get(row.id) ?? new Map<string, string>();
    if (row.code) attrs.set(row.code, parseEavValue(row.value_json));
    byId.set(row.id, attrs);
  }

  const employees: DirectoryEmployee[] = [];
  const deletedEntityIds = new Set(deleted.rows.map((r) => r.id));
  for (const [entityId, attrs] of byId) {
    const fullName =
      (attrs.get('full_name') ?? '').trim() ||
      [attrs.get('last_name'), attrs.get('first_name'), attrs.get('middle_name')]
        .map((p) => String(p ?? '').trim())
        .filter(Boolean)
        .join(' ');
    const mergedInto = (attrs.get('merged_into') ?? '').trim();
    if (!fullName) {
      // Слитый в другого сотрудник остаётся живой сущностью, но карточку держать не должен.
      if (mergedInto) deletedEntityIds.add(entityId);
      continue;
    }
    if (mergedInto) {
      deletedEntityIds.add(entityId);
      continue;
    }
    const status = (attrs.get('employment_status') ?? '').trim().toLowerCase();
    employees.push({
      entityId,
      fullName,
      personnelNo: (attrs.get('personnel_number') ?? '').trim() || null,
      roleCode: (attrs.get('role') ?? '').trim() || null,
      isActive: status !== 'fired',
    });
  }
  return { employees, deletedEntityIds: [...deletedEntityIds] };
}

async function loadExistingCards(): Promise<ExistingCard[]> {
  const rows = await db
    .select({
      id: erpEmployeeCards.id,
      entityId: erpEmployeeCards.entityId,
      personnelNo: erpEmployeeCards.personnelNo,
      fullName: erpEmployeeCards.fullName,
      roleCode: erpEmployeeCards.roleCode,
      isActive: erpEmployeeCards.isActive,
      deletedAt: erpEmployeeCards.deletedAt,
    })
    .from(erpEmployeeCards);
  return rows.map((r) => ({
    id: String(r.id),
    entityId: r.entityId == null ? null : String(r.entityId),
    personnelNo: r.personnelNo == null ? null : String(r.personnelNo),
    fullName: String(r.fullName),
    roleCode: r.roleCode == null ? null : String(r.roleCode),
    isActive: r.isActive === true,
    deleted: r.deletedAt != null,
  }));
}

function createValues(row: DirectoryEmployee, entityId: string) {
  const now = Date.now();
  return {
    id: entityId as never,
    entityId: row.entityId as never,
    personnelNo: row.personnelNo,
    fullName: row.fullName,
    roleCode: row.roleCode,
    isActive: row.isActive,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    syncStatus: 'pending',
  };
}

function patchValues(patch: MirrorPatch) {
  const out: Record<string, unknown> = { updatedAt: Date.now(), syncStatus: 'pending' };
  if (patch.entityId) out.entityId = patch.entityId;
  if (patch.fullName !== undefined) out.fullName = patch.fullName;
  if (patch.personnelNo !== undefined) out.personnelNo = patch.personnelNo;
  if (patch.roleCode !== undefined) out.roleCode = patch.roleCode;
  if (patch.isActive !== undefined) out.isActive = patch.isActive;
  if (patch.revive) out.deletedAt = null;
  return out;
}

/** Один проход зеркала. `apply=false` — только посчитать (dry-run бэкфилла на проде). */
export async function mirrorPpeEmployees(opts: { apply: boolean } = { apply: true }): Promise<{
  employees: number;
  created: number;
  updated: number;
  restored: number;
  deleted: number;
  untouched: number;
  ambiguous: MirrorPlan['ambiguous'];
}> {
  const { employees, deletedEntityIds } = await loadDirectoryEmployees();
  const cards = await loadExistingCards();
  const plan = planEmployeeMirror(employees, cards, deletedEntityIds);
  const report = {
    employees: employees.length,
    created: 0,
    updated: 0,
    restored: 0,
    deleted: 0,
    untouched: Math.max(0, employees.length - plan.ops.filter((op) => op.kind !== 'delete').length),
    ambiguous: plan.ambiguous,
  };
  for (const op of plan.ops) {
    if (op.kind === 'create') report.created++;
    else if (op.kind === 'delete') report.deleted++;
    else if (op.patch.revive) report.restored++;
    else report.updated++;
  }
  if (!opts.apply || plan.ops.length === 0) return report;

  for (const op of plan.ops) {
    try {
      if (op.kind === 'create') {
        await db.insert(erpEmployeeCards).values(createValues(op.row, op.id));
      } else if (op.kind === 'update') {
        await db
          .update(erpEmployeeCards)
          .set(patchValues(op.patch) as never)
          .where(eq(erpEmployeeCards.id, op.id as never));
      } else {
        const now = Date.now();
        await db
          .update(erpEmployeeCards)
          .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' } as never)
          .where(eq(erpEmployeeCards.id, op.id as never));
      }
    } catch (e) {
      logError('ppe employee mirror row failed', { id: op.id, kind: op.kind, error: String(e) });
      report.ambiguous.push({ entityId: op.id, fullName: '', reason: String(e) });
    }
  }
  await kickPpeSyncPublisher().catch(() => undefined);
  return report;
}

/**
 * Дверь модуля не должна отказывать сотруднику, заведённому минуту назад:
 * нет карточки — зеркалим ровно эту сущность и продолжаем. Ответ — id СТРОГОЙ
 * карточки (он может отличаться от id сущности, если строку раньше завёл импорт ЗУП).
 */
export async function ensurePpeEmployeeCard(
  employeeId: string,
): Promise<{ ok: true; cardId: string } | { ok: false; error: string }> {
  const id = String(employeeId ?? '').trim();
  if (!id) return { ok: false, error: 'employeeId обязателен' };
  const byId = await db
    .select({ id: erpEmployeeCards.id })
    .from(erpEmployeeCards)
    .where(and(eq(erpEmployeeCards.id, id as never), isNull(erpEmployeeCards.deletedAt)))
    .limit(1);
  if (byId[0]) return { ok: true, cardId: String(byId[0].id) };
  const byEntity = await db
    .select({ id: erpEmployeeCards.id })
    .from(erpEmployeeCards)
    .where(and(eq(erpEmployeeCards.entityId, id as never), isNull(erpEmployeeCards.deletedAt)))
    .limit(1);
  if (byEntity[0]) return { ok: true, cardId: String(byEntity[0].id) };

  const { employees, deletedEntityIds } = await loadDirectoryEmployees();
  if (deletedEntityIds.includes(id)) return { ok: false, error: 'Сотрудник удалён из справочника' };
  const target = employees.find((e) => e.entityId === id);
  if (!target) return { ok: false, error: 'Сотрудник не найден в справочнике и в карточках СИЗ' };

  const cards = await loadExistingCards();
  const plan = planEmployeeMirror([target], cards);
  const op = plan.ops[0];
  if (!op) return { ok: false, error: 'Не удалось свести сотрудника с карточкой СИЗ' };
  if (op.kind === 'create') {
    await db.insert(erpEmployeeCards).values(createValues(target, op.id));
  } else if (op.kind === 'update') {
    await db
      .update(erpEmployeeCards)
      .set(patchValues(op.patch) as never)
      .where(eq(erpEmployeeCards.id, op.id as never));
  }
  await kickPpeSyncPublisher().catch(() => undefined);
  return { ok: true, cardId: op.id };
}

/** Резолв пачки (группа, коллективная выдача): отказ — только если сотрудника нет вовсе. */
export async function ensurePpeEmployeeCards(
  employeeIds: string[],
): Promise<{ ok: true; cardIds: string[] } | { ok: false; error: string }> {
  const unique = [...new Set((employeeIds ?? []).map((v) => String(v ?? '').trim()).filter(Boolean))];
  if (unique.length === 0) return { ok: true, cardIds: [] };
  const resolved = new Map<string, string>();
  const direct = await db
    .select({ id: erpEmployeeCards.id })
    .from(erpEmployeeCards)
    .where(and(isNull(erpEmployeeCards.deletedAt), inArray(erpEmployeeCards.id, unique as never[])))
    .limit(unique.length);
  for (const c of direct) resolved.set(String(c.id), String(c.id));
  const unknown = unique.filter((id) => !resolved.has(id));
  if (unknown.length > 0) {
    const byEntity = await db
      .select({ id: erpEmployeeCards.id, entityId: erpEmployeeCards.entityId })
      .from(erpEmployeeCards)
      .where(and(isNull(erpEmployeeCards.deletedAt), inArray(erpEmployeeCards.entityId, unknown as never[])));
    for (const c of byEntity) if (c.entityId) resolved.set(String(c.entityId), String(c.id));
  }
  const out: string[] = [];
  for (const id of unique) {
    const known = resolved.get(id);
    if (known) {
      out.push(known);
      continue;
    }
    const single = await ensurePpeEmployeeCard(id);
    if (!single.ok) return { ok: false, error: single.error };
    out.push(single.cardId);
  }
  return { ok: true, cardIds: [...new Set(out)] };
}

const MIRROR_TICK_MS = 5 * 60_000;
let timer: NodeJS.Timeout | null = null;

/** Фоновый проход (primary): справочник правится в любое время, карточки должны поспевать. */
export function startPpeEmployeeMirror(): void {
  if (timer) return;
  const run = () =>
    mirrorPpeEmployees({ apply: true })
      .then((r) => {
        if (r.created + r.updated + r.restored + r.deleted > 0) {
          logInfo('ppe employee mirror applied', {
            employees: r.employees,
            created: r.created,
            updated: r.updated,
            restored: r.restored,
            deleted: r.deleted,
            ambiguous: r.ambiguous.length,
          });
        }
      })
      .catch((e) => logError('ppe employee mirror failed', { error: String(e) }));
  timer = setInterval(() => void run(), MIRROR_TICK_MS);
  timer.unref?.();
  void run();
  logInfo('ppe employee mirror started', { tickMs: MIRROR_TICK_MS });
}

export function stopPpeEmployeeMirror(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
