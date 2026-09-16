import { describe, expect, it } from 'vitest';

import type { EngineListItem } from '../ipc/types.js';
import { engineFactoryStage, engineFactoryStageOrder, isEngineAtPlant } from './engineFactoryStage.js';

const TYPES = [
  { code: 'ukladka', name: 'Укладка', sortOrder: 10 },
  { code: 'val', name: 'Вал', sortOrder: 20 },
  { code: 'sborka', name: 'Сборка', sortOrder: 30 },
  { code: 'obkatka', name: 'Обкатка', sortOrder: 40 },
];

const DAY = 24 * 60 * 60 * 1000;
function engine(patch: Partial<EngineListItem>): EngineListItem {
  return { id: 'e', updatedAt: 0, syncStatus: 'ok', arrivalDate: 10 * DAY, ...patch };
}

describe('isEngineAtPlant — пришёл и не отгружен', () => {
  it('дата прихода есть, отгрузки нет → на заводе; иначе нет', () => {
    expect(isEngineAtPlant({ arrivalDate: 5, shippingDate: null })).toBe(true);
    expect(isEngineAtPlant({ arrivalDate: 5, shippingDate: 9 })).toBe(false);
    expect(isEngineAtPlant({ arrivalDate: null, shippingDate: null })).toBe(false);
    expect(isEngineAtPlant({ arrivalDate: 0, shippingDate: undefined })).toBe(false);
  });
});

describe('engineFactoryStage — побеждает поздний признак', () => {
  it('утиль перебивает всё, даже отремонтированного с ведомостью', () => {
    const s = engineFactoryStage(engine({ isScrap: true, statusFlags: { status_repaired: true }, lastSheetNode: 'Обкатка' }), TYPES);
    expect(s.key).toBe('scrap');
    expect(s.label).toBe('Утиль');
  });

  it('отремонтирован перебивает ведомость', () => {
    const s = engineFactoryStage(engine({ statusFlags: { status_repaired: true }, lastSheetNode: 'Укладка', lastSheetAt: 11 * DAY }), TYPES);
    expect(s.key).toBe('repaired');
  });

  it('ведомость перебивает дефектовку, ранг растёт по порядку видов работ', () => {
    const ukladka = engineFactoryStage(engine({ hasDefectAct: true, lastSheetTypeCode: 'ukladka', lastSheetNode: 'Укладка', lastSheetAt: 12 * DAY }), TYPES);
    const obkatka = engineFactoryStage(engine({ hasDefectAct: true, lastSheetTypeCode: 'obkatka', lastSheetNode: 'Обкатка', lastSheetAt: 13 * DAY }), TYPES);
    expect(ukladka).toMatchObject({ key: 'sheet:ukladka', label: 'Укладка', at: 12 * DAY });
    expect(obkatka.key).toBe('sheet:obkatka');
    expect(obkatka.rank).toBeGreaterThan(ukladka.rank);
    expect(ukladka.rank).toBeGreaterThan(engineFactoryStage(engine({ hasDefectAct: true }), TYPES).rank);
  });

  it('старая строка без кода вида сопоставляется по имени без регистра; неизвестный вид — базовый ранг и подпись строки', () => {
    const byName = engineFactoryStage(engine({ lastSheetNode: 'обкатка' }), TYPES);
    expect(byName).toMatchObject({ key: 'sheet:obkatka', label: 'Обкатка' });
    const unknown = engineFactoryStage(engine({ lastSheetNode: 'Покраска' }), TYPES);
    expect(unknown).toMatchObject({ key: 'sheet:покраска', label: 'Покраска', rank: 10 });
  });

  it('дефектовка > комплектовка > ремонт начат > пришёл; даты — где есть', () => {
    const defect = engineFactoryStage(engine({ hasDefectAct: true, hasCompletenessAct: true, statusFlags: { status_repair_started: true }, defectDate: 9 * DAY }), TYPES);
    const compl = engineFactoryStage(engine({ hasCompletenessAct: true, statusFlags: { status_repair_started: true } }), TYPES);
    const started = engineFactoryStage(engine({ statusFlags: { status_repair_started: true } }), TYPES);
    const arrived = engineFactoryStage(engine({}), TYPES);
    expect(defect).toMatchObject({ key: 'defect_act', at: 9 * DAY });
    expect(compl.key).toBe('completeness_act');
    expect(started.key).toBe('repair_started');
    expect(arrived).toMatchObject({ key: 'arrived', label: 'Пришёл, ремонт не начат', at: 10 * DAY });
    expect(defect.rank).toBeGreaterThan(compl.rank);
    expect(compl.rank).toBeGreaterThan(started.rank);
    expect(started.rank).toBeGreaterThan(arrived.rank);
  });

  it('даты стадий карточки — из statusDates: утиль, отремонтирован, ремонт начат', () => {
    // Владелец 16.09: в отчёте у этих этапов стоял прочерк — строка списка дат не несла.
    const scrap = engineFactoryStage(engine({ isScrap: true, statusDates: { status_scrap_confirmed: 20 * DAY, status_rejected: 18 * DAY } }), TYPES);
    const rejectedOnly = engineFactoryStage(engine({ isScrap: true, statusDates: { status_rejected: 18 * DAY } }), TYPES);
    const repaired = engineFactoryStage(engine({ statusFlags: { status_repaired: true }, statusDates: { status_repaired: 15 * DAY } }), TYPES);
    const started = engineFactoryStage(engine({ statusFlags: { status_repair_started: true }, statusDates: { status_repair_started: 11 * DAY } }), TYPES);
    const noDates = engineFactoryStage(engine({ statusFlags: { status_repaired: true } }), TYPES);
    expect(scrap).toMatchObject({ key: 'scrap', at: 20 * DAY });
    expect(rejectedOnly).toMatchObject({ key: 'scrap', at: 18 * DAY });
    expect(repaired).toMatchObject({ key: 'repaired', at: 15 * DAY });
    expect(started).toMatchObject({ key: 'repair_started', at: 11 * DAY });
    expect(noDates).toMatchObject({ key: 'repaired', at: null });
  });

  it('без справочника видов ведомость всё равно узнаётся', () => {
    expect(engineFactoryStage(engine({ lastSheetNode: 'Сборка' })).key).toBe('sheet:сборка');
  });
});

describe('engineFactoryStageOrder — ряд групп от позднего к раннему', () => {
  it('утиль, отремонтирован, виды работ (поздние выше), дефектовка, комплектовка, начат, пришёл', () => {
    const keys = engineFactoryStageOrder(TYPES).map((g) => g.key);
    expect(keys).toEqual(['scrap', 'repaired', 'sheet:obkatka', 'sheet:sborka', 'sheet:val', 'sheet:ukladka', 'defect_act', 'completeness_act', 'repair_started', 'arrived']);
    const ranks = engineFactoryStageOrder(TYPES).map((g) => g.rank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });
});
