/**
 * Снятие утиля двигателя — действие «Деталь отремонтирована» (промт КАРМАНА #170).
 *
 * Окно гейта предлагает ровно два действия:
 *  · «Деталь отремонтирована» — снять утиль и продолжить (этап заводится после);
 *  · «Отмена» — ничего не писать (это делает сам экран, здесь ничего не происходит).
 *
 * Действие делает ЧЕТЫРЕ вещи, и все четыре нужны по критериям приёмки:
 *  1. **след в истории ремонта** — запись с меткой снятия утиля (`scrapResolved`),
 *     с причиной и автором; по истории потом собирается отчёт «утильные двигатели,
 *     снятые с утиля»;
 *  2. **утиль снимается** — те же глобальные флаги карточки, что снимает воронка этапов
 *     (`clearEngineScrapFlag`), плюс сам след гасит утиль ПО ДЕТАЛИ (по моменту события);
 *  3. **деталь возвращается в ремонтный фонд** — существующей дверью заноса в ремфонд;
 *  4. **причина обязательна** — без неё след снятия неполон (пункт 10 промта).
 *
 * Механику снятия утиля НЕ заводим вторую: тот же `scrapResolved`-след и те же флаги, что
 * у действия «Вывод из утиля» в карточке.
 */

import { randomUUID } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  buildRepairHistoryMeta,
  REPAIR_HISTORY_OPERATION_TYPE,
  SCRAP_RESOLVE_REASONS,
} from '@matricarmz/shared';

import { upsertOperation } from './operationService.js';
import { clearEngineScrapFlag } from './repairStageService.js';

/** Причины снятия утиля — те же, что спрашивает программа при снятии пометки. */
export { SCRAP_RESOLVE_REASONS };

export type EngineScrapResolveInput = {
  engineId: string;
  /** id детали (номенклатурная позиция) — для возврата в ремонтный фонд. */
  partId?: string | null;
  /** Подпись детали — попадает в след. */
  partLabel?: string | null;
  /** Исход: деталь отремонтирована или заменена. */
  outcome?: 'repaired' | 'replaced';
  /** ПРИЧИНА снятия утиля (обязательна). */
  reason: string;
  /** Момент события (дата ремонта детали). */
  atMs?: number | null;
};

export type EngineScrapResolveResult = {
  ok: boolean;
  error?: string;
  /** Предупреждение: след записан, но деталь не вернулась в ремонтный фонд. */
  warning?: string;
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Снять утиль двигателя: след в истории + снятие флагов + возврат детали в ремонтный фонд.
 *
 * `repairFundIntake` — существующая дверь заноса в ремфонд (`warehouse:repairFund:intake`).
 * Она требует сервера: офлайн возврат не проходит — поэтому её отказ НЕ отменяет снятие
 * утиля (иначе оператор останется без возможности начать ремонт), а возвращается
 * предупреждением: след в истории уже записан.
 */
export async function resolveEngineScrap(args: {
  db: BetterSQLite3Database;
  engineId: string;
  input: EngineScrapResolveInput;
  actor: string;
  repairFundIntake?: (input: {
    engineId: string;
    items: Array<{ partId: string; partLabel: string; qty: number }>;
  }) => Promise<{ ok: boolean; error?: string }>;
}): Promise<EngineScrapResolveResult> {
  const engineId = text(args.input.engineId);
  if (!engineId) return { ok: false, error: 'Укажите двигатель' };
  const reason = text(args.input.reason);
  if (!reason) return { ok: false, error: 'Укажите причину снятия утиля' };

  const outcome = args.input.outcome === 'replaced' ? 'replaced' : 'repaired';
  const partLabel = text(args.input.partLabel) || 'Деталь';
  const atMs =
    typeof args.input.atMs === 'number' && Number.isFinite(args.input.atMs) && args.input.atMs > 0
      ? args.input.atMs
      : Date.now();

  // 1. След в истории ремонта: снятие утиля с причиной и автором.
  const action = outcome === 'replaced' ? `${partLabel} заменена` : `${partLabel} отремонтирована`;
  const meta = buildRepairHistoryMeta({
    action,
    scrapResolved: { outcome, partLabel, reason, atMs },
    at: atMs,
    note: reason,
  });
  await upsertOperation(args.db, {
    id: randomUUID(),
    engineId,
    operationType: REPAIR_HISTORY_OPERATION_TYPE,
    status: 'done',
    note: action,
    performedBy: args.actor,
    metaJson: JSON.stringify(meta),
  });

  // 2. Утиль снимается: те же глобальные флаги, что снимает воронка этапов.
  await clearEngineScrapFlag(args.db, engineId);

  // 3. Деталь возвращается в ремонтный фонд (существующая дверь заноса).
  const partId = text(args.input.partId);
  if (args.repairFundIntake && partId) {
    try {
      const res = await args.repairFundIntake({
        engineId,
        items: [{ partId, partLabel, qty: 1 }],
      });
      if (!res.ok) {
        return {
          ok: true,
          warning: `Утиль снят, но деталь не вернулась в ремонтный фонд: ${res.error ?? 'сервер недоступен'}`,
        };
      }
    } catch (e) {
      return { ok: true, warning: `Утиль снят, но деталь не вернулась в ремонтный фонд: ${String(e)}` };
    }
  } else if (!partId) {
    return { ok: true, warning: 'Утиль снят. Деталь не найдена по номеру — верните её в ремонтный фонд вручную.' };
  }

  return { ok: true };
}
