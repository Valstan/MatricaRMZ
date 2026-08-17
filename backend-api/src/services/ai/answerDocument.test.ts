import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';

import { buildAnswerDocx } from './answerDocument.js';

/**
 * Достаёт word/document.xml из docx без сторонних библиотек: находим локальную
 * запись по имени и распаковываем raw-deflate (метод 8) либо берём как есть.
 */
async function readDocumentXml(buf: Buffer): Promise<string> {
  let at = -1;
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) === 0x04034b50) {
      const nameLen = buf.readUInt16LE(i + 26);
      const name = buf.subarray(i + 30, i + 30 + nameLen).toString('latin1');
      if (name === 'word/document.xml') {
        at = i;
        break;
      }
    }
  }
  if (at < 0) throw new Error('word/document.xml не найден в архиве');
  const method = buf.readUInt16LE(at + 8);
  const compressedSize = buf.readUInt32LE(at + 18);
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  // compressedSize == 0 → размер лежит в data descriptor; inflateRaw сам
  // остановится на конце потока, поэтому отдаём ему остаток буфера.
  const body = compressedSize > 0 ? buf.subarray(start, start + compressedSize) : buf.subarray(start);
  if (method === 0) return body.toString('utf8');
  return inflateRawSync(body).toString('utf8');
}

const BELL = String.fromCharCode(7);
const UNIT_SEP = String.fromCharCode(31);
const LONE_SURROGATE = String.fromCharCode(0xd83d);
// eslint-disable-next-line no-control-regex -- в тесте проверяем именно их отсутствие
const CONTROL_CHARS_RE = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F]');
const LONE_HIGH_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

describe('buildAnswerDocx', () => {
  it('собирает валидный docx из markdown с заголовком, списком и таблицей', async () => {
    const buf = await buildAnswerDocx({
      question: 'вся рекламация ОВК',
      answerMarkdown: [
        '# Рекламации ОВК',
        '',
        'Всего **2** двигателя.',
        '',
        '| Двигатель | Вердикт |',
        '| --- | --- |',
        '| ДВ-101 | Наша вина |',
        '| ДВ-202 | Не подтвердилось |',
        '',
        '- принят 12.05.2026',
        '1. отгружен 20.06.2026',
      ].join('\n'),
    });
    // docx = zip: сигнатура PK и непустое тело.
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('не падает на пустом ответе', async () => {
    const buf = await buildAnswerDocx({ question: '', answerMarkdown: '' });
    expect(buf.length).toBeGreaterThan(100);
  });

  // Регрессия 2026-08-17: Word 2007 отвергал файл целиком («Файл поврежден»),
  // потому что ширина таблицы уходила процентами (w:type="pct" w:w="100%").
  it('задаёт ширину таблицы в твипах, а не в процентах', async () => {
    const xml = await readDocumentXml(
      await buildAnswerDocx({ question: 'q', answerMarkdown: '| A | B |\n| --- | --- |\n| 1 | 2 |\n' }),
    );
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('w:type="dxa"');
    expect(xml).not.toContain('w:type="pct"');
    expect(xml).not.toContain('100%');
  });

  // Регрессия 2026-08-17: <w:tbl> без строк — тоже «Файл поврежден».
  it('не создаёт пустую таблицу из одной строки-разделителя', async () => {
    const xml = await readDocumentXml(await buildAnswerDocx({ question: 'q', answerMarkdown: '| --- | --- |\n' }));
    expect(xml).not.toContain('<w:tbl>');
  });

  // Регрессия 2026-08-17: управляющие символы в ответе движка ломали XML
  // («Недопустимый знак xml»).
  it('вычищает недопустимые в XML символы из текста ответа', async () => {
    const xml = await readDocumentXml(
      await buildAnswerDocx({
        question: `вопрос ${BELL} звонок`,
        answerMarkdown: `Текст ${BELL} и ${UNIT_SEP} контрол, обрубленный суррогат ${LONE_SURROGATE} конец.\n`,
      }),
    );
    expect(xml).not.toMatch(CONTROL_CHARS_RE);
    expect(xml).not.toMatch(LONE_HIGH_SURROGATE_RE);
    expect(xml).toContain('контрол');
  });

  it('таблица не остаётся последним элементом секции', async () => {
    const xml = await readDocumentXml(
      await buildAnswerDocx({ question: 'q', answerMarkdown: 'текст\n\n| A | B |\n| --- | --- |\n| 1 | 2 |' }),
    );
    const lastTbl = xml.lastIndexOf('</w:tbl>');
    expect(lastTbl).toBeGreaterThan(0);
    expect(xml.slice(lastTbl)).toContain('<w:p');
  });
});
