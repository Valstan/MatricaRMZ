// ЕДИНАЯ ДВЕРЬ ЗАПИСИ КАРТОЧКИ СОТРУДНИКА.
//
// ПРОБЛЕМА, КОТОРУЮ ЭТОТ МОДУЛЬ РЕШАЕТ. Гейт дублей жил в `employees:setAttr` и
// проверял ОДИН атрибут за раз: ФИО пишется первым, табельный номер и даты — позже.
// Проверить по полному ключу «ФИО + табельный номер + должность + дата приёма + ДР» по
// одному атрибуту физически нечем: половины ключа ещё нет. Хуже — запись шла через
// `setAttr` ПО ОДНОМУ полю, и карточка могла остаться наполовину заведённой.
//
// ЧТО ЗДЕСЬ. Один вход для записи карточки целиком: получает ВСЕ поля карточки
// разом, считает из них полный ключ личности, спрашивает сервер, не занял ли этот
// ключ уже другой карточке, и только потом пишет. Аналог `saveEngineCardGated` для
// двигателей — и по той же причине: у карточки сотрудника есть второй вход (пикер
// «создать сотрудника»), и гейт обязан жить в одном месте, а не в каждом входе
// отдельно (класс brain G363 — «право/гейт держат в одном экране»).
//
// ГДЕ СЧИТАЕТСЯ ГЕЙТ. Сравнение ключа — на СЕРВЕРЕ: там полный срез сотрудников, а
// локальная реплика отстаёт (карточка синкается минутами). Правило сравнения — общее
// (`employeeCardKey` в `shared`), поэтому сервер и клиент не разойдутся.
//
// «ДО» И «ПОСЛЕ». Серверу нужны оба состояния ключа: «ДО» — чтобы понять, что дубль
// не эта запись создала (иначе нельзя было бы поправить дубль, пришедший из импорта
// ЗУП). «ДО» присылает клиент (это то, что оператор видел на экране), «ПОСЛЕ» —
// тоже клиент (поля, которые он собирается записать).
//
// ЧТО ПРОПУСКАЕТСЯ. Проверка живёт в сети: если сервер недоступен, запись НЕ
// блокируется (иначе клиент без сети не смог бы завести сотрудника вовсе) — ровно
// как в прежнем гейте. Оговорка: табельный номер всё равно защищён уникальным
// индексом в зеркале `erp_employee_cards`.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { EMPLOYEE_CARD_KEY_CODES } from '@matricarmz/shared';

import { getEntityDetails, setEntityAttribute } from './entityService.js';

/** Уровни отказа гейта — от мягкого к жёсткому. */
export type EmployeeCardBlockReason = 'name' | 'exact' | 'personnel';

export type EmployeeCardDuplicate = {
  id: string;
  fullName: string;
  login: string | null;
  personnelNumber: string | null;
  /** Поля ключа, которые расходятся: оператор видит, ЧЕМ карточки отличаются. */
  conflicts: string[];
};

export type EmployeeCardWriteDeps = {
  /** Локальная реплика, куда пишется карточка. */
  db: BetterSQLite3Database;
  /** Тип сущности «сотрудник» — для материализации отложенной карточки. */
  typeId?: string | null;
  /** Спрашивает сервер про занятость ключа. */
  checkKey: (args: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    excludeId: string;
  }) => Promise<
    | {
        ok: true;
        relation: 'different' | 'disputed' | 'exact' | 'personnel';
        matches: Array<{
          id: string;
          fullName: string;
          login: string | null;
          personnelNumber: string | null;
          relation: 'different' | 'disputed' | 'exact' | 'personnel';
          isNew: boolean;
          matchedBy: string[];
          conflicts: string[];
        }>;
      }
    | { ok: false; error: string }
  >;
};

export type EmployeeCardWriteResult =
  | { ok: true; written: string[] }
  | {
      ok: false;
      error: string;
      /** 'name' — совпало ФИО (предупреждение), 'exact' — совпал полный ключ, 'personnel' — совпал табельный номер. */
      blockReason: EmployeeCardBlockReason;
      /** Найденные карточки: оператору показываем, к кому идти. */
      duplicates: EmployeeCardDuplicate[];
    };

/** Поля, из которых собирается ключ личности. */
const KEY_CODES = new Set<string>(EMPLOYEE_CARD_KEY_CODES);

/**
 * Текущие значения полей ключа у карточки — из локальной реплики.
 *
 * Нужны, чтобы отличить «дубль был и до записи» от «дубль создала эта запись»:
 * правильный дубль (пришедший из импорта ЗУП) не должен мешать его править.
 */
