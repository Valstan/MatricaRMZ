/**
 * One-off фикс номеров нарядов, потерянных старым багом «№ новый навсегда» (закрыт PR #283,
 * релиз v2026.719.2040).
 *
 * Что случилось: устаревший recovery-черновик карточки (снимок сделан ДО материализации, поэтому
 * нёс workOrderNumber: 0) при сохранении затирал присвоенный номер. Оригинальные номера подняты из
 * `audit_log` (action='work_order.create', payload несёт исходный workOrderNumber) — по проду
 * 2026-07-22:
 *   df301a5f… создан №85, обнулён 14.07 → сейчас 0
 *   2314d989… создан №86, обнулён 14.07 → сегодня самолечение выдало ему свежий 103
 *   9e03057f… был №94 — наряд удалён, не чиним
 *
 * Запись идёт штатным sync-путём (writeSyncChanges с allowSyncConflicts) — иначе правка не доедет
 * клиентам инкрементальным pull'ом. Целевой номер проверяется на занятость перед записью.
 *
 * Dry-run по умолчанию. Флаги:
 *   --apply                 — выполнить запись
 *   --actor=<username>      — актор (по умолчанию: первый superadmin)
 *   --set <uuid>=<номер>    — переопределить/дополнить список правок (можно несколько раз)
 *
 *   pnpm -F @matricarmz/backend-api fix:zero-wo-numbers-20260722          # dry-run
 *   pnpm -F @matricarmz/backend-api fix:zero-wo-numbers-20260722 --apply
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { SyncTableName } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;

/** Номера подняты из audit_log прода (work_order.create), см. шапку. */
const DEFAULT_FIXES: Array<{ id: string; number: number }> = [
  { id: 'df301a5f-d856-43d2-9afe-c3cedabc0bbc', number: 85 },
  { id: '2314d989-d6f0-47e3-8240-51ddd5029f69', number: 86 },
];

type Actor = { id: string; username: string; role: string };

function log(...args: unknown[]) {
  console.log(...args);
}

function parseFixes(): Array<{ id: string; number: number }> {
  const explicit: Array<{ id: string; number: number }> = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== '--set') continue;
    const raw = String(process.argv[i + 1] ?? '');
    const [id, num] = raw.split('=');
    const parsed = Math.trunc(Number(num));
    if (!id || !Number.isInteger(parsed) || parsed <= 0) throw new Error(`bad --set argument: ${raw}`);
    explicit.push({ id, number: parsed });
  }
  return explicit.length > 0 ? explicit : DEFAULT_FIXES;
}

