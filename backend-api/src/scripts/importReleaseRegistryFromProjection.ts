import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { pool } from '../database/db.js';

// ledger:import-release-registry — разовый перенос реестра выпусков из проекции снятой цепочки
// (state.json) в таблицу release_registry (план ledger-journal-in-pg, J2).
//
// Зачем отдельно от миграции 0091: она бэкфиллит реестр из журнала ledger_tx_index, а журнал
// знал только 112 старых выпусков (догон из цепочки для release_registry остановился на
// seq 503657); проекция держит все 412, открытым текстом. Читает файл, ничего в нём не меняет.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api ledger:import-release-registry -- --from ~/matricarmz-ledger/state.json
//   … -- --from <state.json> --apply
//
// Идемпотентен: существующие id пропускаются (ON CONFLICT DO NOTHING).

type Row = Record<string, unknown>;

function parseArgs(argv: string[]): { from: string; apply: boolean } {
  const out = { from: '', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--from') out.from = String(argv[++i] ?? '').trim();
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  if (!out.from) throw new Error('--from <state.json> обязателен');
  return out;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.from);
  console.log(`ledger:import-release-registry — ${args.apply ? 'ЗАПИСЬ' : 'dry-run'}; источник ${path}`);
  const state = JSON.parse(readFileSync(path, 'utf8')) as { tables?: Record<string, Record<string, Row>> };
  const rows = Object.values(state.tables?.release_registry ?? {}).filter((r) => String(r.version ?? '').trim() !== '');
  console.log(`  выпусков в проекции: ${rows.length}`);
  const encrypted = rows.filter((r) => typeof r.payload_json === 'string' && String(r.payload_json).startsWith('enc:')).length;
  if (encrypted > 0) throw new Error(`${encrypted} строк с шифрованным payload_json — keyring снят, такие строки перенести нельзя`);

  const existing = await pool.query<{ id: string }>('SELECT id FROM release_registry');
  const known = new Set(existing.rows.map((r) => String(r.id)));
  const missing = rows.filter((r) => !known.has(String(r.id)));
  const latest = [...rows].sort((a, b) => (num(b.created_at) ?? 0) - (num(a.created_at) ?? 0))[0];
  console.log(`  в таблице уже: ${known.size}; недостающих: ${missing.length}; самый свежий в проекции: ${String(latest?.version ?? '—')}`);
  if (!args.apply) {
    console.log('\nБез --apply запись не выполняется.');
    return;
  }
  let inserted = 0;
  for (const r of missing) {
    const createdAt = num(r.created_at) ?? Date.now();
    const res = await pool.query(
      `INSERT INTO release_registry (id, version, notes, sha256, file_name, size, payload_json, created_at, created_by_user_id, created_by_username, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [
        String(r.id),
        String(r.version),
        r.notes == null ? null : String(r.notes),
        r.sha256 == null ? null : String(r.sha256),
        r.file_name == null ? null : String(r.file_name),
        num(r.size),
        r.payload_json == null ? null : String(r.payload_json),
        createdAt,
        r.created_by_user_id == null ? null : String(r.created_by_user_id),
        r.created_by_username == null ? null : String(r.created_by_username),
        num(r.updated_at) ?? createdAt,
        num(r.deleted_at),
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  const after = await pool.query<{ version: string }>('SELECT version FROM release_registry WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1');
  console.log(`  вставлено: ${inserted}; последний выпуск в таблице теперь: ${after.rows[0]?.version ?? '—'}`);
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
