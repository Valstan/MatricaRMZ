// Извлечение текста из word/document.xml (.docx — обычный zip).
// Нужен, чтобы оператор мог вставить в поле карточки готовый текст акта или письма
// заказчика. Форматирование, таблицы и картинки намеренно теряются: полю нужен текст.

/** Абзац: и парный `<w:p>…</w:p>`, и самозакрытый `<w:p/>` (пустая строка). */
const PARAGRAPH_RE = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;

// Внутри абзаца текст несут только `w:t`; `w:tab`/`w:br`/`w:cr` — разделители.
// Всё прочее (`w:rPr`, `w:instrText`, `w:delText`) текстом не считается.
// `<w:t` не матчит `<w:tab/>` и `<w:tbl>`: после `w:t` обязателен пробел, `>` или `/`.
const RUN_TOKEN_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>|<w:tab(?:\s[^>]*)?\/?>|<w:br(?:\s[^>]*)?\/?>|<w:cr(?:\s[^>]*)?\/?>/g;

const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeXmlEntities(value: string): string {
  return value.replace(ENTITY_RE, (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return String.fromCodePoint(Number(dec));
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    return match;
  });
}

function paragraphToText(inner: string): string {
  let out = '';
  for (const token of inner.matchAll(RUN_TOKEN_RE)) {
    const [raw, text] = token;
    if (text !== undefined) {
      out += decodeXmlEntities(text);
    } else if (raw.startsWith('<w:tab')) {
      out += '\t';
    } else if (raw.startsWith('<w:br') || raw.startsWith('<w:cr')) {
      out += '\n';
    }
  }
  return out;
}

/** Обрезает пустые строки по краям, но сохраняет пустые строки внутри текста. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') start += 1;
  while (end > start && lines[end - 1]?.trim() === '') end -= 1;
  return lines.slice(start, end);
}

export function docxXmlToText(xml: string): string {
  if (!xml) return '';
  const paragraphs: string[] = [];
  for (const match of xml.matchAll(PARAGRAPH_RE)) {
    paragraphs.push(match[1] === undefined ? '' : paragraphToText(match[1]));
  }
  const lines = paragraphs.join('\n').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  return trimBlankEdges(lines).join('\n');
}
