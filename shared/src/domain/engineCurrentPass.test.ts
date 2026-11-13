import { describe, expect, it } from 'vitest';

import type { EngineListItem, EngineStageEntry } from '../ipc/types.js';
import {
  currentPassLastStage,
  currentPassRow,
  currentPassStageCodes,
  currentPassStageEntries,
} from './engineCurrentPass.js';

// «Сейчас» двигателя (владелец 13.11.2026): текущий заезд и текущий проход.
// Проверяем ровно то, из-за чего владелец и попросил: старый заезд и сброшенный шагом назад
// этап не должны попадать ни в отборы, ни в колонку «Этап» режима «Сейчас на заводе».

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 1, 9, 0, 0);

const entry = (code: string, day: number, pass = 1): EngineStageEntry => ({
  code,
  name: code,
  at: T0 + day * DAY,
  pass,
});

describe('«сейчас» двигателя: текущий заезд', () => {
  it('обычный заезд: действуют все его этапы', () => {
    const codes = currentPassStageCodes([
      entry('arrival', 0),
      entry('disassembly_defect', 2),
      entry('obkatka', 5),
      entry('shipped', 7),
    ]);
    expect(codes).toEqual(['arrival', 'disassembly_defect', 'obkatka', 'shipped']);
  });

  it('рекламация — новый заезд: этапы прошлого цикла больше не действуют', () => {
    // Двигатель прошёл полный цикл, уехал заказчику и вернулся по рекламации. Отгрузка и
    // приёмка заказчиком — прошлый заезд: в режиме «сейчас» их быть не должно.
    const codes = currentPassStageCodes([
      entry('arrival', 0),
      entry('disassembly_defect', 2),
      entry('obkatka', 5),
      entry('shipped', 7),
      entry('accepted', 8),
      entry('arrival_reclamation', 40),
    ]);
    expect(codes).toEqual(['arrival_reclamation']);
  });

  it('повторный приём (без рекламации) — тоже новый заезд', () => {
    const codes = currentPassStageCodes([entry('arrival', 0), entry('shipped', 7), entry('arrival', 40)]);
    expect(codes).toEqual(['arrival']);
  });

  it('двигатель без этапов — пусто', () => {
    expect(currentPassStageCodes([])).toEqual([]);
    expect(currentPassStageEntries([])).toEqual([]);
    expect(currentPassLastStage([])).toBeNull();
  });
});

describe('«сейчас» двигателя: текущий проход', () => {
  it('шаг назад обнуляет этапы выше: обкатки «ещё не было»', () => {
    // Был на обкатке, вернулся на сборку — обкатка в прошлом.
    const codes = currentPassStageCodes([
      entry('arrival', 0),
      entry('disassembly_defect', 2),
      entry('obkatka', 5),
      entry('sborka', 6),
    ]);
    expect(codes).toEqual(['arrival', 'disassembly_defect', 'sborka']);
    expect(codes).not.toContain('obkatka');
  });

  it('после шага назад этап снова достигнут — он действует', () => {
    const codes = currentPassStageCodes([
      entry('arrival', 0),
      entry('obkatka', 5),
      entry('sborka', 6),
      entry('obkatka', 7),
    ]);
    expect(codes).toEqual(['arrival', 'sborka', 'obkatka']);
  });

  it('этап без даты место не определяет и шагом назад не считается', () => {
    const codes = currentPassStageCodes([
      entry('arrival', 0),
      entry('obkatka', 5),
      { code: 'ukladka', name: 'ukladka', at: 0, pass: 1 },
    ]);
    expect(codes).toContain('obkatka');
    expect(codes).toContain('ukladka');
    // Место при этом — обкатка: без даты этап не определяет ничего.
    expect(currentPassLastStage([
      entry('arrival', 0),
      entry('obkatka', 5),
      { code: 'ukladka', name: 'ukladka', at: 0, pass: 1 },
    ])?.code).toBe('obkatka');
  });

  it('текущее место — последний датированный действующий этап', () => {
    const last = currentPassLastStage([
      entry('arrival', 0),
      entry('obkatka', 5),
      entry('sborka', 6),
    ]);
    expect(last?.code).toBe('sborka');
  });
});

describe('строка списка в режиме «сейчас»', () => {
  const row = (entries: EngineStageEntry[]): EngineListItem =>
    ({
      id: 'e1',
      engineNumber: 'TEST-001',
      stageCodes: ['arrival', 'obkatka', 'shipped'],
      stageDates: { arrival: T0, obkatka: T0 + 5 * DAY, shipped: T0 + 7 * DAY },
      stageEntries: entries,
      lastStageCode: 'shipped',
      lastStageName: 'shipped',
      lastStageAt: T0 + 7 * DAY,
    }) as EngineListItem;

  it('этапы и место заменяются на действующие', () => {
    const next = currentPassRow(
      row([entry('arrival', 0), entry('obkatka', 5), entry('shipped', 7), entry('arrival_reclamation', 40)]),
    );
    expect(next.stageCodes).toEqual(['arrival_reclamation']);
    expect(next.stageDates).toEqual({ arrival_reclamation: T0 + 40 * DAY });
    expect(next.lastStageCode).toBe('arrival_reclamation');
    expect(next.lastStageAt).toBe(T0 + 40 * DAY);
  });

  it('дата каждого действующего этапа — его собственная', () => {
    // Сборка после обкатки — шаг назад: обкатка в прошлом, действует сборка.
    const next = currentPassRow(row([entry('arrival', 0), entry('obkatka', 5), entry('sborka', 6)]));
    expect(next.stageDates).toEqual({ arrival: T0, sborka: T0 + 6 * DAY });
  });

  it('двигатель без этапов — строка не меняется', () => {
    const base = row([]);
    expect(currentPassRow(base)).toBe(base);
  });
});
