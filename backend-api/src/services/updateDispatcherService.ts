// Диспетчер обновлений — серверные мозги перехода со старой нумерации (CalVer,
// 2026.814.1503) на нумерацию поколений (3.1.0, «Матрица3-РМЗ (1)») и опора всех
// будущих обновлений.
//
// Проблема, которую он решает: клиент в поле сравнивает версии СВОИМ кодом, по числам
// слева направо, и 3 < 2026 — новый релиз для него «откат назад», самообновление
// встаёт навсегда. Дотянуться до этого кода нельзя. Поэтому:
//
//   1. Старый канал (/updates/latest-meta БЕЗ параметра `current`) навсегда заморожен
//      на ЗАГЛУШКЕ — крошечной программе с CalVer-огромным номером (2026.1231.2359),
//      который любой старый клиент считает новее себя. Он скачивает и запускает её
//      штатно, как обычный инсталлятор.
//   2. Заглушка спрашивает Диспетчер (/dispatcher/update-plan), скачивает настоящий
//      свежий дистрибутив и запускает его установку.
//   3. Новые клиенты (3.x) передают свою версию параметром `current` — им канал отдаёт
//      настоящий свежий дистрибутив, решение принимает эпохо-зависимое сравнение.
//
// Заглушка живёт в подкаталоге stub/ каталога обновлений (скан updateTorrentService
// подкаталоги не читает — она никогда не станет «последним инсталлятором»). Файл
// остаётся там навсегда: очень древний клиент, оживший через год, пройдёт тот же путь.
//
// Диспетчер — расширяемый: сюда же со временем встанут советы клиентам по ошибкам,
// консультации нейросети (D-024, ИИваныч/DeepSeek) и прочая координация экосистемы.
// Пока он умеет главное: знать версии и вести любую из них к свежайшей.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { compareAppVersion, versionEpoch, VERSION_EPOCH_GENERATION } from '@matricarmz/shared';

import { logInfo, logWarn } from '../utils/logger.js';
import { getLatestUpdateFileMeta } from './updateTorrentService.js';

export type StubMeta = {
  version: string;
  fileName: string;
  filePath: string;
  size: number;
  sha256: string;
};

export type LatestMetaLike = {
  version: string;
  fileName: string;
  size: number;
  sha256: string;
  blockmapFileName?: string;
};

export type UpdatePlan =
  | { action: 'up-to-date'; current: string; latest: LatestMetaLike }
  | { action: 'update'; current: string; latest: LatestMetaLike }
  | { action: 'none'; reason: string };

function getUpdatesDir(): string | null {
  const raw = String(process.env.MATRICA_UPDATES_DIR ?? '').trim();
  return raw || null;
}

function getStubDir(): string | null {
  const dir = getUpdatesDir();
  return dir ? join(dir, 'stub') : null;
}

function extractVersionFromFileName(fileName: string): string | null {
  const m = fileName.match(/(\d+\.\d+\.\d+)/);
  return m?.[1] ?? null;
}

let cachedStub: (StubMeta & { mtimeMs: number }) | null = null;

/**
 * Заглушка из <updatesDir>/stub/ — единственный .exe там. null, если каталога или
 * файла нет (тогда старый канал честно отдаёт настоящий latest, как раньше).
 */
export async function getStubMeta(): Promise<StubMeta | null> {
  const dir = getStubDir();
  if (!dir) return null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const exe = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe'));
  if (!exe) return null;
  const filePath = join(dir, exe.name);
  const st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) return null;
  const version = extractVersionFromFileName(exe.name);
  if (!version) {
    logWarn(`update stub ignored: cannot extract version from "${exe.name}"`);
    return null;
  }
  const mtimeMs = Number(st.mtimeMs ?? 0);
  if (cachedStub && cachedStub.filePath === filePath && cachedStub.mtimeMs === mtimeMs && cachedStub.size === st.size) {
    return cachedStub;
  }
  const buf = await readFile(filePath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  cachedStub = { version, fileName: exe.name, filePath, size: st.size, sha256, mtimeMs };
  logInfo(`update stub loaded: ${exe.name} (${st.size} bytes)`);
  return cachedStub;
}

/**
 * Решение «куда обновляться с версии current». Чистая логика — тестируется напрямую.
 * Клиент новой эпохи и уже на свежем → up-to-date; все остальные распознанные версии
 * (CalVer, легаси, сама заглушка) ведутся на свежайший дистрибутив.
 */
export function decideUpdatePlan(current: string, latest: LatestMetaLike | null): UpdatePlan {
  if (!latest) return { action: 'none', reason: 'файл обновления не найден на сервере' };
  const cur = String(current ?? '').trim();
  if (cur && versionEpoch(cur) === VERSION_EPOCH_GENERATION && compareAppVersion(cur, latest.version) >= 0) {
    return { action: 'up-to-date', current: cur, latest };
  }
  return { action: 'update', current: cur || '(unknown)', latest };
}

/** План обновления для клиента/заглушки, по фактическому свежайшему инсталлятору. */
export async function getUpdatePlan(current: string): Promise<UpdatePlan> {
  const latest = await getLatestUpdateFileMeta();
  return decideUpdatePlan(current, latest);
}
