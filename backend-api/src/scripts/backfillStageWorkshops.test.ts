import { describe, expect, it } from 'vitest';

import { buildWorkshopIndex, decideStageWorkshop, type WorkshopDir } from './backfillStageWorkshops.js';

// workshops:backfill-stage-workshops — предикат простановки цеха: сборка → код '1',
// обкатка → код '2', legacy-текст → uuid, снимок имени добивается. БД не трогаем.

const DIR: WorkshopDir[] = [
  { id: '11111111-1111-1111-1111-111111111111', code: '1', name: 'Цех № 1' },
  { id: '22222222-2222-2222-2222-222222222222', code: '2', name: 'Цех № 2' },
];

function dir() {
  const byId = new Map(DIR.map((w) => [w.id.toLowerCase(), w]));
  const byCode = new Map(DIR.map((w) => [w.code, w]));
  return { byId, byText: buildWorkshopIndex(DIR), byCode };
}

describe('decideStageWorkshop', () => {
  it('пустой цех сборки и обкатки — проставить по правилу', () => {
    expect(decideStageWorkshop({ code: 'sborka', workshopId: '', workshopName: '' }, dir())).toEqual({
      action: 'fill',
      workshopId: DIR[0]!.id,
      workshopName: 'Цех № 1',
    });
    expect(decideStageWorkshop({ code: 'OBKATKA', workshopId: '', workshopName: '' }, dir())).toEqual({
      action: 'fill',
      workshopId: DIR[1]!.id,
      workshopName: 'Цех № 2',
    });
  });

  it('пустой цех другого этапа — без правила, не трогаем', () => {
    expect(decideStageWorkshop({ code: 'ukladka', workshopId: '', workshopName: '' }, dir())).toEqual({
      action: 'skip-no-rule',
      code: 'ukladka',
    });
    expect(decideStageWorkshop({ code: '', workshopId: '', workshopName: '' }, dir())).toEqual({ action: 'skip-not-stage' });
  });

  it('uuid из справочника — ок; имя добивается, верное не трогается', () => {
    expect(decideStageWorkshop({ code: 'sborka', workshopId: DIR[0]!.id, workshopName: 'Цех № 1' }, dir())).toEqual({
      action: 'skip-has-workshop',
    });
    expect(decideStageWorkshop({ code: 'sborka', workshopId: DIR[0]!.id, workshopName: '' }, dir())).toEqual({
      action: 'name-fill',
      workshopName: 'Цех № 1',
    });
  });

  it('legacy-текст нормализуется в uuid: «Цех №1», «цех 2», код', () => {
    expect(decideStageWorkshop({ code: 'sborka', workshopId: 'Цех №1', workshopName: '' }, dir())).toEqual({
      action: 'normalize',
      workshopId: DIR[0]!.id,
      workshopName: 'Цех № 1',
    });
    expect(decideStageWorkshop({ code: 'obkatka', workshopId: 'цех 2', workshopName: '' }, dir())).toEqual({
      action: 'normalize',
      workshopId: DIR[1]!.id,
      workshopName: 'Цех № 2',
    });
    expect(decideStageWorkshop({ code: 'sborka', workshopId: '2', workshopName: '' }, dir())).toEqual({
      action: 'normalize',
      workshopId: DIR[1]!.id,
      workshopName: 'Цех № 2',
    });
  });

  it('неопознанный текст — список руками, не трогаем', () => {
    expect(decideStageWorkshop({ code: 'sborka', workshopId: 'какой-то цех', workshopName: '' }, dir())).toEqual({
      action: 'unmatched',
      workshopId: 'какой-то цех',
    });
  });
});
