import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Печатная форма табеля в Word (P5b-3, 19.10.2026): у выгрузки и печати ОДИН сборщик секций
// (`printParts` -> `buildTimesheetPrintSections`, те же настройки, вариант и блоки). Заведи
// выгрузка свой — формы начнут расходиться понемногу, и чинить придётся дважды; у списков это
// уже случалось (второй сборщик печати разъезжался с листом, P5a). Смоук видит файл на диске,
// но не увидит расхождения в геометрии строки-за-строкой, поэтому шов сторожится по исходнику.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./TimesheetGridPage.tsx');

function fn(from: string, to: string): string {
  const at = PAGE.indexOf(from);
  const end = PAGE.indexOf(to, at);
  expect(at, `«${from}» не найдена — сторож ослеп`).toBeGreaterThan(-1);
  expect(end, `конец «${from}» не найден — срез захватил бы пол-страницы`).toBeGreaterThan(at);
  return PAGE.slice(at, end);
}

describe('TimesheetGridPage: выгрузка табеля в Word идёт той же формой, что печать', () => {
  const EXPORT = fn('const exportTimesheetToWord', 'return (');
  const PRINT = fn('const doPrint =', 'const exportTimesheetToWord');

  it('выгрузка берёт секции у печати и сохраняет альбомный лист', () => {
    expect(EXPORT, 'секции табеля в выгрузке собирает не тот сборщик, что у печати — формы разъедутся').toContain(
      'printParts(settings, variant, blocks).sections',
    );
    expect(EXPORT, 'выгрузка табеля больше не идёт каналом выгрузки').toContain('window.matrica.exports.card(');
    expect(EXPORT, 'табель уехал в Word книжным листом — сетка дней не влезет').toContain(
      "orientation: 'landscape'",
    );
  });

  it('печать идёт тем же сборщиком', () => {
    expect(PRINT, 'печать табеля перестала брать лист у общего сборщика').toContain(
      'printSectionsDirect({ title: printTitle, ...printParts(',
    );
  });
});
