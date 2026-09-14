/**
 * Одноразовый проход: привести УЖЕ СОХРАНЁННЫЕ снимки к тому же печатному потолку, что и новые.
 *
 * Сжатие при загрузке (PR #902) ловит только новые файлы. В хранилище остались снимки, снятые до
 * него: замер прода 14.09 — 1389 jpg на 6.4 ГБ, в среднем 4.6 МБ при 19–24 Мп. Их вес бьёт дважды:
 * место на Я.Диске и — чувствительнее — кэш на боксе, куда каждое повторное открытие старого
 * снимка снова кладёт 5–6 МБ.
 *
 * ПОРЯДОК ДЕЙСТВИЙ — то, на чём держится безопасность прохода:
 *   1. берём байты (из кэша бокса, иначе качаем с Я.Диска) и сверяем их sha256 со строкой;
 *   2. сжимаем тем же кодом, что и приём загрузок, — расходиться двум правилам негде;
 *   3. кладём результат на Я.Диск ПО НОВОМУ пути и проверяем размер и дайджест;
 *   4. только теперь правим строку (size, sha256, путь) и обновляем копию в кэше;
 *   5. и лишь затем удаляем старый файл.
 * Обрыв на любом шаге до (4) не трогает ничего: строка по-прежнему указывает на целый оригинал.
 * Обрыв между (4) и (5) оставляет на Я.Диске лишний файл — это место, а не потеря.
 *
 * Чего проход НЕ делает:
 *   * не трогает строки, у которых байты не сошлись с sha256 — там что-то своё, разбираться руками;
 *   * не трогает превью: они и так маленькие и сделаны из оригинала;
 *   * не создаёт дублей sha256 — если сжатый снимок совпал с уже существующим, строка пропускается
 *     (уникальный индекс по sha256 живых строк).
 *
 * Dry-run по умолчанию. Флаги:
 *   --apply           — выполнять запись
 *   --limit=<N>       — не больше N строк (для пробного прогона)
 *   --min-mb=<N>      — брать только снимки крупнее N МБ (по умолчанию 1.5)
 *
 *   pnpm -F @matricarmz/backend-api photos:recompress             # сухой прогон
 *   pnpm -F @matricarmz/backend-api photos:recompress --limit=20 --apply
 */
import 'dotenv/config';

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq, isNull, ne, sql } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { fileAssets } from '../database/schema.js';
import { cacheRelPath } from '../services/fileCachePlan.js';
import { normalizeUploadImage } from '../services/imageNormalize.js';
import { uploadsDir } from '../services/fileCache.js';
import { deletePath, getDownloadHref, getResourceInfo, normalizeDiskPath, uploadBytes } from '../services/yandexDisk.js';
import { verifyUploaded } from './offloadLocalFilesToYandexPlan.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(0, Math.trunc(Number(limitArg.split('=')[1]))) : 0;
const minArg = process.argv.find((a) => a.startsWith('--min-mb='));
const MIN_BYTES = Math.round((minArg ? Number(minArg.split('=')[1]) : 1.5) * 1024 * 1024);

const mb = (n: number) => (n / 1048576).toFixed(2);

/**
 * Куда кладём сжатую копию. Соседняя папка рядом с `offloaded/`, а не тот же путь: пока строка
 * не переписана, оригинал обязан оставаться нетронутым. Имя, которое видит оператор, живёт в
 * колонке `name`, а не в пути, — переезд файла на экране никак не виден.
 */
export function recompressedDiskPath(base: string, fileId: string, fileName: string): string {
  const b = normalizeDiskPath(base);
  return `${b === '/' ? '' : b}/recompressed/${fileId.slice(0, 2)}/${fileId}_${fileName}`;
}

