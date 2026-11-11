import { and, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { engineReclamationFacts, type EngineReclamationFacts } from '@matricarmz/shared';

import { erpEngineReclamations } from '../database/schema.js';
import { collectChunked } from '../utils/sqlChunks.js';

/**
 * Факты отслеживания рекламации — из локальной реплики очереди заездов.
 *
 * Очередь (`erp_engine_reclamations`) — источник правды: она переживает несколько
 * рекламаций и знает, какая из них текущая. EAV-зеркало (`reclamation_flag` и
 * соседи) живёт только как совместимость со старыми клиентами и с проекцией
 * серверной карточки, поэтому отслеживание (синяя метка в списке, фасет
 * «Рекламация», отчёты, ведомости, статус двигателя, источник правды по датам)
 * читается отсюда, а не из зеркала: иначе «Сохранить очередь» двигал бы очередь,
 * но не двигал бы ни одного отчёта.
 *
 * Реплика — server-write (pull-only), строки приезжают журналом синхронизации.
 */

export type EngineReclamationQueueRow = {
  queueNo: number;
  acceptedAt: number | null;
  shippedAt: number | null;
};

function ms(value: number | null | undefined): number | null {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Факты отслеживания по пачке двигателей — одним чтением реплики.
 *
 * Двигателей без рекламаций в карте нет: их признак «не рекламационный».
 */
export async function loadEngineReclamationFactsMap(
  db: BetterSQLite3Database,
  engineIds: readonly string[],
): Promise<Map<string, EngineReclamationFacts>> {
  const out = new Map<string, EngineReclamationFacts>();
  const ids = [...new Set(engineIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const rows = await collectChunked(ids, (chunk) =>
    db
      .select({
        engineId: erpEngineReclamations.engineId,
        queueNo: erpEngineReclamations.queueNo,
        acceptedAt: erpEngineReclamations.acceptedAt,
        shippedAt: erpEngineReclamations.shippedAt,
      })
      .from(erpEngineReclamations)
      .where(
        and(
          inArray(erpEngineReclamations.engineId, chunk),
          isNull(erpEngineReclamations.deletedAt),
        ),
      ),
  );
  const byEngine = new Map<string, EngineReclamationQueueRow[]>();
  for (const row of rows) {
    const engineId = String(row.engineId);
    const list = byEngine.get(engineId) ?? [];
    list.push({
      queueNo: Number(row.queueNo ?? 0),
      acceptedAt: ms(row.acceptedAt),
      shippedAt: ms(row.shippedAt),
    });
    byEngine.set(engineId, list);
  }
  for (const [engineId, list] of byEngine) {
    out.set(engineId, engineReclamationFacts(list));
  }
  return out;
}

/**
 * Характеры дефекта, которые уже вводили на этом заводе — из очереди рекламаций.
 *
 * Раньше список брался из EAV-атрибута `reclamation_defect_nature`: после перехода
 * на очередь значения лежат в её колонке `defect_nature`, и старый список молчал
 * об одном и том же наборе.
 */
export async function listReclamationDefectNaturesFromQueue(db: BetterSQLite3Database): Promise<string[]> {
  const rows = await db
    .select({ nature: erpEngineReclamations.defectNature })
    .from(erpEngineReclamations)
    .where(isNull(erpEngineReclamations.deletedAt));
  const used: string[] = [];
  for (const row of rows) {
    const label = String(row.nature ?? '').trim();
    if (label) used.push(label);
  }
  return used;
}
