/**
 * Шаблон подписей производственной программы (промт КАРМАНА #120, план #121).
 *
 * Заказ владельца: «сохранённый шаблон подписи… я хочу применять его и к
 * последующим производственным программам, чтобы новая программа приходила уже
 * с доработанными подписями».
 *
 * Шаблон — это ССЫЛКА, а не запись в `signature_slots` программы:
 *  - `signature_slots = null` — «оператор не трогал блок» (печатаются роли по
 *    умолчанию), `[]` — «снял всё». Если бы шаблон писался в это же поле,
 *    программа перестала бы отличаться от «правленой руками»;
 *  - поэтому программа помнит, ИЗ КАКОГО шаблона взяли состав
 *    (`signature_template_id`), а сам состав — копию.
 *
 * Модуль — чистый домен: выбор шаблона по умолчанию и разбор его состава.
 * Формат слотов — общий (`printSignatures.ts`), нового формата не заводим.
 */
import { parsePrintSignatureSlots, type PrintSignatureSlot } from './printSignatures.js';

/** Шаблон подписей ПП — строка в том виде, как её отдаёт сервер. */
export type ProductionProgramSignatureTemplate = {
  id: string;
  /** 'shared' — общий для парка шаблон; иначе id оператора-владельца. */
  ownerId: string;
  name: string;
  /** Состав шаблона — JSON-строка со слотами (тот же текстовый контракт, что у программы). */
  slots: string;
  /** Шаблон по умолчанию: его подставляют в новые программы. */
  isDefault: boolean;
  updatedAt: number;
  updatedBy: string | null;
  createdAt: number;
};

/**
 * Какой шаблон подписей брать по умолчанию — по образцу `resolvePrintTemplate`
 * (личный перекрывает общий; внутри уровня — помеченный `isDefault`; иначе первый).
 *
 * Шаблон по умолчанию затрагивает весь завод, поэтому личный уровень в первый
 * шаг не делаем: общий набор подписей нужен всем новым программам.
 */
export function resolveProductionProgramSignatureTemplate<
  T extends ProductionProgramSignatureTemplate,
>(rows: readonly T[] | null | undefined): T | null {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return null;
  const personal = list.filter((r) => r.ownerId !== 'shared');
  const pool = personal.length > 0 ? personal : list;
  return pool.find((r) => r.isDefault) ?? pool[0];
}

/**
 * Состав шаблона → слоты подписей. Разбор — общий `parsePrintSignatureSlots`,
 * битый JSON не роняет применение: такой шаблон даёт пустой набор (оператор
 * снял все подписи), а не исключение на двери программы.
 */
export function productionProgramSignatureTemplateSlots(
  template: { slots?: string | null } | null | undefined,
): PrintSignatureSlot[] {
  if (!template) return [];
  return parsePrintSignatureSlots(template.slots ?? null);
}