async function fetchFromYandex(diskPath: string): Promise<Buffer> {
  const href = await getDownloadHref(diskPath);
  const res = await fetch(href);
  if (!res.ok) throw new Error(`скачивание ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

type Row = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  storageKind: string;
  localRelPath: string | null;
  yandexDiskPath: string | null;
};

async function main() {
  const base = (process.env.YANDEX_DISK_BASE_PATH ?? '').trim();
  if (!base) throw new Error('YANDEX_DISK_BASE_PATH не настроен');
  console.log(APPLY ? 'режим: ЗАПИСЬ (--apply)' : 'режим: сухой прогон (записи не будет)');
  console.log(`порог: снимки крупнее ${mb(MIN_BYTES)} МБ`);

  const rows = (await db
    .select({
      id: fileAssets.id,
      name: fileAssets.name,
      size: fileAssets.size,
      sha256: fileAssets.sha256,
      storageKind: fileAssets.storageKind,
      localRelPath: fileAssets.localRelPath,
      yandexDiskPath: fileAssets.yandexDiskPath,
    })
    .from(fileAssets)
    .where(and(isNull(fileAssets.deletedAt), sql`${fileAssets.name} ~* '\\.jpe?g$'`, sql`${fileAssets.size} >= ${MIN_BYTES}`))
    .orderBy(fileAssets.createdAt)) as Row[];

  console.log(`снимков-кандидатов: ${rows.length}, суммарно ${mb(rows.reduce((s, r) => s + Number(r.size), 0))} МБ`);
  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  if (LIMIT > 0) console.log(`--limit=${LIMIT}: берём ${work.length}`);

  const root = resolve(uploadsDir());
  let done = 0;
  let from = 0;
  let to = 0;
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);

  for (const row of work) {
    const id = String(row.id);
    try {
      // 1. Байты и сверка с тем, что записано в строке.
      let src: Buffer | null = null;
      const cacheAbs = row.localRelPath ? join(root, String(row.localRelPath)) : '';
      if (cacheAbs && existsSync(cacheAbs)) src = readFileSync(cacheAbs);
      if (!src && row.yandexDiskPath) src = await fetchFromYandex(String(row.yandexDiskPath));
      if (!src) {
        skip('байты не найдены ни в кэше, ни на Я.Диске');
        continue;
      }
      if (createHash('sha256').update(src).digest('hex') !== String(row.sha256)) {
        skip('байты не сходятся с sha256 строки');
        continue;
      }

      // 2. Сжатие тем же кодом, что и приём загрузок.
      const out = await normalizeUploadImage(src, { name: String(row.name) });
      if (!out.changed) {
        skip('сжимать нечего');
        continue;
      }
      const newSha = createHash('sha256').update(out.bytes).digest('hex');
      const clash = await db
        .select({ id: fileAssets.id })
        .from(fileAssets)
        .where(and(eq(fileAssets.sha256, newSha), isNull(fileAssets.deletedAt), ne(fileAssets.id, id)))
        .limit(1);
      if (clash[0]) {
        skip('сжатая копия совпала с другим файлом');
        continue;
      }

      from += out.from;
      to += out.to;
      done += 1;
      if (!APPLY) {
        if (done <= 10) console.log(`  ${row.name}: ${mb(out.from)} → ${mb(out.to)} МБ`);
        continue;
      }

      // 3. Новая копия на Я.Диске — и проверка, что байты долетели.
      const newPath = recompressedDiskPath(base, id, String(row.name));
      await uploadBytes({ diskPath: newPath, bytes: out.bytes, mime: 'image/jpeg' });
      const md5 = createHash('md5').update(out.bytes).digest('hex');
      const verdict = verifyUploaded({ size: out.bytes.length, sha256: newSha, md5 }, await getResourceInfo(newPath));
      if (!verdict.ok) {
        await deletePath(newPath).catch(() => undefined);
        skip(`копия не подтвердилась: ${verdict.reason}`);
        done -= 1;
        from -= out.from;
        to -= out.to;
        continue;
      }

      // 4. Строка и кэш — только теперь.
      const newCacheRel = cacheRelPath(id, String(row.name));
      const newCacheAbs = join(root, newCacheRel);
      mkdirSync(dirname(newCacheAbs), { recursive: true });
      writeFileSync(newCacheAbs, out.bytes);
      await db
        .update(fileAssets)
        .set({
          size: out.bytes.length,
          sha256: newSha,
          storageKind: 'yandex',
          yandexDiskPath: newPath,
          localRelPath: newCacheRel,
          localCachedAt: Date.now(),
        })
        .where(eq(fileAssets.id, id));

      // 5. Старый файл — последним.
      const oldPath = row.yandexDiskPath ? String(row.yandexDiskPath) : '';
      if (oldPath && oldPath !== newPath) await deletePath(oldPath).catch(() => undefined);

      if (done % 50 === 0) console.log(`  … обработано ${done}, освобождено ${mb(from - to)} МБ`);
    } catch (e) {
      skip(`ошибка: ${String(e).slice(0, 80)}`);
    }
  }

  console.log('');
  console.log(`${APPLY ? 'пересжато' : 'к пересжатию'}: ${done} снимков`);
  console.log(`${mb(from)} МБ → ${mb(to)} МБ, освобождается ${mb(from - to)} МБ${to > 0 ? ` (в ${(from / to).toFixed(1)} раза)` : ''}`);
  for (const [why, n] of [...skipped.entries()].sort((a, b) => b[1] - a[1])) console.log(`пропущено — ${why}: ${n}`);
  if (!APPLY) console.log('\nсухой прогон — ничего не записано. Повторите с --apply.');
  await pool.end();
}

/** Как и у прочих одноразовых проходов: импорт ради функции не должен запускать сам проход. */
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
