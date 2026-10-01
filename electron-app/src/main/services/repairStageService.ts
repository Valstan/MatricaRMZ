import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';

import {
  buildRepairHistoryMeta,
  DEFAULT_REPAIR_STAGE_TEMPLATES,
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

import { attributeValues, operations } from '../database/schema.js';
import { httpAuthed } from './httpClient.js';
import { getOperation, softDeleteOperation, upsertOperation } from './operationService.js';
import { collectChunked } from '../utils/sqlChunks.js';

// Строки единого списка этапов (план unified-repair-stages, шаг 2: хранилище).
// Писатель чистый: статусы карточки не трогает (их смерть — шаг 8 плана после
// приёмки). Субординация дат и пометка возврата — здесь, в точке записи.

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/** Автор строки для экранов: пусто и служебный `local` — null («неизвестно»). */
export function normalizeStageAuthor(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return !s || s === 'local' ? null : s;
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
      // H1: кто внёс этап. Служебный `local` и пусто — «неизвестно», не показываем.
      by: normalizeStageAuthor(row.performedBy),
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
    // Дефектовка — фиксированная дата: при обновлении листа дефектовки дата не меняется
    if (template.code === 'disassembly_defect' && existingMeta.at && existingMeta.at !== atMs) {
      return { ok: false, error: 'Дата дефектовки фиксирована — при обновлении листа она не меняется' };
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

  // Снятие статуса «утиль» при укладке/сборке и выше
  if (template.sortOrder >= 40) {
    await clearEngineScrapFlag(db, engineId);
  }

  return { ok: true, id, created, backward, pass };
}

/**
 * Снять глобальный флаг «утиль» с двигателя.
 * Дефектовка остаётся в истории, но двигатель больше не считается утильным.
 */
async function clearEngineScrapFlag(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<void> {
  const scrapRows = await db
    .select()
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.entityId, engineId),
        eq(attributeValues.attributeDefId, 'is_scrap'),
      ),
    )
    .limit(1);
  if (scrapRows[0]) {
    await db
      .update(attributeValues)
      .set({ valueJson: JSON.stringify('0') })
      .where(eq(attributeValues.id, scrapRows[0].id));
  }
}

/** Ранг кода для читателей вне шаблона (неизвестный — боковая ветка). */
export function stageRank(code: string): number {
  return repairStageRank(code);
}

/**
 * Серверный справочник шаблонов с fallback на статику шага 1 (та же философия,
 * что у IPC `workSheets:stages:save`: без сервера экран честно говорит fallback).
 * Общая для IPC-регистров — чтобы авто-простановки не тащили каждая свой fetch.
 */
export async function loadRepairStageTemplates(
  sysDb: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { includeArchived?: boolean },
): Promise<{ templates: RepairStageTemplate[]; source: 'server' | 'fallback' }> {
  try {
    const qs = args?.includeArchived ? '?includeArchived=1' : '';
    const res = await httpAuthed(sysDb, apiBaseUrl, `/repair-stage-templates${qs}`, { method: 'GET' });
    const json = (res.ok ? res.json : null) as { ok?: boolean; rows?: RepairStageTemplate[] } | null;
    if (res.ok && json?.ok && Array.isArray(json.rows) && json.rows.length > 0) {
      return { templates: json.rows, source: 'server' };
    }
  } catch {
    /* офлайн — статика */
  }
  return { templates: [...DEFAULT_REPAIR_STAGE_TEMPLATES], source: 'fallback' };
}

/**
 * Авто-простановка этапа «если ещё не отмечен» (шаг 8 плана: замена
 * авто-переходам статусов `advanceEngineStatusForWorkOrder`). Идемпотентна:
 * повтор по тому же коду — `{marked:false}`, а не дубль и не вопрос оператору
 * (автомат не спрашивает — спрашивает только ручной ввод через save).
 * Гейты записи те же, что у ручного ввода (субординация дат): отказ автомата —
 * честная `{ok:false}`, вызывающий решает (обычно best-effort).
 */
