import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, shell } from 'electron';

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
};

const ARCHIVE_FILE = 'kaspersky-matrica.zip';

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
  };
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
