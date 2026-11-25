// Шим 'node:fs' (android): синхронной файловой системы у планшета нет.
//
// Потребитель в бандле — канал «Показать файл в папке» у клиента, который
// предупреждает оператора о неотправленных данных, лежащих файлом на машине
// (PR #1974). На десктопе канал проверяет, что файл есть, и открывает Проводник.
// На планшете «файл» — запись в localStorage WebView (тот же ключ, что читает шим
// node:fs/promises), и раньше existsSync отвечал «нет» на файле, который ЕСТЬ:
// кнопка говорила оператору «файл не найден» (план #114, шаг 30).
//
// `createReadStream` и `mkdirSync` добавлены для `services/fileService.ts`,
// которого тянет ИИ-чат (загрузка вложения к вопросу). Файловой системы у
// планшета нет, поэтому поток честно отказывает, а mkdir — заглушка: хранилище
// плоских файлов WebView не имеет каталогов.
//
// Остальные имена node:fs намеренно НЕ вынесены: если портированный модуль
// попросит что-то ещё, сборка планшета должна упасть громко (rollup не найдёт
// экспорта), а не работать молча вследствие подмены.
import { fsStat } from './fsStore.js';
import * as fsp from './nodeFsPromises.js';

export function existsSync(path: string): boolean {
  return fsStat(path) != null;
}

/**
 * Синхронного чтения файла на планшете нет. Отказ громкий: вызывающий код
 * (fileService) сам решает, что делать с нечитаемым вложением.
 */
export function createReadStream(_path: string): never {
  throw new Error('на планшете нет файловой системы — читать файл неоткуда');
}

/** Каталогов у плоского хранилища WebView нет — mkdirSync ничего не делает. */
export function mkdirSync(_path: string, _opts?: unknown): void {
  // no-op
}

/** `import { promises as fsp } from 'node:fs'` — тот же асинхронный слой, что и node:fs/promises. */
export { fsp as promises };

export default { existsSync, createReadStream, mkdirSync, promises: fsp };
