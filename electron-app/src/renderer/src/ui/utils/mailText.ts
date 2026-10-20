import type { ListPrintColumn } from '../components/ListPrintDialog.js';

/**
 * Текст письма из того же материала, что уходит в печать.
 *
 * Отдельный сборщик тут был бы третьим описанием формы (лист, файл, письмо) — и разъехался
 * бы с первыми двумя. Поэтому письмо читает подмножество HTML, которое и так собирают секции
 * печати: абзацы, строки таблиц и ячейки.
 */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&laquo;': '«',
  '&raquo;': '»',
  '&hellip;': '…',
  '&deg;': '°',
  '&times;': '×',
  '&plusmn;': '±',
};

function decodeEntities(text: string): string {
  let out = text;
  for (const [entity, value] of Object.entries(ENTITIES)) out = out.split(entity).join(value);
  return out
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

export function htmlToPlainText(html: string): string {
  let text = String(html ?? '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(td|th)>/gi, ' | ');
  text = text.replace(/<\/(tr|div|p|h[1-6]|li)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\|\s*$/, '')
        .trim(),
    )
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
    .trim();
}

export function printSectionsToText(sections: readonly { title: string; html: string; hideTitle?: boolean }[]): string {
  return sections
    .map((section) => {
      const body = htmlToPlainText(section.html);
      if (!body) return '';
      return section.hideTitle ? body : `${section.title}\n${body}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Список в текст письма. Не «красивая таблица», а читаемые строки: почта всё равно покажет
 * только моноширинный текст, а полная таблица едет вложением.
 */
export function listToText<T>(fields: readonly ListPrintColumn<T>[], rows: readonly T[], limit = 40): string {
  const visible = rows.slice(0, limit);
  const lines = visible.map((row) => fields.map((field) => field.printValue(row)).join(' | '));
  if (rows.length > visible.length) lines.push(`… и ещё ${rows.length - visible.length} строк — полностью в приложенном файле`);
  return lines.join('\n');
}
