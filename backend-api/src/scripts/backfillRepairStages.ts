import 'dotenv/config';

import { createHash } from 'node:crypto';

import {
  buildRepairHistoryMeta,
  DEFAULT_REPAIR_STAGE_TEMPLATES,
  isEavFlagSet,
  moscowDayKey,
  parseRepairHistoryMeta,
  SyncTableName,
  type RepairStageCode,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';

// stages:backfill — разовый перенос ранее введённых этапов в строки единого
// списка (план unified-repair-stages-2026-09, шаг 3).
//
// Источники (что во что):
//   - строки этапов работ (operations repair_history_entry + meta.sheet):
//     ukladka/sborka/obkatka → этапы тех же кодов, дата и проход сохраняются;
//     val и свои узлы пропускаются (не этапы) — счётчик skipped-unknown-node;
//   - EAV arrival_date → arrival; defect_date → disassembly_defect;
//   - entities.created_at двигателей → card_created (этап №1, таблица 05.10.2026);
//   - листы engine_inventory (answers.completeness_inspection_date) → arrival
//     (состав 05.10.2026: kitting_done снесён слиянием в arrival);
//   - EAV-статусы с датами: customer_sent → shipped, customer_accepted → accepted,
//     scrap_confirmed/rework_sent/rejected → scrap_branch.
// Не переносятся осознанно (счётчики): repair_started и storage_received (нет
// этапа), repaired (происхождение неоднозначно — обкаточные строки уже покрывают),
// факты без даты (этап без даты в порядке не участвует).
//
// Дедуп: (двигатель, этап, московский день). Пропускаются уже имеющиеся stage-строки
// и повторы внутри пачки. Id детерминирован от (двигатель, этап, день) — повторный
// прогон ничего не дублирует. Пишет через writeSyncChanges (ledger + seq + таблицы),
// пачками по 500.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:backfill            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:backfill -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const SHEET_TO_STAGE: Record<string, RepairStageCode> = {
  ukladka: 'ukladka',
  sborka: 'sborka',
  obkatka: 'obkatka',
};

const STATUS_TO_STAGE: Array<{ flag: string; date: string; stage: RepairStageCode }> = [
  { flag: 'status_customer_sent', date: 'status_customer_sent_date', stage: 'shipped' },
  { flag: 'status_customer_accepted', date: 'status_customer_accepted_date', stage: 'accepted' },
  { flag: 'status_scrap_confirmed', date: 'status_scrap_confirmed_date', stage: 'scrap_branch' },
  { flag: 'status_rework_sent', date: 'status_rework_sent_date', stage: 'scrap_branch' },
  { flag: 'status_rejected', date: 'status_rejected_date', stage: 'scrap_branch' },
];

const SKIPPED_STATUS_FLAGS = ['status_repair_started', 'status_repaired', 'status_storage_received'];

const templateName = (code: RepairStageCode): string =>
  DEFAULT_REPAIR_STAGE_TEMPLATES.find((t) => t.code === code)?.name ?? code;

