import 'dotenv/config';

import { SyncTableName } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';

// engines:restore-first-save — возврат значений, потерянных багом «первый сейв
// новой карточки» (GOTCHAS M163, 20.10.2026).
//
// Симптом: оператор заполняет карточку, сохраняет — через полминуты она пуста.
// Клиентская база к этому моменту затёрта pull'ом, серверная строка — пустое
// зеркало, и единственная копия того, что человек вводил, — журнал: push пишет
// присланную строку в `ledger_tx_index` ДО применения, поэтому значения там есть,
// даже когда строка проиграла LWW и не попала в таблицу.
//
// Кого восстанавливаем (все условия сразу):
//   - карточка пуста по предметным полям (номер, марка, контрагент, договор,
//     дата прихода, внутренний номер) — то есть её не перезаполнили руками;
//   - последняя запись журнала по строке — от `system`: последнее слово сказало
//     зеркало, а не человек;
//   - у последней АВТОРСКОЙ (не `system`) записи поля непусты — иначе оператор
//     сам очистил карточку, и воскрешать нечего.
//
// Пишет через writeSyncChanges: журнал + seq, парк получает обычным pull.
// Идемпотентно: после записи карточка перестаёт быть пустой и в выборку не попадает.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api engines:restore-first-save            # dry-run
//   corepack pnpm -F @matricarmz/backend-api engines:restore-first-save -- --apply
//   … -- --samples 30
//
// Коды возврата: 0 — ок; 1 — были ошибки записи; 2 — отказ.

const ACTOR: SyncWriteActor = { id: 'server', username: 'engines:restore-first-save', role: 'system' };

const SUBJECT_FIELDS = [
  'engine_number',
  'engine_internal_number',
  'engine_internal_number_year',
  'engine_brand_id',
  'engine_brand',
  'arrival_date',
  'customer_id',
  'contract_id',
  'contract_section_number',
] as const;

function parseArgs(argv: string[]): { apply: boolean; samples: number } {
  const out = { apply: false, samples: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--samples') {
      const next = Number(argv[++i]);
      if (Number.isFinite(next) && next >= 0) out.samples = Math.trunc(next);
    } else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

type Candidate = {
  id: string;
  author: string;
  savedAt: number;
  payload: Record<string, unknown>;
};

function hasSubjectValues(payload: Record<string, unknown>): boolean {
  return SUBJECT_FIELDS.some((f) => payload[f] != null && String(payload[f]).trim() !== '');
}

function describe(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const num = payload['engine_number'];
  const internal = payload['engine_internal_number'];
  const year = payload['engine_internal_number_year'];
  const brand = payload['engine_brand'];
  const arrival = payload['arrival_date'];
  if (num) parts.push(`№ ${String(num)}`);
  if (internal) parts.push(`клеймо ${String(internal)}${year ? `/${String(year)}` : ''}`);
  if (brand) parts.push(`марка ${String(brand)}`);
  if (arrival) parts.push(`приход ${new Date(Number(arrival)).toISOString().slice(0, 10)}`);
  if (payload['customer_id']) parts.push('контрагент');
  if (payload['contract_id']) parts.push('договор');
  if (payload['engine_note']) parts.push('примечание');
  return parts.join(', ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`engines:restore-first-save — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const rows = (
    await pool.query(
      `WITH empty_cards AS (
         SELECT c.id
           FROM erp_engine_cards c
           JOIN entities e ON e.id = c.id AND e.deleted_at IS NULL
          WHERE c.deleted_at IS NULL
            AND c.engine_number IS NULL
            AND c.engine_internal_number IS NULL
            AND c.engine_brand_id IS NULL
            AND c.customer_id IS NULL
            AND c.contract_id IS NULL
            AND c.arrival_date IS NULL
       ), last_any AS (
         SELECT DISTINCT ON (ec.id) ec.id, l.actor_username
           FROM empty_cards ec
           JOIN ledger_tx_index l
             ON l.table_name = 'erp_engine_cards' AND l.row_id = ec.id AND l.op = 'upsert'
          ORDER BY ec.id, l.server_seq DESC
       ), last_user AS (
         SELECT DISTINCT ON (ec.id) ec.id, l.actor_username, l.created_at, l.payload_json::jsonb AS p
           FROM empty_cards ec
           JOIN ledger_tx_index l
             ON l.table_name = 'erp_engine_cards' AND l.row_id = ec.id AND l.op = 'upsert'
          WHERE l.actor_username <> 'system'
          ORDER BY ec.id, l.server_seq DESC
       )
       SELECT la.id::text AS id, la.actor_username AS last_author,
              lu.actor_username AS author, lu.created_at AS saved_at, lu.p AS payload
         FROM last_any la
         LEFT JOIN last_user lu USING (id)
        ORDER BY lu.created_at DESC NULLS LAST`,
    )
  ).rows as Array<Record<string, unknown>>;

  const candidates: Candidate[] = [];
  let notMirrorArtifact = 0;
  let noAuthoredSave = 0;
  let clearedByHand = 0;

  for (const r of rows) {
    if (r.last_author !== 'system') {
      notMirrorArtifact += 1;
      continue;
    }
    if (r.author == null) {
      noAuthoredSave += 1;
      continue;
    }
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    if (!hasSubjectValues(payload)) {
      clearedByHand += 1;
      continue;
    }
    candidates.push({
      id: String(r.id),
      author: String(r.author),
      savedAt: Number(r.saved_at),
      payload,
    });
  }

  console.log(
    `пустых карточек: ${rows.length}, к восстановлению: ${candidates.length}, ` +
      `очищено оператором: ${clearedByHand}, без авторского сейва: ${noAuthoredSave}, ` +
      `последнее слово не у зеркала: ${notMirrorArtifact}`,
  );

  for (const c of candidates.slice(0, args.samples)) {
    console.log(
      `  ${c.id} ← ${c.author} ${new Date(c.savedAt).toISOString().slice(0, 16).replace('T', ' ')} · ${describe(c.payload)}`,
    );
  }
  if (candidates.length > args.samples) console.log(`  … и ещё ${candidates.length - args.samples}`);

  let applied = 0;
  let failed = 0;
  let changed = 0;
  if (args.apply && candidates.length > 0) {
    const now = Date.now();
    for (const c of candidates) {
      // Карточку могли перезаполнить, пока шёл разбор: пишем только в всё ещё пустую.
      const stillEmpty = await pool.query(
        `SELECT 1 FROM erp_engine_cards
          WHERE id = $1 AND deleted_at IS NULL
            AND engine_number IS NULL AND engine_internal_number IS NULL
            AND engine_brand_id IS NULL AND customer_id IS NULL
            AND contract_id IS NULL AND arrival_date IS NULL`,
        [c.id],
      );
      if (stillEmpty.rowCount !== 1) {
        changed += 1;
        continue;
      }
      const input: SyncWriteInput = {
        type: 'upsert',
        table: SyncTableName.ErpEngineCards,
        row_id: c.id,
        row: {
          ...c.payload,
          updated_at: now,
          sync_status: 'pending',
          last_server_seq: null,
        },
      };
      try {
        await writeSyncChanges([input], ACTOR, { allowSyncConflicts: true });
        applied += 1;
      } catch (err) {
        failed += 1;
        console.error(`  ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`apply: восстановлено ${applied}, пропущено (уже не пусты) ${changed}, ошибок ${failed}`);
  } else if (!args.apply && candidates.length > 0) {
    console.log('Повторить с --apply для записи.');
  }

  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await pool.end().catch(() => undefined);
  process.exit(2);
});
