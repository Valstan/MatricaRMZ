import { SyncTableName } from '@matricarmz/shared';

/**
 * Самолечение «сервер пропустил строку: не хватает зависимости».
 *
 * Сервер отвечает на push списком `skipped` с `reason='missing_dependency'`,
 * `dependency` (какой сущности нет) и `missing_id`. До 04.09.2026 клиент такие
 * строки только считал: они оставались `pending`, уходили в КАЖДЫЙ push и
 * пропускались снова — PC19 неделю слал 8 нарядов на двигатели, которых на
 * сервере не было, каждые 22 секунды, без единой ошибки на экране.
 *
 * Две развилки, обе решаются по локальной базе:
 * - зависимость ЕСТЬ локально (двигатель заведён здесь, но сервер его не получил —
 *   класс M52: строка помечена synced без подтверждения) → вернуть её в очередь;
 *   следующий push повезёт сначала её, потом наряд.
 * - зависимости нет и здесь → наряд не отправить никогда; помечаем `error`, чтобы
 *   он вышел из вечного цикла и стал виден в диагностике, а не в журнале сервера.
 */

export type SkippedRowLike = {
  table?: string | null;
  row_id?: string | null;
  reason?: string | null;
  dependency?: string | null;
  missing_id?: string | null;
};

// Какая таблица держит зависимость с таким именем (имена — из applyPushBatch на сервере).
// Зависимости на аккаунты (recipient_user, note_recipient) сюда не входят: аккаунт
// клиент не создаёт, вернуть его в очередь нечем — только error.
export const DEPENDENCY_TABLE: Readonly<Record<string, SyncTableName>> = {
  entity_type: SyncTableName.EntityTypes,
  attribute_def: SyncTableName.AttributeDefs,
  entity: SyncTableName.Entities,
  engine_entity: SyncTableName.Entities,
};

export type DependencyRequeuePlan = {
  // Локальные строки-зависимости, которые надо вернуть в очередь: table → ids.
  requeue: Map<SyncTableName, string[]>;
  // Пропущенные строки, которым помочь нечем: table → ids (пойдут в error).
  markError: Map<SyncTableName, string[]>;
};

const SYNC_TABLES = new Set<string>(Object.values(SyncTableName));

function push(map: Map<SyncTableName, string[]>, table: SyncTableName, id: string) {
  const arr = map.get(table) ?? [];
  if (!arr.includes(id)) arr.push(id);
  map.set(table, arr);
}

export async function planDependencyRequeue(
  skipped: readonly SkippedRowLike[],
  existsLocally: (table: SyncTableName, id: string) => Promise<boolean>,
): Promise<DependencyRequeuePlan> {
  const plan: DependencyRequeuePlan = { requeue: new Map(), markError: new Map() };
  const checked = new Map<string, boolean>();
  for (const row of skipped) {
    if (String(row?.reason ?? '') !== 'missing_dependency') continue;
    const table = String(row?.table ?? '');
    const rowId = String(row?.row_id ?? '');
    if (!SYNC_TABLES.has(table) || !rowId) continue;
    const depTable = DEPENDENCY_TABLE[String(row?.dependency ?? '')];
    const missingId = String(row?.missing_id ?? '');
    if (!depTable || !missingId) {
      push(plan.markError, table as SyncTableName, rowId);
      continue;
    }
    const key = `${depTable}:${missingId}`;
    let exists = checked.get(key);
    if (exists === undefined) {
      exists = await existsLocally(depTable, missingId).catch(() => false);
      checked.set(key, exists);
    }
    if (exists) push(plan.requeue, depTable, missingId);
    else push(plan.markError, table as SyncTableName, rowId);
  }
  return plan;
}
