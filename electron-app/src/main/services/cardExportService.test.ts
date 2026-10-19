import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import type { RepairFundInstancePayload } from '@matricarmz/shared';

import { buildEngineRequirementHtml } from '../../renderer/src/ui/utils/engineInventoryPrintHtml.js';
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

describe('целый печатный лист акта', () => {
  const ACT_DOCUMENT = [
    '<!doctype html><html><head><meta charset="utf-8"/><title>Акт комплектности двигателя</title>',
    '<style>body { font-family: Arial; font-size: 12px; } th { background: #eee; } .sig-line { border-bottom: 1px solid #000; }</style>',
    '</head><body><div class="no-print"><button id="printBtn">Печать / PDF</button></div>',
    '<script>var btn = document.getElementById("printBtn");</script>',
    '<h1>Акт комплектности двигателя</h1>',
    '<div><span class="hdr-label" style="font-weight:700">Марка двигателя:</span> 6ЧН 21/21</div>',
    '<table><thead><tr><th style="width:34%">Наименование детали (узла)</th><th style="width:18%">№ сборочной единицы</th>' +
      '<th style="width:14%">№ на детали</th><th style="width:10%">План</th><th style="width:10%">Наличие</th>' +
      '<th style="width:14%">Фактически принято</th></tr></thead>' +
      '<tbody><tr><td>Поршень</td><td>03</td><td>П-123</td><td class="num">6</td><td class="ctr">да</td><td class="num">6</td></tr>' +
      '<tr><td colspan="6" class="muted ctr">Нет данных</td></tr></tbody></table>',
    '<div class="sig"><div class="sig-row">Подпись: <span class="sig-line" style="border-bottom:1px solid #111827"></span></div></div>',
    '<div class="meta">Договор / заказчик: ДГ-12&nbsp;филиал</div>',
    '</body></html>',
  ].join('');

  it('содержимое style/head/title/script/button не попадает в документ: приходит целый лист', () => {
    const blocks = parseCardHtml(ACT_DOCUMENT);
    const text = JSON.stringify(blocks);
    expect(text).not.toContain('font-family');
    expect(text).not.toContain('printBtn');
    expect(text).not.toContain('Печать / PDF');
    // Заголовок акта из <h1> остаётся: он и есть содержимое формы.
    expect((blocks[0] as { kind: string }).kind).toBe('paragraph');
  });

  it('заголовок акта получает кегль и центр, даже когда форма задала их классом', () => {
    const blocks = parseCardHtml('<h1>Акт комплектности двигателя</h1>');
    const first = blocks[0] as { align: string; bold: boolean; sizePx: number | null };
    expect(first).toMatchObject({ align: 'center', bold: true, sizePx: 17 });
  });

  it('ширины колонок приходят из процентов формы, а недостающие колонки делят остаток', () => {
    const blocks = parseCardHtml(
      '<table><thead><tr><th style="width:34%">A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    expect((blocks[0] as { widths: number[] }).widths).toEqual([34, 66]);
  });

  it('таблица без объявленных ширин остаётся на автораскладке', () => {
    const blocks = parseCardHtml('<table><thead><tr><th>A</th><th>B</th></tr></thead></table>');
    expect((blocks[0] as { widths: number[] }).widths).toEqual([]);
  });

  it('ячейки с colspan собираются в одну, числа и центры — по классовым подсказкам', () => {
    const blocks = parseCardHtml(
      '<table><tbody><tr><td>a</td><td class="num">1</td><td class="ctr">да</td></tr>' +
        '<tr><td colspan="3">Нет данных</td></tr></tbody></table>',
    );
    const body = (blocks[0] as { body: Array<Array<{ colspan: number; align: string | null }>> }).body;
    expect(body[0]![1]).toMatchObject({ align: 'right' });
    expect(body[0]![2]).toMatchObject({ align: 'center' });
    expect(body[1]![0]!.colspan).toBe(3);
  });

  it('подписная линия появляется только у пустого span — значение в строке не дублируется линией', () => {
    const filled = parseCardHtml('<div><span style="border-bottom:1px solid #000">Кузнецов И.И.</span></div>');
    const runs = (filled[0] as { runs: Array<{ text: string }> }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe('Кузнецов И.И.');
  });

  it('сущности разворачиваются символами: escapeHtml печатной формы пишет их прямо в тексте', () => {
    const blocks = parseCardHtml('<div>Договор: ДГ-12&nbsp;филиал&#39;;</div>');
    const runs = (blocks[0] as { runs: Array<{ text: string }> }).runs;
    expect(runs.map((r) => r.text).join('')).toBe('Договор: ДГ-12' + String.fromCharCode(160) + "филиал';");
  });

  it('целый лист акта уходит в Word: заголовок, таблица с ширинами и линии для росписи на месте', async () => {
    const buffer = await buildCardDocument({
      title: 'Акт комплектности',
      fileBaseName: 'Акт комплектности 6ЧН 21/21 Д-001',
      sections: [{ id: 'act', title: 'Акт комплектности', html: ACT_DOCUMENT, hideTitle: true }],
    });
    const xml = await documentXml(buffer);
    expect(xml).toContain('Акт комплектности двигателя');
    expect(xml).toContain('Поршень');
    expect(xml).toContain('Нет данных');
    // Пропорции листа держатся жёстко, а не «на усмотрение Word».
    expect(xml).toContain('<w:gridCol');
    expect(xml).toContain('<w:gridSpan w:val="6"');
    expect(xml).toContain('w:tblLayout w:type="fixed"');
    // Подписная линия — подчёркнутые неразрывные пробелы.
    expect(xml).toContain(String.fromCharCode(160).repeat(20));
    expect(xml).not.toContain('font-family');
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

// Дверь «Требование в Word» (P5b-2) ходит тем же каналом, что акты, но её форма собирается
// другим сборщиком. На стенде кнопка скрыта (нет номерных деталей в утиль/замене), поэтому
// смоук этот путь не тронет — а форма живая, и она обязана доехать до Word без сюрпризов.
describe('форма требования к заказчику', () => {
  const INSTANCES: RepairFundInstancePayload[] = [
    {
      kind: 'repair_fund_instance',
      engineEntityId: 'engine-1',
      nomenclatureId: 'nom-1',
      partId: 'part-1',
      partLabel: 'Гильза цилиндровая',
      stampedNumber: '42',
      classification: 'scrap',
      status: 'scrapped',
      capturedAt: 1750000000000,
      capturedBy: 'owner1',
    },
    {
      kind: 'repair_fund_instance',
      engineEntityId: 'engine-1',
      nomenclatureId: 'nom-2',
      partId: 'part-2',
      partLabel: 'Поршень',
      stampedNumber: '43',
      classification: 'replace',
      status: 'replaced',
      capturedAt: 1750000000001,
      capturedBy: 'owner1',
    },
    {
      kind: 'repair_fund_instance',
      engineEntityId: 'engine-1',
      nomenclatureId: 'nom-3',
      partId: 'part-3',
      partLabel: 'Клапан впускной',
      stampedNumber: '44',
      classification: 'repairable',
      status: 'in_fund',
      capturedAt: 1750000000002,
      capturedBy: 'owner1',
    },
  ];

  it('требование доезжает до Word: перечень утиль/замен, пропорции и чистый текст', async () => {
    const html = buildEngineRequirementHtml({
      engineBrand: 'TEST-BRAND',
      engineNumber: 'TEST-001',
      contractNumber: 'Д-12',
      instances: INSTANCES,
    });
    const buffer = await buildCardDocument({
      title: 'Требование к заказчику',
      fileBaseName: 'Требование TEST-001',
      sections: [{ id: 'requirement', title: 'Требование к заказчику', html, hideTitle: true }],
    });
    const xml = await documentXml(buffer);
    expect(xml).toContain('Требование к заказчику');
    expect(xml).toContain('Личный № детали');
    expect(xml).toContain('Гильза цилиндровая');
    expect(xml).toContain('Поршень');
    expect(xml).toContain('утиль');
    expect(xml).toContain('замена');
    // Ремонтопригодная деталь в требование не входит — обоснование роста цены только по выведенным.
    expect(xml).not.toContain('Клапан впускной');
    expect(xml).toContain('<w:gridCol');
    expect(xml).toContain('w:tblLayout w:type="fixed"');
    expect(xml).not.toContain('font-family');
    // eslint-disable-next-line no-control-regex -- ровно эти символы и запрещены в XML
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)).toBe(false);
  });
});
