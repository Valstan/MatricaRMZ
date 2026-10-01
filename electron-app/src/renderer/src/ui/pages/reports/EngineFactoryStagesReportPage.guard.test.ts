import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, './EngineFactoryStagesReportPage.tsx'), 'utf-8');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BOOT = readFileSync('D:/valstan/REPO/MatricaRMZ/android-app/src/core/boot.ts', 'utf-8');

describe('PR-G: отчёт «Двигатели на заводе» + Android-синк', () => {
  it('отчёт не имеет дублирующихся колонок «Последнее событие» / «Дата события»', () => {
    expect(PAGE).not.toContain('Последнее событие');
    expect(PAGE).not.toContain('Дата события');
    // Поля lastHistoryAction/lastHistoryAt остаются в поиске (useListDeepFilter)
    expect(PAGE).toContain('lastHistoryAction');
  });

  it('отчёт сохраняет колонку «Последний этап работ»', () => {
    expect(PAGE).toContain('Последний этап работ');
    expect(PAGE).toContain('lastSheetNode');
  });

  it('Android: интервал автосинка уменьшен до 15 секунд', () => {
    expect(BOOT).toContain('startAuto(15_000)');
  });
});
