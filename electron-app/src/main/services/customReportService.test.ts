import { describe, expect, it, vi } from 'vitest';

// Модуль тянет BrowserWindow ради печати PDF; для проверки списка источников окно не нужно.
vi.mock('electron', () => ({ BrowserWindow: class {} }));

import { listCustomReportSources } from './customReportService.js';

describe('listCustomReportSources', () => {
  // Ровно тот дефект, что жил в проде: пресет `engines_list` объединили в `engines` (#647),
  // определения под старым id не осталось, и фолбэк `?? id` печатал оператору служебный код
  // в выпадающем списке источников «Моих отчётов».
  it('ни один источник не подписан своим служебным кодом', () => {
    const echoed = listCustomReportSources().filter((s) => s.title === s.presetId);
    expect(echoed).toEqual([]);
  });

  it('объединённый источник подписан названием канонического пресета', () => {
    const legacy = listCustomReportSources().find((s) => s.presetId === 'engines_list');
    expect(legacy?.title).toBe('Двигатели');
  });
});
