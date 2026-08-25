import { describe, expect, it } from 'vitest';

import { docxXmlToText } from './docxText.js';

/** Минимальный кусок word/document.xml: один абзац с одним run'ом. */
function para(inner: string): string {
  return `<w:p><w:r>${inner}</w:r></w:p>`;
}

describe('docxXmlToText', () => {
  it('extracts text of a single paragraph', () => {
    expect(docxXmlToText(para('<w:t>Трещина по корпусу</w:t>'))).toBe('Трещина по корпусу');
  });

  it('joins runs inside one paragraph without a separator', () => {
    const xml = '<w:p><w:r><w:t>Трещина </w:t></w:r><w:r><w:t>по корпусу</w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('Трещина по корпусу');
  });

  it('puts each paragraph on its own line', () => {
    const xml = `${para('<w:t>Первая строка</w:t>')}${para('<w:t>Вторая строка</w:t>')}`;
    expect(docxXmlToText(xml)).toBe('Первая строка\nВторая строка');
  });

  it('keeps an empty paragraph as an empty line between texts', () => {
    const xml = `${para('<w:t>До</w:t>')}<w:p/>${para('<w:t>После</w:t>')}`;
    expect(docxXmlToText(xml)).toBe('До\n\nПосле');
  });

  it('turns w:tab into a tab and w:br into a line break', () => {
    const xml = para('<w:t>Поз.</w:t><w:tab/><w:t>1</w:t><w:br/><w:t>Поз.</w:t><w:tab/><w:t>2</w:t>');
    expect(docxXmlToText(xml)).toBe('Поз.\t1\nПоз.\t2');
  });

  it('ignores markup that carries no text', () => {
    const xml = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Акт</w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('Акт');
  });

  it('decodes xml entities', () => {
    expect(docxXmlToText(para('<w:t>Вал &amp; шестерня &lt;в сборе&gt;</w:t>'))).toBe(
      'Вал & шестерня <в сборе>',
    );
    expect(docxXmlToText(para('<w:t>&quot;Ремонт&quot; &apos;узла&apos;</w:t>'))).toBe(
      '"Ремонт" \'узла\'',
    );
    expect(docxXmlToText(para('<w:t>&#1040;&#x41;</w:t>'))).toBe('АA');
  });

  it('preserves significant spaces marked with xml:space', () => {
    const xml = '<w:p><w:r><w:t xml:space="preserve">Зазор </w:t></w:r><w:r><w:t>0,15</w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('Зазор 0,15');
  });

  it('reads text from table cells as separate lines', () => {
    const xml =
      '<w:tbl><w:tr><w:tc>' +
      para('<w:t>Деталь</w:t>') +
      '</w:tc><w:tc>' +
      para('<w:t>Износ</w:t>') +
      '</w:tc></w:tr></w:tbl>';
    expect(docxXmlToText(xml)).toBe('Деталь\nИзнос');
  });

  it('trims leading and trailing blank lines', () => {
    const xml = `<w:p/><w:p/>${para('<w:t>Единственная строка</w:t>')}<w:p/>`;
    expect(docxXmlToText(xml)).toBe('Единственная строка');
  });

  it('drops a carriage return so the result is line-feed only', () => {
    expect(docxXmlToText(para('<w:t>А\r\nБ</w:t>'))).toBe('А\nБ');
  });

  it('returns an empty string for markup without any text', () => {
    expect(docxXmlToText('<w:body><w:sectPr/></w:body>')).toBe('');
    expect(docxXmlToText('')).toBe('');
  });

  it('does not leak field codes into the text', () => {
    const xml = para('<w:instrText>PAGE \\* MERGEFORMAT</w:instrText><w:t>Стр.</w:t>');
    expect(docxXmlToText(xml)).toBe('Стр.');
  });
});
