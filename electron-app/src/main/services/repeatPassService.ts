import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { parseRepairHistoryMeta, repairHistoryEntryType, REPAIR_HISTORY_OPERATION_TYPE } from '@matricarmz/shared';

import { operations } from '../database/schema.js';

/**
 * Нумерация возвратов: номер прохода — это порядковый номер записи с флагом среди таких же
 * записей (двигатель + вид работ / этап), а не число, введённое оператором. Снял галочку у
 * ранней записи — следующие сдвинулись; поставил — встала на своё место по дате.
 *
 * Зачем материализуем `pass`, а не считаем при каждом чтении: номер читают список этапов,
 * лента истории, отчёт и карточка двигателя — у каждого свой путь, и пять пересчётов
 * разъехались бы. Здесь одна дверь записи и одна точка пересчёта.
 *
 * Флаг — само наличие `repeat` в мете; `pass >= 2` у старых записей означает тот же флаг
 * (совместимость чтения). Поэтому нумерация нормализует и старые записи, когда группу тронули.
 */
export async function renumberRepeatPasses(
  db: BetterSQLite3Database,
  group: { engineId: string; kind: 'sheet' | 'stage'; key: string },
): Promise<Map<string, number>> {
  const engineId = String(group.engineId ?? '').trim();
  const key = String(group.key ?? '').trim().toLowerCase();
  const assigned = new Map<string, number>();
  if (!engineId || !key) return assigned;

  const rows = await db
    .select({
      id: operations.id,
      operationType: operations.operationType,
      metaJson: operations.metaJson,
      createdAt: operations.createdAt,
      performedAt: operations.performedAt,
    })
    .from(operations)
    .where(
      and(
        eq(operations.engineEntityId, engineId),
        eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE),
        isNull(operations.deletedAt),
      ),
    );

  const flagged: Array<{ id: string; at: number; createdAt: number; meta: NonNullable<ReturnType<typeof parseRepairHistoryMeta>> }> = [];
  for (const row of rows) {
    const meta = parseRepairHistoryMeta(row.metaJson ?? null);
    if (!meta || repairHistoryEntryType(meta, String(row.operationType)) !== group.kind || !meta.repeat) continue;
    const rowKey = group.kind === 'sheet' ? String(meta.sheet?.typeCode ?? '') : String(meta.stage?.code ?? '');
    if (rowKey.trim().toLowerCase() !== key) continue;
    const at =
      typeof meta.at === 'number' && Number.isFinite(meta.at) && meta.at > 0
        ? meta.at
        : Number(row.performedAt ?? row.createdAt ?? 0);
    flagged.push({
      id: String(row.id),
      at,
      createdAt: Number(row.createdAt ?? 0),
      meta,
    });
  }
  // Порядок — тот же, что у читателей: сначала дата записи, внутри дня — порядок появления.
  flagged.sort((a, b) => a.at - b.at || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const ts = Date.now();
  for (let i = 0; i < flagged.length; i++) {
    const nextPass = i + 2;
    const item = flagged[i]!;
    assigned.set(item.id, nextPass);
    const current = item.meta.repeat;
    if (!current || current.pass === nextPass) continue;
    const next = { ...item.meta, repeat: { ...current, pass: nextPass } };
    await db
      .update(operations)
      .set({ metaJson: JSON.stringify(next), updatedAt: ts, syncStatus: 'pending' })
      .where(eq(operations.id, item.id));
  }
  return assigned;
}
