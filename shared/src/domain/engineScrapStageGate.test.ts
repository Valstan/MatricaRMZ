import { describe, expect, it } from 'vitest';

import {
  evaluateScrapStageGate,
  findScrapStageInconsistencies,
  isScrapGateRepairStage,
  isScrapInCurrentTrip,
  isScrapStageStateConsistent,
  SCRAP_GATE_REPAIR_STAGE_CODES,
  SCRAP_PART_HINT,
  type EngineScrapGateState,
} from './engineScrapStageGate.js';

const DAY = 86_400_000;

/** Состояние утильного двигателя: статус карточки «Признан утильным» с датой. */
function scrapState(over: Partial<EngineScrapGateState> = {}): EngineScrapGateState {
  return {
    isScrap: true,
    scrapAt: 10 * DAY,
    partLabel: 'Картер',
    partId: 'part-1',
    scrapPartLabels: ['Картер'],
    engineNumber: 'Д-001',
    ...over,
  };
}

describe('гейт утиля: какие этапы он держит', () => {
  it('ремонтный цикл — от «Ремонт деталей» до выходного контроля', () => {
    expect([...SCRAP_GATE_REPAIR_STAGE_CODES]).toEqual([
      'parts_repair',
      'ukladka',
      'faza',
      'sborka',
      'obkatka',
      'otk',
    ]);
  });

  it('приёмка, разборка и отгрузка гейтом не держатся', () => {
    for (const code of ['card_created', 'arrival', 'arrival_reclamation', 'incoming_otk', 'disassembly_defect', 'shipped', 'accepted']) {
      expect(isScrapGateRepairStage(code)).toBe(false);
    }
  });
});

describe('гейт утиля: решение', () => {
  it('у утильного двигателя этап ремонта не заводится', () => {
    const decision = evaluateScrapStageGate({
      state: scrapState(),
      stageCode: 'ukladka',
      stageName: 'Укладка вала',
      currentVisitFrom: 5 * DAY,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.partLabel).toBe('Картер');
      expect(decision.engineNumber).toBe('Д-001');
      expect(decision.stageName).toBe('Укладка вала');
      expect(decision.error).toContain('Картер');
    }
  });

  it('у неутильного двигателя этап заводится', () => {
    const decision = evaluateScrapStageGate({
      state: scrapState({ isScrap: false, scrapAt: null, scrapPartLabels: [] }),
      stageCode: 'ukladka',
      stageName: 'Укладка вала',
      currentVisitFrom: 5 * DAY,
    });
    expect(decision).toEqual({ blocked: false, hint: null });
  });

  it('неглавная утильная деталь не держит этап, но подсказка видна', () => {
    // Маслонасос ушёл в утиль, но критерием утиля не является — двигатель не утильный.
    const decision = evaluateScrapStageGate({
      state: scrapState({ isScrap: false, scrapAt: null, partLabel: 'Маслонасос', scrapPartLabels: ['Маслонасос'] }),
      stageCode: 'obkatka',
      stageName: 'Обкатка двигателя',
      currentVisitFrom: 5 * DAY,
    });
    expect(decision.blocked).toBe(false);
    expect(decision.hint).toBe(SCRAP_PART_HINT);
  });

  it('неремонтный этап гейтом не держится даже у утильного двигателя', () => {
    const decision = evaluateScrapStageGate({
      state: scrapState(),
      stageCode: 'arrival',
      stageName: 'Приемка двигателя на завод',
      currentVisitFrom: 5 * DAY,
    });
    expect(decision).toEqual({ blocked: false, hint: null });
  });
});