export async function ensureRepairStageRow(
  db: BetterSQLite3Database,
  engineId: string,
  code: string,
  atMs: number,
  actor: string,
  templates: ReadonlyArray<RepairStageTemplate> = DEFAULT_REPAIR_STAGE_TEMPLATES,
): Promise<
  | { ok: true; marked: boolean; rowId: string | null; pass: number | null }
  | { ok: false; error: string }
> {
  const id = text(engineId);
  const stageCode = text(code).toLowerCase();
  if (!id) return { ok: false, error: 'Укажите двигатель' };
  if (!stageCode) return { ok: false, error: 'Укажите этап' };
  if (templateByCode(templates, stageCode) === null) {
    return { ok: false, error: `Неизвестный этап: ${stageCode}` };
  }
  const rows = await listRepairStageRows(db, id);
  const existing = rows.find((r) => r.code === stageCode) ?? null;
  if (existing) return { ok: true, marked: false, rowId: existing.id, pass: existing.pass };
  const saved = await saveRepairStageRow(
    db,
    { id: randomUUID(), engineId: id, code: stageCode, atMs },
    actor,
    templates,
  );
  if (!saved.ok) return saved;
  return { ok: true, marked: true, rowId: saved.id, pass: saved.pass };
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

export type EngineStageMarks = {
  /** Последний датированный этап (место двигателя); пусто — этапов с датой нет. */
  lastStageCode: string | null;
  lastStageAt: number | null;
  /** Отметка боковой ветки утиля (с датой или без — решение принято в любом виде). */
  hasScrapBranch: boolean;
};

/**
 * Место и утиль пачкой для читателей поверх EAV-снапшотов (отчёты): у них нет
 * истории операций, а бегать за каждым двигателем — значит убить отчёт на
 * парке (~2500 двигателей). Одним запросом по чанкам, читает только stage-строки
 * (`meta_json` с `"stage":` — тот же паттерн, что у серверного бэкфилла).
 */
export async function loadEngineStageMarks(
  db: BetterSQLite3Database,
  engineIds: string[],
): Promise<Map<string, EngineStageMarks>> {
  const out = new Map<string, EngineStageMarks>();
  const ids = [...new Set(engineIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const rows = await collectChunked(ids, (chunk) =>
    db
      .select({ engineEntityId: operations.engineEntityId, metaJson: operations.metaJson })
      .from(operations)
      .where(
        and(
          inArray(operations.engineEntityId, chunk),
          eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .limit(20000),
  );
  // Как у списка двигателей: позже датой, при равной — старшим проходом.
  const best = new Map<string, { code: string; at: number; pass: number }>();
  for (const row of rows as Array<{ engineEntityId: unknown; metaJson: unknown }>) {
    const engineId = String(row.engineEntityId ?? '').trim();
    if (!engineId) continue;
    const meta = parseRepairHistoryMeta(typeof row.metaJson === 'string' ? row.metaJson : null);
    if (!meta || repairHistoryEntryType(meta, REPAIR_HISTORY_OPERATION_TYPE) !== 'stage' || !meta.stage) continue;
    const code = text(meta.stage.code).toLowerCase();
    if (!code) continue;
    let marks = out.get(engineId);
    if (!marks) {
      marks = { lastStageCode: null, lastStageAt: null, hasScrapBranch: false };
      out.set(engineId, marks);
    }
    if (code === 'scrap_branch') marks.hasScrapBranch = true;
    const at = typeof meta.at === 'number' && Number.isFinite(meta.at) && meta.at > 0 ? meta.at : null;
    if (at === null) continue;
    const pass = meta.repeat?.pass ?? 1;
    const cur = best.get(engineId);
    if (!cur || at > cur.at || (at === cur.at && pass > cur.pass)) best.set(engineId, { code, at, pass });
  }
  for (const [engineId, b] of best) {
    const marks = out.get(engineId);
    if (marks) {
      marks.lastStageCode = b.code;
      marks.lastStageAt = b.at;
    }
  }
  return out;
}
