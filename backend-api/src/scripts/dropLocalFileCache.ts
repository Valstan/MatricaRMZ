/**
 * Разовый сброс кэша вложений на боксе: снять ВСЕ локальные копии, оставив только Я.Диск.
 *
 * Зачем. Кэш держит копию три дня после последнего обращения, и после «фотографического» дня
 * (14.09 — 350 снимков, 1.5 ГБ) он занимает четверть диска, хотя открывали эти снимки один раз.
 * Решение владельца: сбросить разом и дать кэшу набраться заново — то, к чему действительно
 * вернутся, само ляжет обратно при первом же открытии.
 *
 * Безопасность не ослаблена ни на шаг: снятие каждой копии идёт через `evictOne`, то есть
 *   * байты на боксе обязаны сойтись с sha256 строки,
 *   * Я.Диск обязан подтвердить свою копию размером и дайджестом,
 *   * строка без пути на Яндексе не трогается вовсе — там копия на боксе единственная.
 * Не подтвердилось — копия остаётся лежать, и это видно в отчёте.
 *
 * Dry-run по умолчанию (показывает, сколько и чего снимется). Флаги:
 *   --apply       — выполнить
 *
 *   pnpm -F @matricarmz/backend-api files:drop-cache
 *   pnpm -F @matricarmz/backend-api files:drop-cache --apply
 */
import 'dotenv/config';

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { fileAssets } from '../database/schema.js';
import { sweepExpiredCache } from '../services/fileCache.js';

const APPLY = process.argv.includes('--apply');
const mb = (n: number) => (n / 1048576).toFixed(1);

async function main() {
  const [stats] = await db
    .select({
      cached: sql<number>`count(*) filter (where ${fileAssets.localRelPath} is not null and ${fileAssets.storageKind} = 'yandex')`,
      cachedBytes: sql<number>`coalesce(sum(${fileAssets.size}) filter (where ${fileAssets.localRelPath} is not null and ${fileAssets.storageKind} = 'yandex'), 0)`,
      localOnly: sql<number>`count(*) filter (where ${fileAssets.storageKind} <> 'yandex')`,
      localOnlyBytes: sql<number>`coalesce(sum(${fileAssets.size}) filter (where ${fileAssets.storageKind} <> 'yandex'), 0)`,
    })
    .from(fileAssets)
    .where(isNull(fileAssets.deletedAt));

  console.log(APPLY ? 'режим: СНЯТИЕ (--apply)' : 'режим: сухой прогон (ничего не снимается)');
  console.log(`кэш-копий на боксе: ${Number(stats?.cached ?? 0)} на ${mb(Number(stats?.cachedBytes ?? 0))} МБ`);
  console.log(
    `не на Яндексе (их копия на боксе ЕДИНСТВЕННАЯ, не трогаем): ${Number(stats?.localOnly ?? 0)} на ${mb(Number(stats?.localOnlyBytes ?? 0))} МБ`,
  );

  if (!APPLY) {
    console.log('\nсухой прогон — ничего не снято. Повторите с --apply.');
    await pool.end();
    return;
  }

  // Выселяем пачками, пока есть что: `sweepExpiredCache` берёт ограниченный батч за раз.
  const total = { evicted: 0, bytes: 0, gone: 0, kept: 0 };
  for (let pass = 1; pass <= 200; pass += 1) {
    const r = await sweepExpiredCache(Date.now(), { all: true, batch: 200 });
    total.evicted += r.evicted;
    total.bytes += r.bytes;
    total.gone += r.gone;
    total.kept += r.kept;
    if (r.evicted + r.gone + r.kept === 0) break;
    console.log(`  проход ${pass}: снято ${r.evicted}, освобождено ${mb(r.bytes)} МБ, оставлено ${r.kept}`);
    // Оставленные не исчезнут на следующем проходе и зациклили бы нас: выходим, когда
    // снимать больше нечего, а всё оставшееся — это отказы, и они уже посчитаны.
    if (r.evicted + r.gone === 0) break;
  }

  const [left] = await db
    .select({ n: sql<number>`count(*)` })
    .from(fileAssets)
    .where(and(isNull(fileAssets.deletedAt), isNotNull(fileAssets.localRelPath), eq(fileAssets.storageKind, 'yandex')));

  console.log('');
  console.log(`снято копий: ${total.evicted}, освобождено ${mb(total.bytes)} МБ`);
  if (total.gone) console.log(`строк без файла на диске (ссылка снята): ${total.gone}`);
  if (total.kept) console.log(`ОСТАВЛЕНО (Я.Диск не подтвердил или байты разошлись): ${total.kept} — см. предупреждения в логе`);
  console.log(`кэш-копий осталось: ${Number(left?.n ?? 0)}`);
  await pool.end();
}

/** Импорт ради функции не должен запускать сам сброс. */
function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return realpathSync(resolve(argv)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
}
