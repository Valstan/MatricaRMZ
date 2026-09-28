import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  buildRepairHistoryMeta,
  findStageDateConflict,
  isStageBackwardMove,
  isSameWorkSheetDay,
  moscowDayKey,
  nextWorkSheetPass,
  parseRepairHistoryMeta,
  repairHistoryEntryType,
  repairStageRank,
  REPAIR_HISTORY_OPERATION_TYPE,
  type DatedStage,
  type RepairHistoryRepeat,
  type RepairStageRow,
  type RepairStageTemplate,
  type SaveRepairStageInput,
  type SaveRepairStageResult,
  type WorkSheetDuplicateRef,
} from '@matricarmz/shared';

import { operations } from '../database/schema.js';
import { getOperation, softDeleteOperation, upsertOperation } from './operationService.js';

// Строки единого списка этапов (план unified-repair-stages, шаг 2: хранилище).
// Писатель чистый: статусы карточки не трогает (их смерть — шаг 8 плана после
// приёмки). Субординация дат и пометка возврата — здесь, в точке записи.

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function templateByCode(
  templates: ReadonlyArray<RepairStageTemplate>,
  code: string,
): RepairStageTemplate | null {
  const c = text(code).toLowerCase();
  return templates.find((t) => t.code === c) ?? null;
}

/** Строки-этапы двигателя для гейтов (без удалённых). */
export async function listRepairStageRows(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<RepairStageRow[]> {
  const id = text(engineId);
  if (!id) return [];
  const rows = (await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.engineEntityId, id),
        eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE),
        isNull(operations.deletedAt),
      ),
    )
    .orderBy(desc(operations.updatedAt))
    .limit(2000)) as Array<Record<string, unknown>>;
  const out: RepairStageRow[] = [];
  for (const row of rows) {
    const meta = parseRepairHistoryMeta(typeof row.metaJson === 'string' ? row.metaJson : null);
    if (!meta || repairHistoryEntryType(meta, String(row.operationType ?? '')) !== 'stage' || !meta.stage) continue;
    const at =
      typeof meta.at === 'number' && Number.isFinite(meta.at) && meta.at > 0
        ? meta.at
        : typeof row.performedAt === 'number' && Number.isFinite(row.performedAt)
          ? (row.performedAt as number)
          : null;
    out.push({
      id: text(row.id),
      code: meta.stage.code,
      name: meta.stage.name,
      at,
      pass: meta.repeat?.pass ?? 1,
      note: meta.note ?? '',
    });
  }
  return out;
}

function toDated(rows: RepairStageRow[], excludeId?: string): DatedStage[] {
  return rows
    .filter((r) => r.id !== excludeId)
    .map((r) => ({ code: r.code as DatedStage['code'], at: r.at, ...(r.id ? { id: r.id } : {}) }));
}

