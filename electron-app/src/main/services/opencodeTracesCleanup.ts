import { execFile } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Уборка следов opencode на клиентской машине.
 *
 * Два слоя:
 *  1. **Вырезанный OpenCode-узел** (решение владельца 19.10.2026): папка бинаря
 *     `%LOCALAPPDATA%\Programs\MatricaRMZ-OpenCode`, реестр узлов, сессия агента и
 *     песочница вопросов в userData, каталог загрузки релиза в TEMP.
 *  2. **Локальный движок Ииваныча** (решение владельца 23.10.2026 — считать только
 *     сервер): каталог `%LOCALAPPDATA%\Programs\MatricaRMZ\engine` с версиями
 *     opencode, каталог данных в userData и `%TEMP%\matricarmz-engine`.
 *
 * Код обоих модулей снесён, файлы остались на машинах — их снимает разовая
 * подчистка при старте клиента (рядом с `sweepLegacyInstallDir`).
 *
 * Шагом миграции такую уборку делать нельзя: electron-модуль миграций попадает
 * в браузерный бандл планшета, а `node:child_process` там не шимится (на этом
 * упал `build-apk` в PR #1379).
 *
 * Личный каталог CLI (`%USERPROFILE%\.config\opencode` и `.local\share\opencode`)
 * — чужое, его не трогаем.
 */
export type OpencodeCleanupRoots = {
  localAppData?: string;
  userDataDir?: string;
  tempDir?: string;
};

const NODE_DIR_NAME = 'MatricaRMZ-OpenCode';
const ENGINE_PARENT_DIR_NAME = 'MatricaRMZ';
const ENGINE_DIR_NAME = 'engine';
const NODE_EXE_NAME = 'opencode.exe';
const PID_FILE_NAME = 'serve.pid';

/**
 * Каталог данных клиента спрашиваем у Electron лениво: модуль читают и юниты
 * (в них корни подставляются аргументом, Electron не нужен), а статический
 * `import 'electron'` вне приложения отдаёт не API, а путь к бинарю.
 */
async function electronUserDataDir(): Promise<string | undefined> {
  try {
    const electron = (await import('electron')) as { app?: { getPath?: (name: string) => string } };
    const dir = electron.app?.getPath?.('userData');
    return dir ? String(dir) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Живой ли процесс и точно ли это движок. Гасим только на Windows и только с
 * подтверждённым именем образа: PID переиспользуется, а ошибка здесь стоит
 * чужой программы. Устаревший `serve.pid` без этой проверки однажды погасил бы
 * посторонний процесс.
 */
async function isOpencodeProcess(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const listed = await new Promise<string>((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], (error, stdout) =>
      resolve(error ? '' : String(stdout)),
    );
  });
  return listed.toLowerCase().includes(NODE_EXE_NAME);
}

/**
 * Каталоги, где движок оставляет `serve.pid`: корень плоской установки и
 * `versions/<версия>` версионной раскладки (движок 3.86+).
 */
async function pidDirs(root: string): Promise<string[]> {
  const dirs = [root];
  const versions = join(root, 'versions');
  const entries = await readdir(versions, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(join(versions, entry.name));
  }
  return dirs;
}

async function stopOpencodeNode(dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    const raw = await readFile(join(dir, PID_FILE_NAME), 'utf8').catch(() => '');
    const pid = Number(raw.trim());
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!(await isOpencodeProcess(pid))) continue;
    try {
      process.kill(pid);
      // Windows отпускает образ не мгновенно — без паузы папка не удалится.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch {
      // Процесс погас сам между проверкой и сигналом — папку всё равно убираем.
    }
  }
}

function unique(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((p): p is string => Boolean(p)))];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Снимает следы и возвращает пути, которые реально убраны. Ошибки глушатся:
 * уборка не должна ронять старт клиента (её зовут fire-and-forget).
 */
export async function removeOpencodeTraces(roots: OpencodeCleanupRoots = {}): Promise<string[]> {
  const localAppData = roots.localAppData ?? process.env.LOCALAPPDATA;
  const userDataDir = roots.userDataDir ?? (await electronUserDataDir());
  const tempDir = roots.tempDir ?? tmpdir();

  const nodeDirs = unique([
    localAppData ? join(localAppData, 'Programs', NODE_DIR_NAME) : undefined,
    userDataDir ? join(userDataDir, 'opencode-node') : undefined,
  ]);
  const engineDirs = unique([
    localAppData ? join(localAppData, 'Programs', ENGINE_PARENT_DIR_NAME, ENGINE_DIR_NAME) : undefined,
    userDataDir ? join(userDataDir, ENGINE_DIR_NAME) : undefined,
  ]);

  const pidSources: string[] = [];
  for (const dir of [...nodeDirs, ...engineDirs]) {
    if (await pathExists(dir)) pidSources.push(...(await pidDirs(dir)));
  }
  await stopOpencodeNode(pidSources);

  const targets = unique([
    ...nodeDirs,
    ...engineDirs,
    userDataDir ? join(userDataDir, 'opencode-node-data') : undefined,
    userDataDir ? join(userDataDir, 'opencode-nodes.json') : undefined,
    userDataDir ? join(userDataDir, 'opencode-agent-session.json') : undefined,
    userDataDir ? join(userDataDir, 'opencode-sandbox') : undefined,
    join(tempDir, 'matricarmz-opencode'),
    join(tempDir, 'matricarmz-engine'),
  ]);
  const removed: string[] = [];
  for (const target of targets) {
    if (!(await pathExists(target))) continue;
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      // Не убралось (занято, нет прав) — молчим: уборка не повод шуметь в логе.
    }
  }
  return removed;
}