/** Детерминированный uuid строки переноса: повтор не плодит. */
function stageRowId(engineId: string, code: string, dayKey: string): string {
  const h = createHash('sha1').update(`repair-stage-backfill\u0000${engineId}\u0000${code}\u0000${dayKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseJsonValue(valueJson: unknown): unknown {
  if (typeof valueJson !== 'string') return valueJson;
  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

type Candidate = { engineId: string; code: RepairStageCode; at: number; pass: number; source: string };

function parseArgs(argv: string[]): { apply: boolean; engine: string | null } {
  const out = { apply: false, engine: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--engine') out.engine = String(argv[++i] ?? '').trim() || null;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`stages:backfill — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const counts: Record<string, number> = {
    'sheet→stage': 0,
    'arrival_date→arrival': 0,
    'defect_date→disassembly_defect': 0,
    'kitting→arrival': 0,
    'entity→card_created': 0,
    'status→stage': 0,
    'skipped-unknown-node': 0,
    'skipped-no-date': 0,
    'skipped-unmapped-status': 0,
    'skipped-duplicate-day': 0,
    insert: 0,
  };
  const candidates: Candidate[] = [];
  const engineFilter = args.engine ? ` AND engine_entity_id = $1` : '';
  const params: unknown[] = args.engine ? [args.engine] : [];

  // 1. Строки этапов работ с известными узлами.
  const sheets = await pool.query(
    `SELECT id, engine_entity_id, performed_at, meta_json FROM operations
      WHERE operation_type = 'repair_history_entry' AND deleted_at IS NULL${engineFilter}`,
    params,
  );
  for (const r of sheets.rows as Array<Record<string, unknown>>) {
    const meta = parseRepairHistoryMeta(typeof r.meta_json === 'string' ? r.meta_json : null);
    const typeCode = meta?.sheet?.typeCode?.toLowerCase() ?? '';
    if (!meta?.sheet || !typeCode) continue;
    const stage = SHEET_TO_STAGE[typeCode];
    if (!stage) {
      counts['skipped-unknown-node'] = (counts['skipped-unknown-node'] ?? 0) + 1;
      continue;
    }
    const at = num(meta.at ?? r.performed_at);
    if (at === null) {
      counts['skipped-no-date'] = (counts['skipped-no-date'] ?? 0) + 1;
      continue;
    }
    candidates.push({
      engineId: String(r.engine_entity_id),
      code: stage,
      at,
      pass: meta.repeat?.pass ?? 1,
      source: 'sheet→stage',
    });
  }

  // 2–3. EAV-атрибуты дат и флаги статусов (только двигатели).
  const codes = [
    'arrival_date',
    'defect_date',
    ...STATUS_TO_STAGE.flatMap((m) => [m.flag, m.date]),
    ...SKIPPED_STATUS_FLAGS,
  ];
  const eav = await pool.query(
    `SELECT av.entity_id, ad.code, av.value_json FROM attribute_values av
       JOIN attribute_defs ad ON ad.id = av.attribute_def_id
       JOIN entities e ON e.id = av.entity_id
       JOIN entity_types et ON et.id = e.type_id
      WHERE et.code = 'engine' AND ad.code = ANY($1)
        AND av.deleted_at IS NULL AND e.deleted_at IS NULL${args.engine ? ' AND av.entity_id = $2' : ''}`,
    args.engine ? [codes, args.engine] : [codes],
  );
  const byEntity = new Map<string, Map<string, unknown>>();
  for (const r of eav.rows as Array<Record<string, unknown>>) {
    const id = String(r.entity_id);
    if (!byEntity.has(id)) byEntity.set(id, new Map());
    byEntity.get(id)!.set(String(r.code), parseJsonValue(r.value_json));
  }
  for (const [entityId, attrs] of byEntity) {
    const arrival = num(attrs.get('arrival_date'));
    if (arrival !== null) {
      candidates.push({ engineId: entityId, code: 'arrival', at: arrival, pass: 1, source: 'arrival_date→arrival' });
    }
    const defect = num(attrs.get('defect_date'));
    if (defect !== null) {
      candidates.push({ engineId: entityId, code: 'disassembly_defect', at: defect, pass: 1, source: 'defect_date→disassembly_defect' });
    }
    for (const m of STATUS_TO_STAGE) {
      if (isEavFlagSet(attrs.get(m.flag))) {
        const at = num(attrs.get(m.date));
        if (at === null) {
          counts['skipped-no-date'] = (counts['skipped-no-date'] ?? 0) + 1;
          continue;
        }
        candidates.push({ engineId: entityId, code: m.stage, at, pass: 1, source: 'status→stage' });
      }
    }
    for (const flag of SKIPPED_STATUS_FLAGS) {
      if (isEavFlagSet(attrs.get(flag))) counts['skipped-unmapped-status'] = (counts['skipped-unmapped-status'] ?? 0) + 1;
    }
  }

  // 2b. Создание карточки (таблица 05.10.2026, этап №1): живые двигатели без
  // строки card_created получают её датой создания сущности. Дедуп — через
  // taken (существующие stage-строки), как у остальных источников: повторный
  // прогон и двигатели, заведённые уже с отметкой, ничего не добавляют.
  const createdRows = await pool.query(
    `SELECT e.id, e.created_at FROM entities e
       JOIN entity_types t ON t.id = e.type_id
      WHERE t.code = 'engine' AND e.deleted_at IS NULL${
        args.engine ? ' AND e.id = $1' : ''
      }`,
    args.engine ? [args.engine] : [],
  );
  for (const r of createdRows.rows as Array<{ id: unknown; created_at: unknown }>) {
    const at = num(r.created_at);
    if (at === null) {
      counts['skipped-no-date'] = (counts['skipped-no-date'] ?? 0) + 1;
      continue;
    }
    candidates.push({ engineId: String(r.id), code: 'card_created', at, pass: 1, source: 'entity→card_created' });
  }

  // 4. Даты осмотра из листов (все листы, дедуп по дню схлопнет повторы).
  const lists = await pool.query(
    `SELECT engine_entity_id, meta_json FROM operations
      WHERE operation_type = 'engine_inventory' AND deleted_at IS NULL${engineFilter}`,
    params,
  );
  for (const r of lists.rows as Array<Record<string, unknown>>) {
    let payload: unknown = null;
    try {
      payload = typeof r.meta_json === 'string' ? JSON.parse(r.meta_json) : null;
    } catch {
      payload = null;
    }
    const answers = (payload as Record<string, unknown> | null)?.answers;
    const field = (answers as Record<string, unknown> | undefined)?.completeness_inspection_date as
      | { kind?: unknown; value?: unknown }
      | undefined;
    const at = field?.kind === 'date' && typeof field.value === 'number' ? num(field.value) : null;
    if (at === null) continue;
    candidates.push({ engineId: String(r.engine_entity_id), code: 'arrival', at, pass: 1, source: 'kitting→arrival' });
  }

  // Уже имеющиеся stage-строки — дедуп-опора.
  const taken = new Set<string>();
  const existing = await pool.query(
    `SELECT engine_entity_id, meta_json FROM operations
      WHERE operation_type = 'repair_history_entry' AND deleted_at IS NULL
        AND meta_json LIKE '%"stage":%'${engineFilter}`,
    params,
  );
  for (const r of existing.rows as Array<Record<string, unknown>>) {
    const meta = parseRepairHistoryMeta(typeof r.meta_json === 'string' ? r.meta_json : null);
    if (!meta?.stage) continue;
    const at = num(meta.at);
    if (at === null) continue;
    taken.add(`${r.engine_entity_id}|${meta.stage.code}|${moscowDayKey(at)}`);
  }

  const ts = Date.now();
  const actor: SyncWriteActor = { id: 'server', username: 'stages:backfill', role: 'system' };
  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, actor, { allowSyncConflicts: true });
    pending = [];
  };
  for (const c of candidates.sort((a, b) => a.at - b.at)) {
    const dayKey = moscowDayKey(c.at);
    const key = `${c.engineId}|${c.code}|${dayKey}`;
    if (taken.has(key)) {
      counts['skipped-duplicate-day'] = (counts['skipped-duplicate-day'] ?? 0) + 1;
      continue;
    }
    taken.add(key);
    const name = templateName(c.code);
    const meta = buildRepairHistoryMeta({
      action: name,
      auto: true,
      at: c.at,
      entryType: 'stage',
      stage: { code: c.code, name },
      ...(c.pass >= 2 ? { repeat: { pass: Math.min(c.pass, 99) } } : {}),
    });
    pending.push({
      type: 'upsert',
      table: SyncTableName.Operations,
      row: {
        id: stageRowId(c.engineId, c.code, dayKey),
        engine_entity_id: c.engineId,
        operation_type: 'repair_history_entry',
        status: 'done',
        note: `Этап: ${name}`,
        performed_at: ts,
        performed_by: actor.username,
        meta_json: JSON.stringify(meta),
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_status: 'synced',
      },
      row_id: stageRowId(c.engineId, c.code, dayKey),
    });
    counts[c.source] = (counts[c.source] ?? 0) + 1;
    counts.insert = (counts.insert ?? 0) + 1;
    if (pending.length >= 500) await flush();
  }
  await flush();

  console.log(
    Object.entries(counts)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n'),
  );
  if (!args.apply) console.log('\nБез --apply запись не выполняется.');
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
