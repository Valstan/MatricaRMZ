import 'dotenv/config';

import { ENGINE_INVENTORY_STAGE, REPAIR_HISTORY_OPERATION_TYPE, SyncTableName, SyncTableRegistry } from '@matricarmz/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { operations } from '../database/schema.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';

// engine-inventory:fix-defect-stage-dates — дата этапа «Разборка, дефектовка» = «Дата начала
// дефектовки» из вкладки дефектовки (`answers.defect_start_date` листа engine_inventory).
//
// Почему скрипт, а не правка кнопки одной: кнопка «Провести дефектовку» писала этап с
// Date.now() — датой нажатия. Повторная проводка двигала этап вперёд, и он вставал ПОСЛЕ
// обкатки/сборки. Этап нельзя было быть выше поздних этапов ремонта по смыслу.
//
// Что делаем: у живых строк этапа меняем `meta.at` (его читает список этапов, таймлайн и
// отчёты — `listRepairStageRows`) и `performed_at` на ту же дату. Пишем через
// writeSyncChanges, то есть запись идёт в журнал → клиенты получают исправление обычным
// инкрементальным pull. Прямой UPDATE в PG этого не делает: строка меняется, а `last_server_seq`
// прежний — парк бы увидел старое значение до полного pull.
//
// Пропускаем (и считаем): лист без `defect_start_date` или без числа в нём — даты не из чего
// взять, выдумывать её нельзя; этап с пометкой возврата (pass ≥ 2) — это сознательная вторая
// отметка, её не трогаем.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api engine-inventory:fix-defect-stage-dates            # dry-run
//   corepack pnpm -F @matricarmz/backend-api engine-inventory:fix-defect-stage-dates -- --apply
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка. Apply на проде — мутация прод-данных: только под
// явный OK владельца в том же ходе (#025).

const DEFECT_STAGE_CODE = 'disassembly_defect';
/** Коды этапов, которые по смыслу идут ПОЗЖЕ дефектовки — для отчёта о порядке. */
const LATER_STAGE_CODES = ['obkatka', 'sborka', 'otk', 'shipped', 'accepted'] as const;

type Meta = {
  at?: number;
  repeat?: { pass?: number } | null;
  stage?: { code?: string } | null;
  [k: string]: unknown;
};