async function resolveActor(): Promise<Actor> {
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join entity_types t on t.id = e.type_id and t.code = 'employee'
       join attribute_defs sd on sd.entity_type_id = t.id and sd.code = 'system_role' and sd.deleted_at is null
       join attribute_values sr on sr.entity_id = e.id and sr.attribute_def_id = sd.id and sr.deleted_at is null
            and trim(both '"' from sr.value_json) = 'superadmin'
       join attribute_defs ld on ld.entity_type_id = t.id and ld.code = 'login' and ld.deleted_at is null
       left join attribute_values lg on lg.entity_id = e.id and lg.attribute_def_id = ld.id and lg.deleted_at is null
      where e.deleted_at is null
      order by username`,
  );
  if (r.rows.length === 0) throw new Error('no superadmin employee found — pass --actor=<username>');
  const pick = ACTOR_OVERRIDE
    ? r.rows.find((x: { username: string }) => String(x.username) === ACTOR_OVERRIDE)
    : r.rows[0];
  if (!pick) throw new Error(`--actor=${ACTOR_OVERRIDE} is not a superadmin`);
  return { id: String(pick.id), username: String(pick.username), role: 'superadmin' };
}

function readNumber(metaJson: unknown): number {
  try {
    const parsed = JSON.parse(String(metaJson ?? '{}')) as { workOrderNumber?: unknown };
    const n = Math.trunc(Number(parsed?.workOrderNumber ?? 0));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function main() {
  const fixes = parseFixes();
  const actor = await resolveActor();
  log(`актор: ${actor.username} (${actor.id})`);

  const zero = await pool.query(
    `select id::text as id, to_timestamp(created_at/1000)::date as created, performed_by
       from operations
      where operation_type='work_order' and deleted_at is null
        and coalesce(nullif(meta_json::jsonb->>'workOrderNumber','')::numeric, 0) <= 0
      order by created_at`,
  );
  log(
    `нарядов с нулевым номером сейчас: ${zero.rows.length}` +
      (zero.rows.length > 0
        ? ` — ${zero.rows.map((r: any) => `${r.id} (${r.created}, ${r.performed_by})`).join('; ')}`
        : ''),
  );

  let applied = 0;
  for (const fix of fixes) {
    const r = await pool.query(
      `select id::text as id, engine_entity_id::text as engine_entity_id, operation_type, status, note,
              performed_at, performed_by, meta_json, created_at, updated_at
         from operations
        where id = $1 and operation_type = 'work_order' and deleted_at is null
        limit 1`,
      [fix.id],
    );
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      log(`✗ ${fix.id}: наряд не найден (или удалён) — пропуск`);
      continue;
    }
    const current = readNumber(row.meta_json);
    if (current === fix.number) {
      log(`= ${fix.id}: уже №${fix.number} — пропуск`);
      continue;
    }

    const taken = await pool.query(
      `select id::text as id from operations
        where operation_type='work_order' and deleted_at is null and id <> $1
          and coalesce(nullif(meta_json::jsonb->>'workOrderNumber','')::numeric, 0) = $2
        limit 1`,
      [fix.id, fix.number],
    );
    if (taken.rows[0]) {
      log(`✗ ${fix.id}: №${fix.number} уже занят нарядом ${taken.rows[0].id} — пропуск`);
      continue;
    }

    log(`→ ${fix.id}: №${current || '—'} → №${fix.number}${APPLY ? '' : ' (dry-run)'}`);
    if (!APPLY) continue;

    const payload = JSON.parse(String(row.meta_json ?? '{}')) as Record<string, unknown>;
    const ts = Date.now();
    const auditId = randomUUID();
    const nextMeta = JSON.stringify({
      ...payload,
      workOrderNumber: fix.number,
      auditTrail: [
        ...(Array.isArray(payload.auditTrail) ? payload.auditTrail : []),
        // note в формате «№N» — маркер осознанной смены для серверного backstop'а (workOrderNumberGuard).
        { at: ts, by: actor.username, action: 'number_change', note: `№${fix.number} (восстановлен, был ${current})` },
      ],
    });
    // Обе строки идут одним штатным sync-путём: прямой INSERT в audit_log оставил бы
    // last_server_seq = NULL, и запись не доехала бы клиентам инкрементальным pull'ом (GOTCHAS M6).
    const res = await writeSyncChanges(
      [
        {
          type: 'upsert',
          table: SyncTableName.Operations,
          row_id: fix.id,
          row: {
            id: fix.id,
            engine_entity_id: String(row.engine_entity_id),
            operation_type: String(row.operation_type),
            status: String(row.status),
            note: `Наряд №${fix.number}`,
            performed_at: row.performed_at == null ? null : Number(row.performed_at),
            performed_by: row.performed_by ?? null,
            meta_json: nextMeta,
            created_at: Number(row.created_at),
            updated_at: ts,
            deleted_at: null,
          },
        },
        {
          type: 'upsert',
          table: SyncTableName.AuditLog,
          row_id: auditId,
          row: {
            id: auditId,
            actor: actor.username,
            action: 'work_order.number_change',
            entity_id: fix.id,
            table_name: SyncTableName.Operations,
            payload_json: JSON.stringify({ operationId: fix.id, from: current, to: fix.number }),
            created_at: ts,
            updated_at: ts,
            deleted_at: null,
          },
        },
      ],
      actor,
      { allowSyncConflicts: true },
    );
    if (res.skipped.length > 0) {
      log(`   ✗ ${fix.id}: skipped ${JSON.stringify(res.skipped)}`);
      continue;
    }
    applied += 1;
  }

  log(APPLY ? `DONE (apply): исправлено ${applied}/${fixes.length}` : 'DONE (dry-run; запусти с --apply для записи)');
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
