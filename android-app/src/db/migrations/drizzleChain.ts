// Async-раннер drizzle-цепочки клиента (electron-app/drizzle/0000–00NN).
// SQL бандлится строками через import.meta.glob(?raw) — на Android нет файловой
// системы с папкой миграций. Семантика повторяет drizzle-orm/sqlite-core
// dialect.migrate() (v0.45.2): та же таблица "__drizzle_migrations", тот же
// критерий «created_at последней записи < entry.when», тот же sha256 всего файла.
//
// Сознательное отличие: НЕ оборачиваем прогон в BEGIN/COMMIT. В 0007 живёт
// `PRAGMA foreign_keys=OFF/ON` — внутри транзакции этот PRAGMA тихий no-op
// (план, «Ключевые решения» §3). Цепочка катится только на свежую БД при
// установке, атомарность прогона здесь не критична: полу-применённая цепочка
// чинится пересозданием БД (self-heal, как на десктопе).

import journal from '../../../../electron-app/drizzle/meta/_journal.json';

import type { AsyncSqlite } from '../asyncSqlite.js';

const rawByPath = import.meta.glob('../../../../electron-app/drizzle/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

type JournalEntry = { idx: number; when: number; tag: string };

function migrationSql(tag: string): string {
  const key = Object.keys(rawByPath).find((p) => p.endsWith(`/${tag}.sql`));
  const sql = key ? rawByPath[key] : undefined;
  if (!sql) throw new Error(`drizzle chain: не найден SQL миграции ${tag}`);
  return sql;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function applyDrizzleChain(sqlite: AsyncSqlite): Promise<{ applied: string[] }> {
  // DDL дословно как у drizzle (SERIAL в SQLite — просто имя типа, NUMERIC-аффинность).
  await sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (\n\t\t\t\tid SERIAL PRIMARY KEY,\n\t\t\t\thash text NOT NULL,\n\t\t\t\tcreated_at numeric\n\t\t\t)`,
  );
  const last = await sqlite.get<{ created_at: number | string }>(
    `SELECT id, hash, created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`,
  );
  const lastMillis = last ? Number(last.created_at) : null;

  const applied: string[] = [];
  const entries = (journal as { entries: JournalEntry[] }).entries;
  for (const entry of entries) {
    if (lastMillis !== null && lastMillis >= entry.when) continue;
    const query = migrationSql(entry.tag);
    for (const stmt of query.split('--> statement-breakpoint')) {
      const sql = stmt.trim();
      if (!sql) continue;
      await sqlite.exec(sql);
    }
    await sqlite.run(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`, [
      await sha256Hex(query),
      entry.when,
    ]);
    applied.push(entry.tag);
  }
  return { applied };
}
