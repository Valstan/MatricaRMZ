import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Выгрузка накладной расхода в Word (P5b-3, 19.10.2026): форма у печати и выгрузки одна —
// `buildIssueDocumentForm` (шапка, позиции, подписи). Печать — `openPrintPreview`, выгрузка —
// канал `exports:card`; заведи каждая свой сборщик HTML, файл и лист разошлись бы молча.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./StockDocumentDetailsPage.tsx');

function fn(from: string, to: string): string {
  const at = PAGE.indexOf(from);
  const end = PAGE.indexOf(to, at);
  expect(at, `«${from}» не найдена — сторож ослеп`).toBeGreaterThan(-1);
  expect(end, `конец «${from}» не найден — срез захватил бы пол-страницы`).toBeGreaterThan(at);
  return PAGE.slice(at, end);
}

describe('StockDocumentDetailsPage: выгрузка накладной в Word идёт той же формой, что печать', () => {
  const FORM = fn('function buildIssueDocumentForm', 'function printIssueDocument');
  const PRINT = fn('function printIssueDocument', 'async function exportIssueDocumentToWord');
  const EXPORT = fn('async function exportIssueDocumentToWord', 'const nomenclatureOptions');

  it('обе двери берут форму у одного сборщика', () => {
    expect(FORM, 'сборщик формы накладной перестал собирать основные реквизиты').toContain('const mainHtml = ');
    expect(FORM, 'сборщик формы накладной перестал собирать позиции').toContain('const linesHtml = ');
    expect(PRINT, 'печать накладной перестала брать общую форму').toContain('openPrintPreview(buildIssueDocumentForm())');
    expect(EXPORT, 'выгрузка накладной собирает форму своим путём — лист и файл разъедутся').toContain(
      'buildIssueDocumentForm()',
    );
    expect(EXPORT, 'выгрузка накладной больше не идёт каналом выгрузки').toContain('window.matrica.exports.card(');
  });

  it('заголовок листа печатается: без него ни бумага, ни файл Word не носят номера', () => {
    expect(
      FORM,
      'в форме накладной пропала секция заголовка — в окне печати h1 живёт в зоне .no-print, и лист с файлом останутся без номера документа',
    ).toContain("{ id: 'title', title: 'Заголовок', html: titleHtml, hideTitle: true }");
    expect(FORM, 'заголовок накладной перестал брать номер документа').toContain('${escapeHtml(title)}');
  });
});
