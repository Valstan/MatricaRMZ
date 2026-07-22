/**
 * Серверный backstop номера наряда.
 *
 * Номер наряда живёт внутри `operations.meta_json` — строчный authz-гейт его не видит, а zod-схема
 * sync-строки принимает meta_json как обычную строку. До этого гейта любой клиент (в том числе старый,
 * с багом «№ новый навсегда») мог прислать наряд с чужим или нулевым номером, и сервер бы это принял.
 *
 * Правило: у уже материализованного наряда номер неизменяем — кроме смены суперадмином (UI
 * `workOrders:setNumber`, чинить номера, потерянные старым багом).
 *
 * Чужая смена не отклоняется, а **лечится**: номер в строке переписывается на сохранённый, остальное
 * содержимое едет дальше. Отказ отправил бы всю строку в skipped и потерял бы легитимные правки наряда
 * со старого клиента, плюс залил бы «Критические события» шумом на каждом автосейве.
 *
 * Вызывается ДО `writeSyncChanges` — ledger подписывает уже вылеченную строку, иначе ledger и PG
 * разъедутся, и `ledgerReplayToDb` вернул бы неправильный номер.
 */
import { and, eq, isNull, like, ne } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { operations } from '../../database/schema.js';
import { logInfo, logWarn } from '../../utils/logger.js';
import { ingestServerCriticalEvent } from '../criticalEventsService.js';
import type { SyncWriteActor, SyncWriteInput } from './syncWriteService.js';

const WORK_ORDER_OPERATION_TYPE = 'work_order';

