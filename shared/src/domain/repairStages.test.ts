import { describe, expect, it } from 'vitest';

import {
  currentDatedStage,
  DEFAULT_REPAIR_STAGE_TEMPLATES,
  findStageDateConflict,
  isBulkStageCandidate,
  isStageBackwardMove,
  repairStageRank,
  repairStageTemplate,
  resolveStageCode,
  sortStagesByDate,
} from './repairStages.js';

describe('шаблон этапов (состав 05.10.2026)', () => {
  it('линейка из 9 + боковая ветка, приоритеты строго растут', () => {
    expect(DEFAULT_REPAIR_STAGE_TEMPLATES).toHaveLength(10);
    const line = DEFAULT_REPAIR_STAGE_TEMPLATES.filter((t) => !t.sideBranch).map((t) => t.sortOrder);
    expect(line).toEqual([5, 10, 20, 40, 50, 60, 70, 80, 90]);
  });

  it('«Вал» не этап, «Отгрузка» и «Приемка заказчиком» — разные этапы', () => {
    const codes = DEFAULT_REPAIR_STAGE_TEMPLATES.map((t) => t.code);
    expect(codes).not.toContain('val');
    expect(codes).toContain('shipped');
    expect(codes).toContain('accepted');
  });

  it('kitting_done снесён слиянием в arrival — в реестре его нет', () => {
    const codes = DEFAULT_REPAIR_STAGE_TEMPLATES.map((t) => t.code);
    expect(codes).not.toContain('kitting_done');
    expect(codes).toContain('arrival');
    expect(codes).toContain('card_created');
  });

  it('дефектовка — этап-автомат (кнопка + вручную)', () => {
    expect(repairStageTemplate('disassembly_defect').autoFrom).toBe('defectAct');
  });

  it('приемка — этап-автомат акта комплектности (бывший kitting_done)', () => {
    expect(repairStageTemplate('arrival').autoFrom).toBe('kittingAct');
  });

  it('обкатка и карточка — только вручную', () => {
    expect(repairStageTemplate('obkatka').autoFrom).toBeUndefined();
    expect(repairStageTemplate('card_created').autoFrom).toBeUndefined();
  });

  it('имена линейки — по таблице этапов 05.10 (единый источник)', () => {
    const names = new Map(DEFAULT_REPAIR_STAGE_TEMPLATES.map((t) => [t.code, t.name]));
    expect(names.get('card_created')).toBe('Создание карточки двигателя');
    expect(names.get('arrival')).toBe('Приемка двигателя на завод');
    expect(names.get('disassembly_defect')).toBe('Разборка/Дефектовка');
    expect(names.get('ukladka')).toBe('Укладка вала');
    expect(names.get('sborka')).toBe('Сборка двигателя');
    expect(names.get('obkatka')).toBe('Обкатка двигателя');
    expect(names.get('shipped')).toBe('Отгрузка двигателя заказчику');
    expect(names.get('accepted')).toBe('Приемка двигателя заказчиком');
  });
});

describe('снесённые коды читаются как преемники (до миграции строк)', () => {
  it('kitting_done резолвится в arrival везде', () => {
    expect(resolveStageCode('kitting_done')).toBe('arrival');
    expect(resolveStageCode('KITTING_DONE')).toBe('arrival');
    expect(repairStageRank('kitting_done')).toBe(10);
    expect(repairStageTemplate('kitting_done').code).toBe('arrival');
  });

  it('субординация не бросает на старых строках', () => {
    const DAY1 = Date.UTC(2026, 8, 28);
    const stages = [{ code: 'kitting_done' as never, at: DAY1 }];
    expect(findStageDateConflict(stages, 'otk', DAY1 - 86_400_000)).toBe('kitting_done');
    expect(isStageBackwardMove(stages, 'sborka')).toBe(false);
  });
});

describe('текущее место — последний этап по времени (день, внутри дня — приоритет)', () => {
  const DAY1 = Date.UTC(2026, 8, 27, 21, 0, 0);
  const DAY2 = Date.UTC(2026, 8, 28, 21, 0, 0);
  it('побеждает позднейший день, прошлое обнуляется', () => {
    const rows = [
      { code: 'obkatka', at: DAY1 },
      { code: 'sborka', at: DAY2 },
    ];
    expect(currentDatedStage(rows)).toEqual({ code: 'sborka', at: DAY2 });
  });

  it('внутри одного дня время не различаем — побеждает приоритет', () => {
    const rows = [
      { code: 'card_created', at: DAY1 + 54_000_000 },
      { code: 'arrival', at: DAY1 },
    ];
    expect(currentDatedStage(rows)).toEqual({ code: 'arrival', at: DAY1 });
  });

  it('при равной секунде — больший приоритет', () => {
    const rows = [
      { code: 'otk', at: 100 },
      { code: 'sborka', at: 100 },
    ];
    expect(currentDatedStage(rows)).toEqual({ code: 'otk', at: 100 });
  });

  it('бездатые и пусто — места нет', () => {
    expect(currentDatedStage([{ code: 'sborka', at: null }])).toBeNull();
    expect(currentDatedStage([])).toBeNull();
  });

  it('старая строка kitting_done читается как приемка', () => {
    const rows = [{ code: 'kitting_done', at: 50 }];
    expect(currentDatedStage(rows)).toEqual({ code: 'arrival', at: 50 });
  });
});

