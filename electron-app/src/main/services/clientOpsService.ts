import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, shell } from 'electron';

import { readClientOpsArchive } from './clientOpsArchive.js';

/**
 * Скрипты обслуживания машины парка: помощник по антивирусу и правило брандмауэра для раздачи
 * обновлений соседям. Они уже едут с клиентом (`extraResources`), но добраться до них можно было
 * только через ярлык на рабочем столе Windows, который установщик кладёт один раз — переустановка,
 * новая машина или уборка стола, и оператор остаётся без них.
 *
 * Отдаём ИМЕННО архив, а не распакованные `.ps1`: Касперский съедает неподписанный скрипт в тот
 * же момент, как тот появляется на диске, ещё до того, как для него заведено исключение (M94).
 * Архив под паролем сканеру непрозрачен — пароль не секрет, он напечатан и в памятке, и здесь,
 * его единственная работа в том, чтобы архив нельзя было просмотреть на лету.
 */
export const CLIENT_OPS_ARCHIVE_PASSWORD = '111';

export type ClientOpsBundle = {
  /** Имя файла архива в ресурсах клиента. */
  fileName: string;
  /** Полный путь; пусто — архив не найден (dev-запуск или сборка без ресурса). */
  path: string;
  available: boolean;
  password: string;
  /** Что лежит внутри — для подписи на экране, чтобы оператор не открывал архив «наугад». */
  contents: string[];
  /** Куда распаковываемся при запуске — показываем оператору, чтобы он знал, где искать. */
  workDir: string;
  /** Запуск в один щелчок доступен только на Windows: PowerShell-окна больше нигде нет. */
  canLaunch: boolean;
};

const ARCHIVE_FILE = 'kaspersky-matrica.zip';
/** Точка входа окна с вкладками. Имя латиницей: путь уезжает в аргументы PowerShell. */
const LAUNCHER_SCRIPT = 'matrica-ops.ps1';

/**
 * Куда распаковываем. Это НЕ каталог установки: его целиком переписывает автообновление, и
 * распакованное там жило бы до первого же обновления. Папка данных клиента подходит по обеим
 * причинам сразу: она переживает обновление и — главное — уже стоит в списке исключений,
 * который готовит сам помощник по Касперскому (`UserDataDir` в `Get-ExclusionPlan`). То есть
 * на настроенной машине распакованный `.ps1` попадает в место, где антивирус его не тронет.
 */
function workDir(): string {
  return join(app.getPath('userData'), 'Обслуживание');
}

/** Где искать архив: упакованный клиент кладёт ресурсы рядом, dev-запуск — в build/kaspersky. */
function candidatePaths(): string[] {
  const out = [join(process.resourcesPath ?? '', ARCHIVE_FILE)];
  const cwd = process.cwd();
  out.push(join(cwd, 'build', 'kaspersky', ARCHIVE_FILE));
  out.push(join(cwd, 'electron-app', 'build', 'kaspersky', ARCHIVE_FILE));
  return out.filter((p) => p && !p.startsWith(ARCHIVE_FILE));
}

export function getClientOpsBundle(): ClientOpsBundle {
  const found = candidatePaths().find((p) => existsSync(p)) ?? '';
  return {
    fileName: ARCHIVE_FILE,
    path: found,
    available: Boolean(found),
    password: CLIENT_OPS_ARCHIVE_PASSWORD,
    contents: [
      'Настройка Касперского — помощник сам находит папки Матрицы и готовит списки для «Импорта»',
      'Раздача соседям — правило брандмауэра, чтобы машина отдавала обновления соседним компьютерам',
      'Памятка: как всё это применить, по шагам',
    ],
    workDir: workDir(),
    canLaunch: Boolean(found) && process.platform === 'win32',
  };
}

/**
 * Распаковать архив в рабочую папку. Делается ПЕРЕД КАЖДЫМ запуском, а не один раз: сборка
 * клиента могла приехать с новыми скриптами, а на ненастроенной машине антивирус мог съесть
 * прежние — в обоих случаях повторная распаковка чинит всё молча и без участия оператора.
 */