export type WorkOrderNumberHeal = {
  rowId: string;
  stored: number;
  incoming: number;
  action: 'healed' | 'allowed' | 'collision_healed';
};

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function numberOf(payload: Record<string, unknown> | null): number {
  const n = Number(payload?.workOrderNumber ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Занят ли номер другим живым нарядом. LIKE — только префильтр (`:7` ловит и 70, и 700), поэтому
 * решает точная сверка парсом, и выборку НЕЛЬЗЯ резать лимитом: усечение дало бы ложное «свободно».
 */
async function isNumberTaken(rowId: string, workOrderNumber: number): Promise<boolean> {
  const rows = await db
    .select({ id: operations.id, metaJson: operations.metaJson })
    .from(operations)
    .where(
      and(
        eq(operations.operationType, WORK_ORDER_OPERATION_TYPE),
        isNull(operations.deletedAt),
        ne(operations.id, rowId),
        like(operations.metaJson, `%"workOrderNumber":${workOrderNumber}%`),
      ),
    );
  return rows.some((row) => numberOf(parseJson(row.metaJson)) === workOrderNumber);
}

/**
 * Осознанная смена номера помечена в самом payload: `setWorkOrderNumber` (и скрипт починки) кладут
 * в auditTrail запись `{ action: 'number_change', note: '№<новый номер>' }`. Ищем её по всему
 * следу, а не только в конце: между сменой и push'ом карточку могли ещё раз отредактировать.
 * Без маркера отличающийся номер даже от суперадмина — побочный эффект обычного сохранения, и
 * лечится как чужой.
 */
function carriesNumberChangeMarker(payload: Record<string, unknown>, workOrderNumber: number): boolean {
  const trail = payload.auditTrail;
  if (!Array.isArray(trail)) return false;
  return trail.some((item) => {
    const entry = item as { action?: unknown; note?: unknown } | null;
    if (String(entry?.action ?? '') !== 'number_change') return false;
    const match = /№(\d+)/.exec(String(entry?.note ?? ''));
    return match ? Number(match[1]) === workOrderNumber : false;
  });
}

export async function enforceWorkOrderNumberImmutability(
  inputs: SyncWriteInput[],
  actor: SyncWriteActor,
): Promise<WorkOrderNumberHeal[]> {
  // По `input.type` НЕ фильтруем: writeSyncChanges выводит операцию заново из row.deleted_at, поэтому
  // строка, помеченная клиентом как 'delete', но без deleted_at, доедет до PG обычным upsert'ом.
  const candidates = inputs.filter((input) => {
    if (input.table !== SyncTableName.Operations) return false;
    const row = input.row as Record<string, unknown> | undefined;
    return Boolean(row) && String(row?.operation_type ?? '') === WORK_ORDER_OPERATION_TYPE;
  });
  if (candidates.length === 0) return [];

  const isSuperadmin = String(actor.role ?? '').toLowerCase() === 'superadmin';
  const heals: WorkOrderNumberHeal[] = [];

  for (const input of candidates) {
    const row = input.row as Record<string, unknown>;
    // Ключ берём из САМОЙ строки: `row_id` приходит от клиента отдельным полем и в PG не пишется —
    // подставив туда чужой/несуществующий id, клиент увёл бы гейт мимо защищаемой строки.
    const rowId = String(row.id ?? input.row_id ?? '');
    if (!rowId) continue;
    const incomingPayload = parseJson(row.meta_json);
    if (!incomingPayload) continue;
    const incoming = numberOf(incomingPayload);

    const storedRows = await db
      .select({ metaJson: operations.metaJson })
      .from(operations)
      .where(and(eq(operations.id, rowId), eq(operations.operationType, WORK_ORDER_OPERATION_TYPE)))
      .limit(1);
    // Строки ещё нет — первая материализация, номер присвоил клиент. Не наше дело.
    if (storedRows.length === 0) continue;
    const stored = numberOf(parseJson(storedRows[0]?.metaJson));
    if (stored <= 0 || incoming === stored) continue;

    if (isSuperadmin && incoming > 0 && carriesNumberChangeMarker(incomingPayload, incoming)) {
      if (!(await isNumberTaken(rowId, incoming))) {
        heals.push({ rowId, stored, incoming, action: 'allowed' });
        continue;
      }
      row.meta_json = JSON.stringify({ ...incomingPayload, workOrderNumber: stored });
      row.note = `Наряд №${stored}`;
      heals.push({ rowId, stored, incoming, action: 'collision_healed' });
      continue;
    }

    row.meta_json = JSON.stringify({ ...incomingPayload, workOrderNumber: stored });
    row.note = `Наряд №${stored}`;
    heals.push({ rowId, stored, incoming, action: 'healed' });
  }

  return heals;
}

export function reportWorkOrderNumberHeals(actor: SyncWriteActor, heals: WorkOrderNumberHeal[]): void {
  if (heals.length === 0) return;
  const login = actor.username || actor.id;
  for (const heal of heals) {
    if (heal.action === 'allowed') {
      logInfo('work order number changed by superadmin', {
        actor: login,
        row_id: heal.rowId,
        from: heal.stored,
        to: heal.incoming,
      });
      continue;
    }
    logWarn('work order number healed on sync write', {
      actor: login,
      row_id: heal.rowId,
      stored: heal.stored,
      incoming: heal.incoming,
      action: heal.action,
    });
  }

  // Столкновение номеров при осознанной смене — редкое и требует глаз владельца. Обычный heal
  // (старый клиент прислал 0) в критические события НЕ пишем: это фон, а не инцидент.
  const collisions = heals.filter((heal) => heal.action === 'collision_healed');
  if (collisions.length === 0) return;
  ingestServerCriticalEvent({
    eventCode: 'work_order.number_collision',
    title: 'Номер наряда занят — смена отклонена',
    humanMessage:
      `${login} пытался присвоить наряду номер ${collisions.map((c) => c.incoming).join(', ')}, ` +
      'но такой номер уже у другого наряда — номер оставлен прежним.',
    category: 'sync',
    severity: 'warn',
    aiDetails: { login, actorId: actor.id, collisions },
    dedupMessage: `work_order_number_collision:${login}`,
  });
}