async function readKeyFields(
  db: BetterSQLite3Database,
  employeeId: string,
  typeId?: string | null,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let details: { attributes: Record<string, unknown> } | null = null;
  try {
    details = await getEntityDetails(db, employeeId, typeId ?? undefined);
  } catch {
    return out;
  }
  for (const code of EMPLOYEE_CARD_KEY_CODES) {
    const value = details.attributes[code];
    if (value !== undefined && value !== null && value !== '') out[code] = value;
  }
  return out;
}

/** Уровень отказа по связи карточек: 'disputed' → 'name', 'exact' → 'exact', 'personnel' → 'personnel'. */
function blockReasonFor(relation: string): EmployeeCardBlockReason | null {
  if (relation === 'personnel') return 'personnel';
  if (relation === 'exact') return 'exact';
  if (relation === 'disputed') return 'name';
  return null;
}

/**
 * Запись карточки сотрудника целиком через одну дверь.
 *
 * Порядок: сначала гейт, потом запись. Отказ гейта не оставляет полузаписи — в этом
 * и смысл двери (при прежней записи по одному атрибуту карточка материализовалась
 * первым же `setAttr`, и гейт мог отклонить запись, оставив карточку без ФИО).
 *
 * `force` — оператор подтвердил, что это другой человек (обоснование им записано
 * отдельно, на сервере). Проверка при этом НЕ повторяется: ключ не изменился, тот же
 * ключ снова дал бы тот же отказ.
 */
export async function saveEmployeeCardGated(
  deps: EmployeeCardWriteDeps,
  employeeId: string,
  fields: Record<string, unknown>,
  opts?: { force?: boolean },
): Promise<EmployeeCardWriteResult> {
  const id = String(employeeId ?? '').trim();
  if (!id) return { ok: false, error: 'пустой id сотрудника', blockReason: 'exact', duplicates: [] };

  const keyFields: Record<string, unknown> = {};
  for (const [code, value] of Object.entries(fields ?? {})) {
    // Ключи домена в нижнем регистре, а код атрибута приходит как есть — сверяем
    // без учёта регистра, но пишем под исходным кодом.
    const canonical = String(code ?? '').trim().toLowerCase();
    if (KEY_CODES.has(canonical)) keyFields[canonical] = value;
  }

  // Проверять нечего — ключ не меняется этой записью. Поля вне ключа (вложения,
  // переводы) сервера не касаются, но пишутся как обычно.
  const changesKey = Object.keys(keyFields).length > 0;

  if (opts?.force !== true && changesKey) {
    const before = await readKeyFields(deps.db, id, deps.typeId);
    const after = { ...before, ...keyFields };
    const check = await deps.checkKey({ before, after, excludeId: id });
    if (check.ok) {
      const reason = blockReasonFor(check.relation);
      if (reason) {
        const duplicates = check.matches
          .filter((m) => m.isNew)
          .map((m) => ({
            id: m.id,
            fullName: m.fullName,
            login: m.login,
            personnelNumber: m.personnelNumber,
            conflicts: m.conflicts,
          }));
        const listed = duplicates.map((d) => d.fullName || 'без имени');
        if (reason === 'personnel') {
          return {
            ok: false,
            error:
              `Табельный номер уже занят: ${listed.join('; ')}. ` +
              'Откройте эту карточку и дополните её — второго сотрудника с таким номером быть не может.',
            blockReason: 'personnel',
            duplicates,
          };
        }
        if (reason === 'exact') {
          return {
            ok: false,
            error:
              `Совпал полный ключ личности (ФИО, должность, дата приёма, день рождения): ${listed.join('; ')}. ` +
              'Откройте найденную карточку и дополните её — или обоснуйте, что это другой человек.',
            blockReason: 'exact',
            duplicates,
          };
        }
        return {
          ok: false,
          error:
            `Такой сотрудник уже есть: ${listed.join('; ')}. ` +
            'Если это другой человек — подтвердите заведение, иначе откройте найденную карточку.',
          blockReason: 'name',
          duplicates,
        };
      }
    }
  }

  const written: string[] = [];
  for (const [code, value] of Object.entries(fields ?? {})) {
    const res = await setEntityAttribute(deps.db, id, code, value, deps.typeId ?? undefined);
    if (!res.ok) {
      return {
        ok: false,
        error: `не удалось записать поле «${code}»: ${res.error ?? 'неизвестная ошибка'}`,
        blockReason: 'exact',
        duplicates: [],
      };
    }
    written.push(code);
  }
  return { ok: true, written };
}

export const __testables = {
  readKeyFields,
  blockReasonFor,
  KEY_CODES: KEY_CODES as Set<string>,
};
