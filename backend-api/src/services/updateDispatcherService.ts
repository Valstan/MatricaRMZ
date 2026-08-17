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
  /** Готовая внешняя ссылка (Яндекс.Диск и т.п.) — иначе роут строит /updates/file/... */
  url?: string;
};

export type UpdatePlan =
  | { action: 'up-to-date'; current: string; latest: LatestMetaLike }
  | { action: 'update'; current: string; latest: LatestMetaLike }
  | { action: 'none'; reason: string };

// ── Каскад обновлений ────────────────────────────────────────────────────────
//
// Обычно любой клиент может прыгнуть сразу на свежайший выпуск. Но если где-то
// между его версией и свежей лежит выпуск, без которого прыжок ломает данные или
// саму программу (сменился формат локальной базы, переехал каталог установки,
// сменился ключ подписи…), клиента надо ПРОВЕСТИ через этот выпуск: одно-два
// промежуточных обновления, после которых он сам дойдёт до свежего и не пропадёт
// из вида. Правило каскада — декларативная строка в таблице ниже, код менять не
// нужно.
//
// Семантика правила: клиент платформы `platform` с версией СТРОГО НИЖЕ `below`
// сначала ведётся на `via`, а не на latest. Правил может сработать несколько —
// берётся самый ранний недостающий шаг (наименьший `via`). Файл шага кладётся в
// <updatesDir>/archive/ на сервере, либо правило несёт готовую ссылку `url`
// (например, публичную ссылку Яндекс.Диска — там владелец хранит нужные версии).
//
// Сегодня таблица ПУСТАЯ: прыжок CalVer → 3.x безопасен по данным (это проверено
// переходом), а сам перевод старого парка делает заглушка. Первый настоящий
// кандидат появится, когда какой-то выпуск 3.x сменит формат так, что прыгать
// через него станет нельзя.
export type UpgradeCascadeRule = {
  platform: 'windows' | 'android';
  below: string;
  // Файл шага: либо лежит в <updatesDir>/archive/ (size/sha256 сервер посчитает сам),
  // либо хостится снаружи (Яндекс.Диск) — тогда url + size + sha256 задаются в правиле,
  // чтобы клиент мог проверить скачанное.
  via: { version: string; fileName: string; url?: string; size?: number; sha256?: string };
};

export const UPGRADE_CASCADE: UpgradeCascadeRule[] = [];

export type CascadeHop = UpgradeCascadeRule['via'];

/**
 * Первый недостающий шаг каскада для клиента, или null (можно сразу на latest).
 * Чистая логика — тестируется напрямую; список правил передаётся параметром.
 */
export function nextCascadeHop(
  current: string,
  platform: string,
  rules: UpgradeCascadeRule[] = UPGRADE_CASCADE,
): CascadeHop | null {
  const cur = String(current ?? '').trim();
  const applicable = rules.filter(
    (r) =>
      r.platform === platform &&
      // клиент ниже границы правила и ещё не прошёл через шаг via
      (!cur || compareAppVersion(cur, r.below) < 0) &&
      (!cur || compareAppVersion(cur, r.via.version) < 0),
  );
  if (!applicable.length) return null;
  applicable.sort((a, b) => compareAppVersion(a.via.version, b.via.version));
  return applicable[0]!.via;
}

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

function getArchiveDir(): string | null {
  const dir = getUpdatesDir();
  return dir ? join(dir, 'archive') : null;
}

function getAndroidDir(): string | null {
  const dir = getUpdatesDir();
  return dir ? join(dir, 'android') : null;
}

let cachedAndroidApk: (LatestMetaLike & { filePath: string; mtimeMs: number }) | null = null;

/**
 * Свежайший APK планшетного клиента из <updatesDir>/android/. Версия — из имени
 * файла; если файлов несколько, берётся старший по эпохо-зависимому сравнению.
 * null — каталога нет или пуст (тогда план честно скажет «нет файла»).
 */
export async function getLatestAndroidApkMeta(): Promise<(LatestMetaLike & { filePath: string }) | null> {
  const dir = getAndroidDir();
  if (!dir) return null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const apks = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.apk'))
    .map((e) => ({ name: e.name, version: extractVersionFromFileName(e.name) }))
    .filter((e): e is { name: string; version: string } => !!e.version)
    .sort((a, b) => compareAppVersion(b.version, a.version));
  const top = apks[0];
  if (!top) return null;
  const filePath = join(dir, top.name);
  const st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) return null;
  const mtimeMs = Number(st.mtimeMs ?? 0);
  if (cachedAndroidApk && cachedAndroidApk.filePath === filePath && cachedAndroidApk.mtimeMs === mtimeMs && cachedAndroidApk.size === st.size) {
    return cachedAndroidApk;
  }
  const buf = await readFile(filePath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  cachedAndroidApk = { version: top.version, fileName: top.name, filePath, size: st.size, sha256, mtimeMs };
  logInfo(`android update apk loaded: ${top.name} (${st.size} bytes)`);
  return cachedAndroidApk;
}

const archiveMetaCache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

/** Метаданные файла из <updatesDir>/archive/ (промежуточные версии каскада). */
export async function getArchiveMeta(fileName: string): Promise<{ size: number; sha256: string; filePath: string } | null> {
  const dir = getArchiveDir();
  const clean = String(fileName ?? '').trim();
  if (!dir || !clean || clean.includes('/') || clean.includes('\\') || clean.includes('..')) return null;
  const filePath = join(dir, clean);
  const st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) return null;
  const mtimeMs = Number(st.mtimeMs ?? 0);
  const cached = archiveMetaCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === st.size) {
    return { size: cached.size, sha256: cached.sha256, filePath };
  }
  const buf = await readFile(filePath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  archiveMetaCache.set(filePath, { mtimeMs, size: st.size, sha256 });
  return { size: st.size, sha256, filePath };
}

/**
 * План обновления для клиента/заглушки: сначала каскад (недостающий промежуточный
 * шаг), иначе — свежайший инсталлятор.
 */
export async function getUpdatePlan(current: string, platform = 'windows'): Promise<UpdatePlan> {
  const hop = nextCascadeHop(current, platform);
  if (hop) {
    const archived = await getArchiveMeta(hop.fileName);
    if (archived) {
      return {
        action: 'update',
        current: String(current ?? '').trim() || '(unknown)',
        latest: {
          version: hop.version,
          fileName: hop.fileName,
          size: archived.size,
          sha256: archived.sha256,
          ...(hop.url ? { url: hop.url } : {}),
        },
      };
    }
    if (hop.url && hop.size && hop.sha256) {
      return {
        action: 'update',
        current: String(current ?? '').trim() || '(unknown)',
        latest: { version: hop.version, fileName: hop.fileName, size: hop.size, sha256: hop.sha256, url: hop.url },
      };
    }
    // Правило есть, а файла нет ни в архиве, ни с полными метаданными снаружи —
    // конфигурационная дыра. Кричим в лог и НЕ ведём клиента на latest: каскад
    // затем и существует, что прямой прыжок опасен.
    logWarn(`upgrade cascade misconfigured: step ${hop.version} (${hop.fileName}) has no archive file and no url+size+sha256`);
    return { action: 'none', reason: `промежуточная версия ${hop.version} недоступна на сервере` };
  }
  // Планшетный клиент обновляется собственным APK (<updatesDir>/android/), а не
  // Windows-инсталлятором; решение «свежий/нет» — тем же эпохо-зависимым сравнением.
  const latest = platform === 'android' ? await getLatestAndroidApkMeta() : await getLatestUpdateFileMeta();
  return decideUpdatePlan(current, latest);
}