describe('субординация дат (сравнение по дням, Москва)', () => {
  // Полночь UTC — это 03:00 МСК тех же суток; константы выбраны с запасом,
  // чтобы полночь/вечер точно лежали в нужных московских сутках.
  const DAY1 = Date.UTC(2026, 8, 27, 21, 0, 0);
  const DAY2 = Date.UTC(2026, 8, 28, 21, 0, 0);
  const DAY1_LATE = Date.UTC(2026, 8, 28, 17, 0, 0);
  it('ОТК днём раньше сборки — отказ с кодом сборки', () => {
    const stages = [{ code: 'sborka' as const, at: DAY2 }];
    expect(findStageDateConflict(stages, 'otk', DAY1)).toBe('sborka');
  });

  it('ОТК позже сборки — можно', () => {
    const stages = [{ code: 'sborka' as const, at: DAY1 }];
    expect(findStageDateConflict(stages, 'otk', DAY2)).toBeNull();
  });

  it('внутри одного дня время не различаем (полночь vs момент нажатия — не нарушение)', () => {
    const stages = [{ code: 'sborka' as const, at: DAY1_LATE }];
    expect(findStageDateConflict(stages, 'otk', DAY1)).toBeNull();
    expect(findStageDateConflict(stages, 'card_created', DAY1)).toBeNull();
  });

  it('боковая ветка в порядке не участвует', () => {
    const stages = [{ code: 'scrap_branch' as const, at: DAY2 }];
    expect(findStageDateConflict(stages, 'otk', DAY1)).toBeNull();
    expect(findStageDateConflict([{ code: 'sborka' as const, at: DAY1 }], 'scrap_branch', DAY1)).toBeNull();
  });

  it('этапы без даты не участвуют', () => {
    expect(findStageDateConflict([{ code: 'sborka' as const, at: null }], 'otk', DAY2)).toBeNull();
  });
});

describe('возврат назад', () => {
  it('сборка после обкатки — возврат', () => {
    const stages = [{ code: 'obkatka' as const, at: 100 }];
    expect(isStageBackwardMove(stages, 'sborka')).toBe(true);
  });

  it('обкатка после сборки — вперёд', () => {
    const stages = [{ code: 'sborka' as const, at: 100 }];
    expect(isStageBackwardMove(stages, 'obkatka')).toBe(false);
  });

  it('боковая ветка возвратом не считается', () => {
    expect(isStageBackwardMove([{ code: 'obkatka' as const, at: 100 }], 'scrap_branch')).toBe(false);
  });

  it('поздно внесённый этап с ранней датой — не возврат (баг 09.10.2026)', () => {
    const DAY1 = Date.UTC(2026, 8, 27, 21, 0, 0);
    const DAY2 = Date.UTC(2026, 8, 28, 21, 0, 0);
    const stages = [{ code: 'shipped' as const, at: DAY2 }];
    expect(isStageBackwardMove(stages, 'sborka', DAY1)).toBe(false);
  });

  it('тот же день ниже по линейке — по-прежнему возврат', () => {
    const DAY1 = Date.UTC(2026, 8, 27, 21, 0, 0);
    const stages = [{ code: 'obkatka' as const, at: DAY1 }];
    expect(isStageBackwardMove(stages, 'sborka', DAY1)).toBe(true);
  });

  it('без даты новой строки — старое поведение по рангам', () => {
    const stages = [{ code: 'obkatka' as const, at: 100 }];
    expect(isStageBackwardMove(stages, 'sborka')).toBe(true);
  });
});

describe('сортировка для показа', () => {
  it('по датам друг за дружкой, бездатые в конце', () => {
    const stages = [
      { code: 'otk' as const, at: 300 },
      { code: 'sborka' as const, at: null },
      { code: 'arrival' as const, at: 100 },
    ];
    expect(sortStagesByDate(stages).map((s) => s.code)).toEqual(['arrival', 'otk', 'sborka']);
  });
});

describe('кандидат массового добавления (владелец 01.10.2026)', () => {
  const base = { atPlant: true, hasScrapBranch: false, lastRank: 30, selectedRank: 60 };
  it('на заводе на предыдущем этапе — кандидат', () => {
    expect(isBulkStageCandidate(base)).toBe(true);
  });
  it('без этапов, но на заводе — кандидат', () => {
    expect(isBulkStageCandidate({ ...base, lastRank: null })).toBe(true);
  });
  it('не на заводе (уехал / не приходил) — скрыт', () => {
    expect(isBulkStageCandidate({ ...base, atPlant: false })).toBe(false);
  });
  it('боковая ветка утиля — скрыта', () => {
    expect(isBulkStageCandidate({ ...base, hasScrapBranch: true })).toBe(false);
  });
  it('на этом же или более высоком этапе — скрыт', () => {
    expect(isBulkStageCandidate({ ...base, lastRank: 60 })).toBe(false);
    expect(isBulkStageCandidate({ ...base, lastRank: 90 })).toBe(false);
  });
  it('ранг вне линейки (0) — не «ниже», а «мимо», скрыт', () => {
    expect(isBulkStageCandidate({ ...base, lastRank: 0 })).toBe(false);
  });
  it('этап не выбран — не кандидат', () => {
    expect(isBulkStageCandidate({ ...base, selectedRank: 0 })).toBe(false);
  });
});