function parseMeta(raw: unknown): Meta | null {
  if (raw == null) return null;
  try {
    const p = JSON.parse(String(raw)) as Meta;
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

function toMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function parseArgs(argv: string[]): { apply: boolean } {
  const out = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

function isDefectStage(meta: Meta | null): boolean {
  return String(meta?.stage?.code ?? '') === DEFECT_STAGE_CODE;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`engine-inventory:fix-defect-stage-dates — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const stageRows = (await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE),
        isNull(operations.deletedAt),
      ),
    )) as any[];
  const defectStages = stageRows.filter((r) => isDefectStage(parseMeta(r.metaJson)));
  console.log(`  живых строк истории: ${stageRows.length}, из них этапов «${DEFECT_STAGE_CODE}»: ${defectStages.length}`);
  if (defectStages.length === 0) {
    console.log('Чинить нечего.');
    return;
  }

  const engineIds = [...new Set(defectStages.map((r) => String(r.engineEntityId)))];
  const sheets = (await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.operationType, ENGINE_INVENTORY_STAGE),
        isNull(operations.deletedAt),
        inArray(operations.engineEntityId, engineIds as any),
      ),
    )) as any[];

  // Свежайший лист на двигатель — тот же выбор, что делает getRepairChecklistForEngine.
  const sheetByEngine = new Map<string, any>();
  for (const s of sheets) {
    const id = String(s.engineEntityId);
    const cur = sheetByEngine.get(id);
    if (!cur || Number(s.updatedAt ?? 0) > Number(cur.updatedAt ?? 0)) sheetByEngine.set(id, s);
  }
  const defectStartByEngine = new Map<string, number>();
  for (const [engineId, sheet] of sheetByEngine) {
    const answers = (parseMeta(sheet.metaJson) as { answers?: Record<string, unknown> } | null)?.answers;
    const raw = (answers?.defect_start_date ?? null) as { kind?: unknown; value?: unknown } | null;
    if (raw && String(raw.kind) === 'date') {
      const ms = toMs(raw.value);
      if (ms != null) defectStartByEngine.set(engineId, ms);
    }
  }

  // Поздние этапы того же двигателя — чтобы отчёт показал, не останется ли этап выше их.
  const laterByEngine = new Map<string, number[]>();
  for (const r of stageRows) {
    const meta = parseMeta(r.metaJson);
    const code = String(meta?.stage?.code ?? '');
    if (!code || code === DEFECT_STAGE_CODE) continue;
    if (!(LATER_STAGE_CODES as readonly string[]).includes(code)) continue;
    const at = toMs(meta?.at) ?? toMs(r.performedAt);
    if (at == null) continue;
    const arr = laterByEngine.get(String(r.engineEntityId)) ?? [];
    arr.push(at);
    laterByEngine.set(String(r.engineEntityId), arr);
  }

  let noSheet = 0;
  let noDate = 0;
  let repeatSkipped = 0;
  let same = 0;
  let outOfOrder = 0;
  const todo: Array<{ row: any; meta: Meta; date: number }> = [];

  for (const row of defectStages) {
    const engineId = String(row.engineEntityId);
    const meta = parseMeta(row.metaJson)!;
    if (toMs(meta?.repeat?.pass) != null && Number(meta?.repeat?.pass) >= 2) {
      repeatSkipped++;
      continue;
    }
    if (!sheetByEngine.has(engineId)) {
      noSheet++;
      continue;
    }
    const date = defectStartByEngine.get(engineId);
    if (date == null) {
      noDate++;
      continue;
    }
    if (toMs(meta.at) === date) {
      same++;
      continue;
    }
    const earliestLater = (laterByEngine.get(engineId) ?? []).sort((a, b) => a - b)[0];
    if (earliestLater != null && date > earliestLater) {
      outOfOrder++;
      console.log(
        `  ! ${engineId}: «Дата начала дефектовки» ${new Date(date).toISOString().slice(0, 10)} позже ближайшего позднего этапа ` +
          `${new Date(earliestLater).toISOString().slice(0, 10)} — этап останется после него, это к вопросу владельца`,
      );
    }
    todo.push({ row, meta, date });
  }

  console.log(
    `  без листа engine_inventory: ${noSheet}, без заполненной defect_start_date: ${noDate}, ` +
      `возвраты (pass ≥ 2) не трогаем: ${repeatSkipped}, уже верная дата: ${same}\n` +
      `  к записи: ${todo.length} (из них предупреждений о порядке: ${outOfOrder})`,
  );
  if (todo.length === 0) {
    console.log('Менять нечего.');
    return;
  }
  if (!args.apply) {
    console.log('\nБез --apply запись не выполняется.');
    return;
  }

  const ts = Date.now();
  const actor = { id: 'server', username: 'engine-inventory:fix-defect-stage-dates', role: 'system' };
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const inputs = chunk.map(({ row, meta, date }) => {
      const nextMeta: Meta = { ...meta, at: date };
      const dto = SyncTableRegistry.toSyncRow(SyncTableName.Operations, row) as Record<string, unknown>;
      return {
        type: 'upsert' as const,
        table: SyncTableName.Operations,
        row: {
          ...dto,
          meta_json: JSON.stringify(nextMeta),
          performed_at: date,
          updated_at: ts,
          sync_status: 'synced',
        },
        row_id: String(row.id),
      };
    });
    const res = await writeSyncChanges(inputs, actor, { allowSyncConflicts: true });
    done += chunk.length;
    console.log(`  записано ${done}/${todo.length} (транзакций журнала: ${res.ledgerApplied})`);
  }
  console.log('Готово. Даты придут клиентам инкрементальным pull (запись прошла через журнал).');
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
