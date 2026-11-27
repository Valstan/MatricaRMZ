import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REPAIR_STAGE_TEMPLATES,
  type RepairStageTemplate,
} from './repairStages.js';
import {
  repairStageCodeFromValue,
  repairStageLabel,
  repairStageList,
  repairStageValue,
  stageValueOf,
} from './repairStageList.js';

// ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ для этапов ремонта (промт КАРМАНА #181, пункт 4).
//
// Пока этапы собирались в трёх местах, подписи и порядок могли разойтись, а при офлайне
// один и тот же двигатель попадал бы в разные группы. Сторож стоит на СВОЙСТВА: ряд этапов
// един, дубли схлопываются, служебный этап не входит, офлайн и онлайн дают один ряд.

describe('ряд этапов ремонта — из одного источника', () => {
  it('без серверного шаблона берётся статичная линейка', () => {
    const list = repairStageList();
    // Служебного этапа в ряду нет — это отметка о заведении карточки, а не этап ремонта.
    const expected = DEFAULT_REPAIR_STAGE_TEMPLATES.filter((t) => t.code !== 'card_created').map((t) => t.code);
    expect(list.map((s) => s.code)).toEqual(expected);
    expect(list.find((s) => s.code === 'ukladka')?.label).toBe('Укладка вала');
  });

  it('серверный шаблон меняет название и приоритет, но не состав этапов', () => {
    const custom = [{ code: 'sborka', name: 'Сборка узла', sortOrder: 50 }] as unknown as RepairStageTemplate[];
    const list = repairStageList(custom);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: 'sborka', label: 'Сборка узла', sortOrder: 50 });
  });

  it('каждый этап встречается РОВНО ОДИН РАЗ — дубль в справочнике не двоит этап', () => {
    // Справочник на сервере может отдать две строки одного кода (переименование этапа).
    const custom = [
      { code: 'sborka', name: 'Сборка двигателя', sortOrder: 50 },
      { code: 'sborka', name: 'Сборка двигателя (старое имя)', sortOrder: 50 },
    ] as unknown as RepairStageTemplate[];
    const list = repairStageList(custom);
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe('Сборка двигателя');
  });

  it('служебный этап (заведение карточки) в ряд не попадает', () => {
    const list = repairStageList();
    expect(list.some((s) => s.code === 'card_created')).toBe(false);
    expect(repairStageValue('card_created')).toBeNull();
    expect(stageValueOf('card_created')).toBeNull();
  });

  it('боковая ветка (утиль/брак) — в конце, как в порядке групп отчёта', () => {
    const list = repairStageList();
    expect(list[list.length - 1]?.code).toBe('scrap_branch');
  });

  it('офлайн и онлайн дают один и тот же ряд подписей', () => {
    // Онлайн: серверный шаблон со всеми кодами. Офлайн: статичная линейка.
    const online = repairStageList(DEFAULT_REPAIR_STAGE_TEMPLATES as unknown as RepairStageTemplate[]);
    const offline = repairStageList();
    expect(online.map((s) => s.code)).toEqual(offline.map((s) => s.code));
    expect(online.map((s) => s.label)).toEqual(offline.map((s) => s.label));
  });

  it('значения ступеней разных вопросов не путаются', () => {
    // «История» — этап проходил когда-то (`stage:`), «Этап ремонта» — сейчас (`repair:`).
    expect(stageValueOf('ukladka')).toBe('stage:ukladka');
    expect(repairStageValue('ukladka')).toBe('repair:ukladka');
    expect(repairStageCodeFromValue('stage:ukladka')).toBe('ukladka');
    expect(repairStageCodeFromValue('repair:ukladka')).toBe('ukladka');
    expect(repairStageCodeFromValue('none')).toBeNull();
  });

  it('подпись этапа — по тому же ряду, а не по случаю', () => {
    expect(repairStageLabel('ukladka')).toBe('Укладка вала');
    expect(repairStageLabel('card_created')).toBeNull();
  });
});
