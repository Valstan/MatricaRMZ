import 'dotenv/config';

import { pool } from '../database/db.js';

// engine-reclamations:backfill — перенос рекламаций из EAV-атрибутов карточки в
// очередь заездов `erp_engine_reclamations` (миграция 0125).
//
// ЗАЧЕМ. До 10.11.2026 рекламация жила одним набором EAV-атрибутов карточки
// (`reclamation_flag`, `reclamation_accepted_date`, `reclamation_shipped_date`, …),
// то есть рекламация могла быть только одна. Теперь их очередь (1-я, 2-я, 3-я …),
// и очередь — источник правды. Старые данные лежат в EAV и в новую таблицу не
// попали: без переноса оператор увидит пустую очередь у двигателей, которые
// рекламацию уже приняли.
//
// ЧТО ДЕЛАЕТ. Для каждой карточки с `reclamation_flag` и без строк в очереди
// создаёт рекламацию №1 с теми же датами и описанием дефекта.
//
// ИДЕНТИЧНОСТЬ. Скрипт идемпотентен: у двигателя с уже заведённой очередью
// ничего не трогает (проверка по таблице очереди). Повторный прогон безопасен.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api engine-reclamations:backfill            # dry-run
//   corepack pnpm -F @matricarmz/backend-api engine-reclamations:backfill -- --apply
//
// Код возврата: 0 — ок; 2 — отказ/ошибка.

const CODES = [
  'reclamation_flag',
  'reclamation_accepted_date',
  'reclamation_shipped_date',
  'reclamation_customer_reason',
  'reclamation_actual_defect',
  'reclamation_defect_nature',
  'reclamation_act_number',
  'reclamation_verdict_date',
  'reclamation_comment',
] as const;

function parseArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const a of argv) {
    if (a === '--apply') apply = true;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return { apply };
}

function parseValue(raw: string | null): unknown {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  return t ? t : null;
}

function asFlag(value: unknown): boolean {
  if (value === true) return true;
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'да';
}

type Row = { engine_id: string; code: string; value_json: string | null };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`engine-reclamations:backfill — ${args.apply ? 'РЕЖИМ ЗАПИСИ' : 'dry-run, ничего не меняется'}`);

  const res = await pool.query<Row>(
    `SELECT av.entity_id::text AS engine_id, ad.code, av.value_json
       FROM attribute_values av
       JOIN attribute_defs ad ON ad.id = av.attribute_def_id
       JOIN entities e ON e.id = av.entity_id
      WHERE ad.code = ANY($1::text[])
        AND av.deleted_at IS NULL
        AND e.entity_type_id = (SELECT id FROM entity_types WHERE code = 'engine' LIMIT 1)`,
    [CODES as unknown as string[]],
  );

  const byEngine = new Map<string, Map<string, unknown>>();
  for (const row of res.rows) {
    const map = byEngine.get(row.engine_id) ?? new Map<string, unknown>();
    map.set(row.code, parseValue(row.value_json));
    byEngine.set(row.engine_id, map);
  }

  const flagged = [...byEngine.entries()].filter(([, attrs]) => asFlag(attrs.get('reclamation_flag')));
  console.log(`  карточек с рекламацией (EAV): ${flagged.length}`);

  const existing = await pool.query<{ engine_id: string }>(
    `SELECT engine_id::text AS engine_id FROM erp_engine_reclamations WHERE deleted_at IS NULL GROUP BY engine_id`,
  );
  const already = new Set(existing.rows.map((r) => r.engine_id));
  const toCreate = flagged.filter(([engineId]) => !already.has(engineId));
  console.log(`  уже есть в очереди: ${already.size}; к переносу: ${toCreate.length}`);

  let created = 0;
  for (const [engineId, attrs] of toCreate) {
    const acceptedAt = asMs(attrs.get('reclamation_accepted_date'));
    const shippedAt = asMs(attrs.get('reclamation_shipped_date'));
    const actDate = asMs(attrs.get('reclamation_verdict_date'));
    const customerReason = asText(attrs.get('reclamation_customer_reason'));
    const actualDefect = asText(attrs.get('reclamation_actual_defect'));
    const defectNature = asText(attrs.get('reclamation_defect_nature'));
    const actNumber = asText(attrs.get('reclamation_act_number'));
    const comment = asText(attrs.get('reclamation_comment'));
    if (!acceptedAt && !shippedAt && !customerReason && !actualDefect && !defectNature && !actNumber && !comment) {
      continue;
    }
    const now = Date.now();
    if (args.apply) {
      await pool.query(
        `INSERT INTO erp_engine_reclamations
           (id, engine_id, queue_no, accepted_at, shipped_at, customer_reason, actual_defect, defect_nature,
            act_number, act_date, comment, created_at, updated_at, sync_status)
         VALUES (gen_random_uuid(), $1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 'pending')`,
        [engineId, acceptedAt, shippedAt, customerReason, actualDefect, defectNature, actNumber, actDate, comment, now],
      );
    }
    created += 1;
  }

  console.log(`  ${args.apply ? 'перенесено' : 'к переносу'} рекламаций: ${created}`);
  if (!args.apply) console.log('  (повторить с --apply, чтобы записать)');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Ошибка переноса рекламаций:', e);
    process.exit(2);
  });