export async function saveRepairStageRow(
  db: BetterSQLite3Database,
  input: SaveRepairStageInput,
  actor: string,
  templates: ReadonlyArray<RepairStageTemplate>,
): Promise<SaveRepairStageResult> {
  const id = text(input.id);
  const engineId = text(input.engineId);
  if (!id) return { ok: false, error: 'Нет id строки' };
  if (!engineId) return { ok: false, error: 'Укажите двигатель' };
  const template = templateByCode(templates, input.code);
  if (!template) return { ok: false, error: `Неизвестный этап: ${text(input.code) || '—'}` };
  const atMs = Number(input.atMs);
  if (!Number.isFinite(atMs) || atMs <= 0) return { ok: false, error: 'Укажите дату этапа' };

  const existing = await getOperation(db, id);
  const existingMeta = existing ? parseRepairHistoryMeta(existing.metaJson ?? null) : null;
  if (existing) {
    if (!existingMeta || repairHistoryEntryType(existingMeta, existing.operationType) !== 'stage') {
      return { ok: false, error: 'Эта запись истории — не строка этапа, править её здесь нельзя' };
    }
    if (text(existing.engineEntityId) !== engineId) {
      return { ok: false, error: 'Строку нельзя перевесить на другой двигатель — удалите и заведите заново' };
    }
  }

  const siblings = await listRepairStageRows(db, engineId);
  const dated = toDated(siblings, id);

  // Субординация дат — до любой записи.
  const conflict = findStageDateConflict(dated, template.code, atMs);
  if (conflict) {
    const other = templateByCode(templates, conflict as string);
    return {
      ok: false,
      error: `«${template.name}» не может быть раньше «${other?.name ?? conflict}» — сначала идёт нижележащий этап`,
    };
  }

  // Гейт дублей — тот же этап в тот же день: спрашиваем, как у строк работ.
  const explicitPass = Number(input.repeatPass);
  const confirmedRepeat = Number.isFinite(explicitPass) && explicitPass >= 2 ? Math.floor(explicitPass) : null;
  const carriedRepeat = existingMeta?.repeat ?? null;
  if (confirmedRepeat === null && !carriedRepeat) {
    const refs: WorkSheetDuplicateRef[] = siblings
      .filter((r) => r.id !== id && r.code === template.code && r.at !== null && isSameWorkSheetDay(r.at, atMs))
      .map((r) => ({ id: r.id, typeName: r.name, at: r.at as number, pass: r.pass, performedBy: null }))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    if (refs.length > 0) {
      return {
        ok: false,
        error: `На этот двигатель за ${moscowDayKey(atMs)} этап «${template.name}» уже внесён`,
        duplicate: { refs, nextPass: nextWorkSheetPass(refs), typeName: template.name, atMs },
      };
    }
  }

  // Возврат назад помечается новым проходом сам (решение принято фактом записи),
  // отдельный вопрос не задаём — пометка и есть сигнал.
  const backward =
    confirmedRepeat === null && !carriedRepeat && isStageBackwardMove(dated, template.code);
  let repeat: RepairHistoryRepeat | null = carriedRepeat;
  if (confirmedRepeat !== null) {
    repeat = {
      pass: Math.min(confirmedRepeat, 99),
      ...(text(input.repeatReason) ? { reason: text(input.repeatReason).slice(0, 500) } : {}),
    };
  } else if (backward) {
    const maxPass = siblings.reduce((m, r) => (r.code === template.code && r.pass > m ? r.pass : m), 1);
    repeat = { pass: Math.min(maxPass + 1, 99) };
  }
  const pass = repeat?.pass ?? 1;

  const meta = buildRepairHistoryMeta({
    action: template.name,
    at: atMs,
    ...(text(input.note) ? { note: text(input.note) } : {}),
    entryType: 'stage',
    stage: { code: template.code, name: template.name },
    ...(repeat ? { repeat } : {}),
  });
  const noteLine = [`Этап: ${template.name}`, text(input.note)].filter(Boolean).join(' · ');
  const { created } = await upsertOperation(db, {
    id,
    engineId,
    operationType: REPAIR_HISTORY_OPERATION_TYPE,
    status: 'done',
    note: noteLine,
    performedBy: actor,
    metaJson: JSON.stringify(meta),
  });
  return { ok: true, id, created, backward, pass };
}

/** Ранг кода для читателей вне шаблона (неизвестный — боковая ветка). */
export function stageRank(code: string): number {
  return repairStageRank(code);
}

/** Мягкое удаление строки этапа (синк погасит её у остальных клиентов). */
export async function deleteRepairStageRow(
  db: BetterSQLite3Database,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rowId = text(id);
  if (!rowId) return { ok: false, error: 'Нет id строки' };
  const existing = await getOperation(db, rowId);
  const meta = existing ? parseRepairHistoryMeta(existing.metaJson ?? null) : null;
  if (!existing || !meta || repairHistoryEntryType(meta, existing.operationType) !== 'stage') {
    return { ok: false, error: 'Строка этапа не найдена' };
  }
  await softDeleteOperation(db, rowId);
  return { ok: true };
}
