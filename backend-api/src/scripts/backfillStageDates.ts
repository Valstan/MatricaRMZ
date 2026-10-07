import 'dotenv/config';

import { createHash } from 'node:crypto';

import {
  buildRepairHistoryMeta,
  moscowDayKey,
  SyncTableName,
  type RepairStageCode,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';
import { pr3CanonicalName } from './pr3StageNames.js';

// stages:backfill-dates — недостающие этапы «Отгрузка»/«Приёмка заказчиком» из
// дат карточки (пп. 8–9 таблицы 05.10.2026; дефект найден 07.10.2026).
//
// Почему появились пропуски: даты «Основного» писал РЕНДЕРЕР через
// `workSheets:stages:save`, а он гейтится поимённым `work_sheets.edit` — у ролей
// без него (инженер, админ) этап молча не создавался, дата при этом сохранялась.
// Замер 07.10: 78 движков с датой отгрузки без этапа (61 живой, в т.ч. свежие
// 02–06.10), 17 с датой приёмки (1 живой), 3 утильных. Код исправлен в PR
// (запись переехала в main), скрипт закрывает накопленное.
//
// Правила:
//   - источник — дата СТРОГОЙ карточки (`erp_engine_cards`), та же, что правит
//     оператор; EAV `attribute_values` — фолбэк, если строка реплики не заведена;
//   - только ЖИВЫЕ двигатели: у удалённых этапы не нужны никому;
//   - дедуп по (двигатель, код, московский день) и по факту ЖИВОЙ строки кода:
//     есть строка (любой даты) — пропуск, дату существующей правит «История ремонта»;
//   - идемпотентно: id строки детерминирован от (двигатель, код, день), повтор
//     не плодит; мягко ничего не удаляется;
//   - пишет через writeSyncChanges (журнал + seq) — парк видит обычным pull.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:backfill-dates            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:backfill-dates -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const ACTOR: SyncWriteActor = { id: 'server', username: 'stages:backfill-dates', role: 'system' };
const MS_PER_DAY = 86_400_000;

/** Дата в будущем (с запасом в сутки) — не факт ремонта, пропускаем. */
export function isFutureDate(at: number, nowMs: number = Date.now()): boolean {
  return at - nowMs > MS_PER_DAY;
}

/** Детерминированный uuid строки переноса: повтор не плодит. */
export function stageRowId(engineId: string, code: string, dayKey: string): string {
  const h = createHash('sha1').update(`repair-stage-backfill-dates\u0000${engineId}\u0000${code}\u0000${dayKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Дата из EAV `value_json`: число, строка-число или `{kind:"date", value}`. */
export function parseEavDate(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  const s = String(raw ?? '').trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as { value?: unknown };
      const n = Number(obj?.value);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

type Candidate = { engineId: string; code: RepairStageCode; at: number; source: string };

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
  console.log(`stages:backfill-dates — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const engineFilter = args.engine ? ' AND e.id = $1' : '';
  const params: unknown[] = args.engine ? [args.engine] : [];

  // Живые двигатели + их даты из строгой карточки (канон) и EAV (фолбэк).
  const engines = (await pool.query(
    `SELECT e.id::text AS id,
            c.status_customer_sent_date   AS sent,
            c.status_customer_accepted_date AS accepted,
            (SELECT av.value_json FROM attribute_values av
               JOIN attribute_defs ad ON ad.id = av.attribute_def_id
              WHERE av.entity_id = e.id AND av.deleted_at IS NULL
                AND ad.code = 'status_customer_sent_date' LIMIT 1) AS sent_eav,
            (SELECT av.value_json FROM attribute_values av
               JOIN attribute_defs ad ON ad.id = av.attribute_def_id
              WHERE av.entity_id = e.id AND av.deleted_at IS NULL
                AND ad.code = 'status_customer_accepted_date' LIMIT 1) AS accepted_eav
       FROM entities e
       JOIN entity_types et ON et.id = e.type_id AND et.code = 'engine'
       LEFT JOIN erp_engine_cards c ON c.id = e.id
      WHERE e.deleted_at IS NULL${engineFilter}`,
    params,
  )) as { rows: Array<Record<string, unknown>> };

  // Живые stage-строки: коды по двигателям — дедуп «есть строка кода».
  const live = (await pool.query(
    `SELECT DISTINCT o.engine_entity_id::text AS eng, o.meta_json::jsonb->'stage'->>'code' AS code
       FROM operations o
      WHERE o.operation_type = 'repair_history_entry' AND o.deleted_at IS NULL
        AND o.meta_json::jsonb->'stage' IS NOT NULL`,
  )) as { rows: Array<{ eng: string; code: string }> };
  const hasCode = new Set(live.rows.map((r) => `${r.eng}|${r.code}`));

  const candidates: Candidate[] = [];
  const counts: Record<string, number> = {
    'sent→shipped': 0,
    'accepted→accepted': 0,
    'skipped-has-stage': 0,
    'skipped-no-date': 0,
    'skipped-future-date': 0,
    'skipped-duplicate-day': 0,
    insert: 0,
  };

  for (const r of engines.rows) {
    const engineId = String(r.id);
    const sources: Array<[RepairStageCode, string, unknown]> = [
      ['shipped', 'sent→shipped', r.sent ?? r.sent_eav],
      ['accepted', 'accepted→accepted', r.accepted ?? r.accepted_eav],
    ];
    for (const [code, source, raw] of sources) {
      if (hasCode.has(`${engineId}|${code}`)) {
        counts['skipped-has-stage'] = (counts['skipped-has-stage'] ?? 0) + 1;
        continue;
      }
      const at = parseEavDate(raw);
      if (at === null) {
        counts['skipped-no-date'] = (counts['skipped-no-date'] ?? 0) + 1;
        continue;
      }
      if (isFutureDate(at)) {
        counts['skipped-future-date'] = (counts['skipped-future-date'] ?? 0) + 1;
        continue;
      }
      candidates.push({ engineId, code, at, source });
    }
  }

  const ts = Date.now();
  let pending: SyncWriteInput[] = [];
  const taken = new Set<string>();
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, ACTOR, { allowSyncConflicts: true });
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
    const name = pr3CanonicalName(c.code) ?? c.code;
    console.log(`  ${c.source} ${c.engineId} ${dayKey} → ${name}`);
    const meta = buildRepairHistoryMeta({
      action: name,
      auto: true,
      at: c.at,
      entryType: 'stage',
      stage: { code: c.code, name },
    });
    const id = stageRowId(c.engineId, c.code, dayKey);
    pending.push({
      type: 'upsert',
      table: SyncTableName.Operations,
      row: {
        id,
        engine_entity_id: c.engineId,
        operation_type: 'repair_history_entry',
        status: 'done',
        note: `Этап: ${name}`,
        performed_at: ts,
        performed_by: ACTOR.username,
        meta_json: JSON.stringify(meta),
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_status: 'synced',
      },
      row_id: id,
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

const invokedDirectly = typeof process.argv[1] === 'string' && process.argv[1].endsWith('.ts');
if (invokedDirectly) {
  main()
    .catch((e: unknown) => {
      console.error(String((e as Error)?.message ?? e));
      process.exitCode = 2;
    })
    .finally(() => void pool.end().catch(() => {}));
}