export function extractClientOpsBundle(): { ok: true; dir: string; files: string[] } | { ok: false; error: string } {
  const bundle = getClientOpsBundle();
  if (!bundle.available) return { ok: false, error: 'Архив со скриптами не найден в этой сборке клиента' };
  try {
    // Читаем архив сами (`clientOpsArchive.ts`): Проводник распаковывает только руками, а 7-Zip
    // на машинах парка не стоит — на него и рассчитывать нельзя.
    const entries = readClientOpsArchive(readFileSync(bundle.path), bundle.password);
    const dir = workDir();
    mkdirSync(dir, { recursive: true });
    for (const entry of entries) writeFileSync(join(dir, entry.name), entry.data);
    return { ok: true, dir, files: entries.map((e) => e.name) };
  } catch (e) {
    return { ok: false, error: `Не удалось распаковать архив: ${String(e)}` };
  }
}

/**
 * Распаковать и открыть окно обслуживания.
 *
 * Права администратора запрашивает САМ скрипт, а не мы. Причина в том, что установщик собран
 * `perMachine: false` именно потому, что у оператора цеха прав администратора обычно нет:
 * потребуй мы их здесь — половина парка упёрлась бы в запрос пароля, которого у неё нет, и не
 * увидела бы даже того, что прекрасно работает без прав (подготовка списков для Касперского,
 * проверка состояния). Поэтому скрипт пробует подняться, а при отказе продолжает без прав и
 * гасит те кнопки, которым права действительно нужны.
 */
export function launchClientOps(
  args: { tab?: string } = {},
): { ok: true; dir: string } | { ok: false; error: string } {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Скрипты обслуживания рассчитаны на Windows — на этой системе их не запустить' };
  }
  const extracted = extractClientOpsBundle();
  if (!extracted.ok) return extracted;

  const script = join(extracted.dir, LAUNCHER_SCRIPT);
  if (!existsSync(script)) {
    return { ok: false, error: `В архиве этой сборки нет ${LAUNCHER_SCRIPT} — обновите клиент` };
  }

  try {
    // `-sta` обязателен: без однопоточной квартиры WinForms не отдаёт буфер обмена, а кнопки
    // «Копировать» — половина смысла окна с исключениями.
    const psArgs = ['-sta', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (args.tab) psArgs.push('-Tab', args.tab);
    // Свои пути передаём явно. Скрипт умеет искать их сам, но после подъёма прав на НЕадминской
    // учётке (оператор вводит чужие данные) он окажется в ЧУЖОМ профиле, где Матрицы нет вовсе —
    // и правило брандмауэра не для чего было бы создавать. Мы эти пути знаем точно.
    psArgs.push('-ClientExe', process.execPath, '-UserDataDir', app.getPath('userData'));
    const child = spawn('powershell.exe', psArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: extracted.dir,
    });
    // Окно живёт дольше клиента: оператор может закрыть Матрицу, пока правит антивирус.
    child.unref();
    return { ok: true, dir: extracted.dir };
  } catch (e) {
    return { ok: false, error: `Не удалось запустить окно обслуживания: ${String(e)}` };
  }
}

/** Показать архив в проводнике. Оператор распаковывает его сам — паролем из подписи на экране. */
export function revealClientOpsBundle(): { ok: true } | { ok: false; error: string } {
  const bundle = getClientOpsBundle();
  if (!bundle.available) return { ok: false, error: 'Архив со скриптами не найден в этой сборке клиента' };
  shell.showItemInFolder(bundle.path);
  return { ok: true };
}

/**
 * Положить копию архива в «Загрузки» и открыть папку. Нужен, когда установленная копия лежит в
 * системном каталоге: там оператор архив не распакует — прав нет.
 */
export function saveClientOpsBundleCopy(): { ok: true; folder: string } | { ok: false; error: string } {
  const bundle = getClientOpsBundle();
  if (!bundle.available) return { ok: false, error: 'Архив со скриптами не найден в этой сборке клиента' };
  try {
    const folder = join(app.getPath('downloads'), 'Матрица — скрипты обслуживания');
    mkdirSync(folder, { recursive: true });
    copyFileSync(bundle.path, join(folder, bundle.fileName));
    void shell.openPath(folder);
    return { ok: true, folder };
  } catch (e) {
    return { ok: false, error: `Не удалось сохранить копию: ${String(e)}` };
  }
}
