import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REPAIR_STAGE_TEMPLATES,
  findStageDateConflict,
  isStageBackwardMove,
  repairStageTemplate,
  sortStagesByDate,
} from './repairStages.js';

describe('шаблон этапов (состав 28.09.2026)', () => {
  it('линейка из 9 + боковая ветка, приоритеты строго растут', () => {
    expect(DEFAULT_REPAIR_STAGE_TEMPLATES).toHaveLength(10);
    const line = DEFAULT_REPAIR_STAGE_TEMPLATES.filter((t) => !t.sideBranch).map((t) => t.sortOrder);
    expect(line).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('«Вал» не этап, «Отправлен» и «Принят» — разные этапы', () => {
    const codes = DEFAULT_REPAIR_STAGE_TEMPLATES.map((t) => t.code);
    expect(codes).not.toContain('val');
    expect(codes).toContain('shipped');
    expect(codes).toContain('accepted');
  });

  it('дефектовка — этап-автомат (кнопка + вручную)', () => {
    expect(repairStageTemplate('disassembly_defect').autoFrom).toBe('defectAct');
  });

  it('обкатка — только вручную (шаг 8: создание строк закрыто, автомат мёртв)', () => {
    expect(repairStageTemplate('obkatka').autoFrom).toBeUndefined();
    expect(repairStageTemplate('kitting_done').autoFrom).toBe('kittingAct');
  });
});

describe('субординация дат', () => {
  it('ОТК раньше сборки — отказ с кодом сборки', () => {
    const stages = [{ code: 'sborka' as const, at: 100 }];
    expect(findStageDateConflict(stages, 'otk', 50)).toBe('sborka');
  });

  it('ОТК позже сборки — можно', () => {
    const stages = [{ code: 'sborka' as const, at: 100 }];
    expect(findStageDateConflict(stages, 'otk', 150)).toBeNull();
  });

  it('боковая ветка в порядке не участвует', () => {
    const stages = [{ code: 'scrap_branch' as const, at: 999 }];
    expect(findStageDateConflict(stages, 'otk', 10)).toBeNull();
    expect(findStageDateConflict([{ code: 'sborka' as const, at: 100 }], 'scrap_branch', 10)).toBeNull();
  });

  it('этапы без даты не участвуют', () => {
    expect(findStageDateConflict([{ code: 'sborka' as const, at: null }], 'otk', 10)).toBeNull();
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
