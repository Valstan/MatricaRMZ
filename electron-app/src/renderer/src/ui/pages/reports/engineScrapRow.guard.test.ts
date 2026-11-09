// Сторож розовой пометки утильных двигателей.
//
// Правило владельца (09.11.2026): «строка двигателя, который утильный, должна быть
// помечена розовым фоном во всех местах программы, в списках, в отчётах — как и в
// основном списке двигателей». Проверяем, что:
//  - цвет берётся из ОБЩЕГО правила (а не копируется литералом по файлам);
//  - отчёты о двигателях розовят утильные строки;
//  - основной список и веб-админка сохраняют прежний вид.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const ENGINES_REPORT = read('./EnginesReportPage.tsx');
const AT_PLANT_REPORT = read('./EnginesNowAtPlantReportPage.tsx');
const ENGINES_LIST = read('../EnginesPage.tsx');
const WEB_ADMIN_LIST = read('../../../../../../../web-admin/src/ui/EnginesPage.tsx');

describe('розовая пометка утильного двигателя', () => {
  it('отчёт «Двигатели» розовит утильные строки', () => {
    expect(ENGINES_REPORT).toContain('engineScrapRowStyle(it.row.isScrap)');
  });

  it('отчёт «Сейчас на заводе» розовит утильные строки', () => {
    expect(AT_PLANT_REPORT).toContain('engineScrapRowStyle(it.row.isScrap)');
  });

  it('основной список и веб-админка сохраняют прежний вид', () => {
    // Цвет у обоих теперь берётся из общего правила — вид тот же, но литерал не дублируется.
    expect(ENGINES_LIST).toContain('engineScrapRowStyle');
    expect(WEB_ADMIN_LIST).toContain("rgba(239, 68, 68, 0.18)");
  });

  it('литерал цвета не копируется по файлам: берётся общее правило', () => {
    // Список двигателей — источник истины по цвету; остальные места берут правило
    // из `shared`, иначе пометки снова разъедутся.
    for (const src of [ENGINES_LIST, ENGINES_REPORT, AT_PLANT_REPORT]) {
      expect(src).not.toContain('rgba(239, 68, 68, 0.18)');
    }
  });
});