describe('гейт утиля: текущий заезд', () => {
  it('утиль текущего заезда держит этап', () => {
    expect(isScrapInCurrentTrip(10 * DAY, 5 * DAY)).toBe(true);
  });

  it('утиль прошлого заезда текущую работу не держит', () => {
    // Движок утилили в первом заезде, потом вернулся — второй заезд ремонтируется.
    expect(isScrapInCurrentTrip(3 * DAY, 5 * DAY)).toBe(false);
  });

  it('неизвестные даты считаются текущим заездом — лучше перестраховаться', () => {
    expect(isScrapInCurrentTrip(null, 5 * DAY)).toBe(true);
    expect(isScrapInCurrentTrip(10 * DAY, null)).toBe(true);
  });

  it('двигатель с утилём текущего заезда и этапами прошлых заездов — этап заводится', () => {
    // Утиль от 10-го дня (текущий заезд начался 5-го), этапы прошлого заезда — до него.
    const decision = evaluateScrapStageGate({
      state: scrapState({ scrapAt: 10 * DAY }),
      stageCode: 'sborka',
      stageName: 'Сборка двигателя',
      currentVisitFrom: 5 * DAY,
    });
    expect(decision.blocked).toBe(true);
  });

  it('утиль прошлого заезда при возврате двигателя этап не держит', () => {
    const decision = evaluateScrapStageGate({
      state: scrapState({ scrapAt: 3 * DAY }),
      stageCode: 'sborka',
      stageName: 'Сборка двигателя',
      currentVisitFrom: 5 * DAY,
    });
    expect(decision).toEqual({ blocked: false, hint: null });
  });
});

describe('согласованность состояния', () => {
  it('этап ремонта текущего заезда и статус утиль одновременно — расхождение', () => {
    expect(
      isScrapStageStateConsistent({
        isScrap: true,
        scrapAt: 10 * DAY,
        currentVisitFrom: 5 * DAY,
        currentVisitRepairStageDates: [12 * DAY],
      }),
    ).toBe(false);
  });

  it('этапы прошлых заездов расхождением не считаются', () => {
    expect(
      isScrapStageStateConsistent({
        isScrap: true,
        scrapAt: 10 * DAY,
        currentVisitFrom: 5 * DAY,
        currentVisitRepairStageDates: [],
      }),
    ).toBe(true);
  });

  it('утиль прошлого заезда при этапе текущего — расхождения нет', () => {
    expect(
      isScrapStageStateConsistent({
        isScrap: true,
        scrapAt: 3 * DAY,
        currentVisitFrom: 5 * DAY,
        currentVisitRepairStageDates: [12 * DAY],
      }),
    ).toBe(true);
  });

  it('неутильный двигатель согласен всегда', () => {
    expect(
      isScrapStageStateConsistent({
        isScrap: false,
        scrapAt: null,
        currentVisitFrom: 5 * DAY,
        currentVisitRepairStageDates: [12 * DAY],
      }),
    ).toBe(true);
  });
});

describe('перебор расхождений по строкам списка', () => {
  const row = (over: Partial<Parameters<typeof findScrapStageInconsistencies>[0][number]> = {}) => ({
    id: 'e-1',
    engineNumber: 'Д-001',
    isScrap: true,
    statusDates: { status_scrap_confirmed: 10 * DAY },
    stageEntries: [
      { code: 'arrival', name: 'Приемка', at: 5 * DAY, pass: 1 },
      { code: 'ukladka', name: 'Укладка вала', at: 12 * DAY, pass: 1 },
    ],
    ...over,
  });

  it('утиль текущего заезда и этап ремонта текущего заезда — расхождение', () => {
    const found = findScrapStageInconsistencies([row()]);
    expect(found).toHaveLength(1);
    expect(found[0]?.engineNumber).toBe('Д-001');
    expect(found[0]?.stageCode).toBe('ukladka');
  });

  it('этапы прошлого заезда расхождением не считаются', () => {
    const found = findScrapStageInconsistencies([
      row({
        stageEntries: [
          { code: 'arrival', name: 'Приемка', at: 1 * DAY, pass: 1 },
          { code: 'ukladka', name: 'Укладка вала', at: 2 * DAY, pass: 1 },
          { code: 'arrival_reclamation', name: 'Приемка по рекламации', at: 5 * DAY, pass: 1 },
        ],
        statusDates: { status_scrap_confirmed: 10 * DAY },
      }),
    ]);
    expect(found).toHaveLength(0);
  });

  it('неутильные двигатели в перебор не попадают', () => {
    expect(findScrapStageInconsistencies([row({ isScrap: false })])).toHaveLength(0);
  });
});
