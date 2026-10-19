import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { buildCardDocument, parseCardHtml } from './cardExportService.js';

async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('в файле нет word/document.xml');
  return doc.async('string');
}

const NARYAD_PARTS = [
  '<div style="display:flex;justify-content:space-between;"><div style="font-size:12px;font-weight:600;">19.10.2026</div>' +
    '<div style="text-align:right;font-size:14px;"><div style="font-weight:700;">Утверждаю</div><div>Начальник цеха</div>' +
    '<div style="margin-top:14px;"><span style="display:inline-block;width:160px;border-bottom:1px solid #0f172a;"></span>&nbsp;И.О. Фамилия</div></div></div>',
  '<div style="text-align:center;font-size:16px;font-weight:700;">Наряд на сборку двигателя</div>',
  '<table class="wo-meta"><thead><tr><th>№</th><th>Цех</th></tr></thead><tbody><tr><td>СБ-12</td><td>Сборка</td></tr></tbody></table>',
  '<table class="wo-crew"><thead><tr><th>Сотрудник</th><th>КТУ</th><th>Подпись</th></tr></thead>' +
    '<tbody><tr><td>Иванов И.И.</td><td>1</td><td class="wo-sign-cell"></td></tr></tbody></table>',
  '<div class="muted">Нет данных</div>',
] as const;
const NARYAD_HTML = NARYAD_PARTS.join('');

describe('разбор формы карточки', () => {
  it('каждый div — абзац, кегль и жирность читаются из инлайнового стиля', () => {
    const blocks = parseCardHtml('<div style="font-size:12px;">Дата</div><div style="font-size:16px;font-weight:700;">Заголовок</div>');
    expect(blocks).toHaveLength(2);
    const first = blocks[0] as { runs: Array<{ text: string; bold: boolean; sizePx: number | null }> };
    const second = blocks[1] as { runs: Array<{ text: string; bold: boolean; sizePx: number | null }> };
    expect(first.runs[0]).toMatchObject({ text: 'Дата', bold: false, sizePx: 12 });
    expect(second.runs[0]).toMatchObject({ text: 'Заголовок', bold: true, sizePx: 16 });
  });

  it('выравнивание по центру и справа переносится абзацу', () => {
    const blocks = parseCardHtml('<div style="text-align:center;">Наряд</div><div style="text-align:right;">Утверждаю</div>');
    expect(blocks.map((b) => (b.kind === 'paragraph' ? b.align : null))).toEqual(['center', 'right']);
  });

  it('таблица собирается в шапку и тело, шапка жирная', () => {
    const blocks = parseCardHtml(NARYAD_HTML);
    const tables = blocks.filter((b) => b.kind === 'table');
    expect(tables).toHaveLength(2);
    const crew = tables[1] as { head: Array<Array<{ runs: Array<{ text: string }>; bold: boolean }>>; body: unknown[] };
    expect(crew.head[0]!.map((c) => c.runs[0]!.text)).toEqual(['Сотрудник', 'КТУ', 'Подпись']);
    expect(crew.head[0]!.every((c) => c.bold)).toBe(true);
    expect(crew.body).toHaveLength(1);
  });

  it('подписная линия (пустой span с нижней границей) становится подчёркнутым заполнителем', () => {
    const blocks = parseCardHtml('<div><span style="display:inline-block;width:160px;border-bottom:1px solid #0f172a;"></span>&nbsp;И.О. Фамилия</div>');
    const runs = (blocks[0] as { runs: Array<{ text: string; underline: boolean }> }).runs;
    expect(runs[0]).toMatchObject({ underline: true });
    expect(runs[0]!.text.trim()).toBe('');
    expect(runs[runs.length - 1]!.text).toContain('И.О. Фамилия');
  });

  it('незнакомые теги не ломают разбор — текст остаётся, тег отбрасывается', () => {
    const blocks = parseCardHtml('<div>Привет <b>цех</b> и <i>ОТК</i> <custom-tag>дальше</custom-tag></div>');
    const text = (blocks[0] as { runs: Array<{ text: string }> }).runs.map((r) => r.text).join(' ');
    expect(text).toContain('Привет');
    expect(text).toContain('цех');
    expect(text).toContain('дальше');
    expect(text).not.toContain('<');
  });

  it('пустая разметка не даёт блоков', () => {
    expect(parseCardHtml('')).toEqual([]);
    expect(parseCardHtml('<div>   </div>')).toEqual([]);
  });
});

describe('документ формы', () => {
  it('собирается из секций: тексты, таблицы и подписи доходят до Word', async () => {
    const buffer = await buildCardDocument({
      title: 'Наряд на сборку двигателя',
      fileBaseName: 'Наряд №12',
      sections: [
        { id: 'director', title: 'Гриф директора', html: NARYAD_PARTS[0], hideTitle: true },
        { id: 'title', title: 'Заголовок', html: NARYAD_PARTS[1], hideTitle: true },
      ],
    });
    const xml = await documentXml(buffer);
    expect(xml).toContain('Утверждаю');
    expect(xml).toContain('И.О. Фамилия');
    expect(xml).toContain('Наряд на сборку двигателя');
  });

  it('таблица приходит в документ со шапкой и ячейками, а документ не кончается таблицей', async () => {
    const buffer = await buildCardDocument({
      title: 'Наряд',
      fileBaseName: 'Наряд №12',
      sections: [
        {
          id: 'crew',
          title: 'Бригада и выплаты',
          html: '<table><thead><tr><th>Сотрудник</th><th>КТУ</th></tr></thead><tbody><tr><td>Иванов И.И.</td><td>1</td></tr></tbody></table>',
        },
      ],
    });
    const xml = await documentXml(buffer);
    expect(xml).toContain('Сотрудник');
    expect(xml).toContain('Иванов И.И.');
    expect(xml).toContain('w:tbl');
    const body = xml.slice(xml.indexOf('<w:body>'));
    // Документ, кончающийся таблицей, Word 2007 объявляет повреждённым: после неё обязан быть абзац.
    expect(body.lastIndexOf('<w:p')).toBeGreaterThan(body.lastIndexOf('</w:tbl>'));
  });

  it('заголовок секции печатается, когда он не скрыт', async () => {
    const buffer = await buildCardDocument({
      title: 'Наряд',
      fileBaseName: 'Наряд №12',
      sections: [{ id: 'works', title: 'Виды работ', html: '<div>Укладка вала</div>' }],
    });
    const xml = await documentXml(buffer);
    expect(xml).toContain('Виды работ');
  });

  it('управляющие символы вычищаются: Word объявляет такой файл повреждённым целиком', async () => {
    const buffer = await buildCardDocument({
      title: 'Наряд',
      fileBaseName: 'Наряд №12',
      sections: [{ id: 'meta', title: 'Реквизиты', html: '<div>до\u0007после</div>', hideTitle: true }],
    });
    const xml = await documentXml(buffer);
    expect(xml).toContain('допосле');
    // eslint-disable-next-line no-control-regex -- ровно эти символы и запрещены в XML
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)).toBe(false);
  });

  it('форма без секций собирается пустым документом, а не ошибкой', async () => {
    const buffer = await buildCardDocument({ title: 'Пусто', fileBaseName: 'Пусто', sections: [] });
    const xml = await documentXml(buffer);
    expect(xml).toContain('<w:body>');
  });
});
