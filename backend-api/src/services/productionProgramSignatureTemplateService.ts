/**
 * Шаблон подписей производственной программы (промт КАРМАНА #120, план #121).
 *
 * Сущность — СПРАВОЧНИК: набор подписей, доработанный в одной программе и
 * применимый к следующим. Программа помнит, из какого шаблона взяла состав
 * (`erp_production_programs.signature_template_id`), а сам состав — копия.
 *
 * Границы прав:
 *  - читать шаблоны — всякий, кто видит производственную программу;
 *  - вести общий шаблон — отдельное поимённое право
 *    `production_program.signature_templates.edit`: шаблон подставляется в НОВЫЕ
 *    программы всего завода, то есть это не «своя настройка», а решение,
 *    которое владелец доверил конкретным людям.
 *
 * Таблица вне sync-контракта: её ведёт только эта дверь, клиент ходит по REST.
 */
import { and, eq, isNull } from 'drizzle-orm';

import {
  parsePrintSignatureSlots,
  productionProgramSignatureTemplateSlots,
  resolveProductionProgramSignatureTemplate,
  type ProductionProgramSignatureTemplate,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { productionProgramSignatureTemplates } from '../database/schema.js';
import { logInfo } from '../utils/logger.js';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type ProductionProgramSignatureTemplateDto = ProductionProgramSignatureTemplate;

/** Нарушение уникальности Postgres (23505) — по нему отличаем «имя занято» от прочих сбоев. */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  return code === '23505' || cause?.code === '23505';
}

function mapTemplate(row: typeof productionProgramSignatureTemplates.$inferSelect): ProductionProgramSignatureTemplateDto {
  return {
    id: String(row.id),
    ownerId: String(row.ownerId),
    name: String(row.name),
    slots: String(row.slots),
    isDefault: row.isDefault === true,
    updatedAt: Number(row.updatedAt),
    updatedBy: row.updatedBy == null ? null : String(row.updatedBy),
    createdAt: Number(row.createdAt),
  };
}

/** Все живые шаблоны: общий для парка + личные (если появятся). */
export async function listProductionProgramSignatureTemplates(): Promise<ProductionProgramSignatureTemplateDto[]> {
  const rows = await db
    .select()
    .from(productionProgramSignatureTemplates)
    .where(isNull(productionProgramSignatureTemplates.deletedAt));
  return rows.map(mapTemplate).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Шаблон по умолчанию — тот, который подставляется в новые программы.
 * null — шаблонов нет, программа приходит с ролями по умолчанию.
 */
export async function resolveDefaultProductionProgramSignatureTemplate(): Promise<ProductionProgramSignatureTemplateDto | null> {
  const rows = await listProductionProgramSignatureTemplates();
  return resolveProductionProgramSignatureTemplate(rows);
}

/** Шаблон по id (для проверки ссылки в программе). */
export async function getProductionProgramSignatureTemplate(
  id: string,
): Promise<ProductionProgramSignatureTemplateDto | null> {
  const templateId = String(id ?? '').trim();
  if (!templateId) return null;
  const [row] = await db
    .select()
    .from(productionProgramSignatureTemplates)
    .where(and(eq(productionProgramSignatureTemplates.id, templateId as never), isNull(productionProgramSignatureTemplates.deletedAt)))
    .limit(1);
  return row ? mapTemplate(row) : null;
}

/**
 * Состав шаблона → слоты подписей. Разбор — общий (`parsePrintSignatureSlots`),
 * битый JSON не роняет применение: такой шаблон даёт пустой набор.
 */
export { productionProgramSignatureTemplateSlots };

/**
 * Завести/править шаблон.
 *
 * `isDefault: true` — снимает флаг с прежнего шаблона этого же владельца:
 * «по умолчанию» должен быть один, иначе новая программа получала бы набор
 * наугад (тот же класс, что «один default на пару» в печатных формах).
 */
export async function saveProductionProgramSignatureTemplate(input: {
  id?: string | null | undefined;
  ownerId?: string | null | undefined;
  name: string;
  slots: string;
  isDefault?: boolean | undefined;
  updatedBy?: string | null | undefined;
}): Promise<Result<{ id: string }>> {
  try {
    const name = String(input.name ?? '').trim();
    if (!name) return { ok: false, error: 'Название шаблона обязательно' };
    const slots = String(input.slots ?? '');
    // Состав шаблона — тот же формат, что у программы; мусорный JSON не пускаем.
    const parsed = parsePrintSignatureSlots(slots);
    // Пустой шаблон обычен («оператор снял все подписи»), но ШАБЛОН ПО УМОЛЧАНИЮ
    // без подписей опасен: он ушёл бы в новые программы всего завода, и планы
    // печатались бы совсем без подписей. Поэтому дефолт без состава — отказ.
    if (input.isDefault === true && parsed.length === 0) {
      return { ok: false, error: 'Шаблон по умолчанию должен содержать хотя бы одну подпись' };
    }
    const ownerId = String(input.ownerId ?? 'shared').trim() || 'shared';
    const now = Date.now();
    const id = String(input.id ?? '').trim() || crypto.randomUUID();
    const existing = await db
      .select({ id: productionProgramSignatureTemplates.id })
      .from(productionProgramSignatureTemplates)
      .where(eq(productionProgramSignatureTemplates.id, id as never))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(productionProgramSignatureTemplates)
        .set({
          name,
          slots,
          isDefault: input.isDefault === true,
          updatedAt: now,
          updatedBy: input.updatedBy ?? null,
          deletedAt: null,
        } as never)
        .where(eq(productionProgramSignatureTemplates.id, id as never));
    } else {
      try {
        await db.insert(productionProgramSignatureTemplates).values({
          id,
          ownerId,
          name,
          slots,
          isDefault: input.isDefault === true,
          updatedAt: now,
          updatedBy: input.updatedBy ?? null,
          createdAt: now,
          deletedAt: null,
        });
      } catch (e) {
        // Одноимённый шаблон у одного владельца — понятный отказ, а не сбой.
        if (isUniqueViolation(e)) return { ok: false, error: 'Шаблон с таким названием уже есть' };
        throw e;
      }
    }
    if (input.isDefault === true) {
      await db
        .update(productionProgramSignatureTemplates)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(productionProgramSignatureTemplates.ownerId, ownerId),
            isNull(productionProgramSignatureTemplates.deletedAt),
          ),
        );
      await db
        .update(productionProgramSignatureTemplates)
        .set({ isDefault: true })
        .where(eq(productionProgramSignatureTemplates.id, id as never));
    }
    logInfo('production program signature template saved', { ownerId, name });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Снять шаблон (мягко). Программы, взявшие из него состав, не трогаются. */
export async function deleteProductionProgramSignatureTemplate(id: string): Promise<Result<{ id: string }>> {
  const templateId = String(id ?? '').trim();
  if (!templateId) return { ok: false, error: 'id шаблона обязателен' };
  const [current] = await db
    .select({ id: productionProgramSignatureTemplates.id, deletedAt: productionProgramSignatureTemplates.deletedAt })
    .from(productionProgramSignatureTemplates)
    .where(eq(productionProgramSignatureTemplates.id, templateId as never))
    .limit(1);
  if (!current) return { ok: false, error: 'шаблон не найден' };
  if (current.deletedAt != null) return { ok: true, id: templateId };
  const now = Date.now();
  await db
    .update(productionProgramSignatureTemplates)
    .set({ deletedAt: now, isDefault: false, updatedAt: now })
    .where(eq(productionProgramSignatureTemplates.id, templateId as never));
  return { ok: true, id: templateId };
}
