// Сторож розовой пометки утильных двигателей.
//
// Правило владельца (09.11.2026): «строка двигателя, который утильный, должна быть
// помечена розовым фоном во всех местах программы, в списках, в отчётах — как и в
// основном списке двигателей». Проверяем, что:
//  - цвет берётся из ОБЩЕГО правила (а не копируется литералом по файлам);
//  - отчёты о двигателях розовит утильные строки;
//  - список двигателей, веб-админка и очередь бирок держат один и тот же вид;
//  - печать списков умеет красить строку (движок печати — общий на все списки).
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
const TAG_QUEUE = read('../../components/EngineTagPrintDialog.tsx');
const PRINT_DIALOG = read('../../components/ListPrintDialog.tsx');

describe('розовая пометка утильного двигателя', () => {
  it('отчёт «Двигатели» розовит утильные строки', () => {
    expect(ENGINES_REPORT).toContain('engineScrapRowStyle(it.row.isScrap)');
  });

  it('отчёт «Сейчас на заводе» розовит утильные строки', () => {
    expect(AT_PLANT_REPORT).toContain('engineScrapRowStyle(it.row.isScrap)');
  });

  it('список двигателей, веб-админка и очередь бирок берут общее правило', () => {
    // Вид у всех трёх один: цвет живёт в `shared`, а не в файле экрана. Иначе пометки
    // снова разъедутся — так уже было с «Забракован» против «Признан утильным».
    expect(ENGINES_LIST).toContain('engineScrapRowStyle');
    expect(WEB_ADMIN_LIST).toContain('engineScrapRowStyle');
    expect(TAG_QUEUE).toContain('engineScrapRowStyle');
  });

  it('литерал цвета не копируется по файлам: берётся общее правило', () => {
    for (const src of [ENGINES_LIST, ENGINES_REPORT, AT_PLANT_REPORT, WEB_ADMIN_LIST]) {
      expect(src).not.toContain('rgba(239, 68, 68, 0.18)');
    }
  });

  it('печать списков красит строку: фон строки — общий в движке печати', () => {
    // Один пропс в движке печати покрывает ВСЕ списки; без него утильный двигатель
    // на бумаге выглядел бы как обычный.
    expect(PRINT_DIALOG).toContain('rowBackground');
  });
});
