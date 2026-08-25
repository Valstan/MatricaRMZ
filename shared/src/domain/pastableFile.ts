// Какие файлы годятся для кнопки «Вставить текст из файла» (вкладка «Рекламация»).
// Решение о пригодности — здесь, чтобы диалог выбора, чтение и сообщение оператору
// не разошлись: список расширений в фильтре диалога обязан совпадать с тем, что
// программа умеет прочитать.

export type PastableFileKind = 'text' | 'docx' | 'unsupported';

const TEXT_EXTENSIONS = ['txt', 'csv', 'tsv', 'log'] as const;

export const PASTABLE_FILE_DIALOG_FILTERS: Array<{ name: string; extensions: string[] }> = [
  { name: 'Текст и документы Word', extensions: ['txt', 'docx', 'csv', 'tsv', 'log'] },
  { name: 'Документ Word', extensions: ['docx'] },
  { name: 'Текстовый файл', extensions: [...TEXT_EXTENSIONS] },
];

function extensionOf(nameOrPath: string): string {
  const base = String(nameOrPath ?? '').replaceAll('\\', '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function classifyPastableFile(nameOrPath: string): PastableFileKind {
  const ext = extensionOf(nameOrPath);
  if (ext === 'docx') return 'docx';
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) return 'text';
  return 'unsupported';
}

export function unsupportedPastableFileMessage(nameOrPath: string): string {
  const ext = extensionOf(nameOrPath);
  // .doc встречается чаще прочего отказа, и у него есть понятный выход — назовём его.
  if (ext === 'doc') {
    return 'Старый формат .doc программа не читает. Откройте файл в Word и сохраните как .docx — тогда текст возьмётся.';
  }
  if (!ext) {
    return 'У файла нет расширения, и непонятно, чем его читать. Подойдут .txt и .docx.';
  }
  return `Из файлов .${ext} текст не берётся. Подойдут .txt и .docx.`;
}

function decodeWith(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return null;
  }
}

function decodeByContent(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeWith('utf-8', bytes.subarray(3)) ?? '';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeWith('utf-16le', bytes.subarray(2)) ?? '';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeWith('utf-16be', bytes.subarray(2)) ?? '';
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Не UTF-8 — на заводских машинах это почти всегда CP1251.
    return decodeWith('windows-1251', bytes) ?? decodeWith('utf-8', bytes) ?? '';
  }
}

/** Байты выбранного файла → текст: определяет кодировку и приводит переводы строк к `\n`. */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (!bytes || bytes.length === 0) return '';
  return decodeByContent(bytes).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}
