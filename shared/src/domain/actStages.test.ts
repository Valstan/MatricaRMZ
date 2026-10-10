import { describe, expect, it } from 'vitest';

import { actStageEntries, mergeActStages } from './actStages.js';
import { moscowDayKey } from './workSheetDuplicates.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

describe('actStageEntries', () => {
  it('без дат — пусто', () => {
    expect(actStageEntries(null)).toEqual([]);
    expect(actStageEntries(undefined)).toEqual([]);
    expect(actStageEntries({})).toEqual([]);
  });

  it('приёмка предпочитает дату осмотра дате прихода', () => {
    const [entry] = actStageEntries({ arrivalDate: T0 - DAY, completenessInspectionDate: T0 });
    expect(entry?.code).toBe('arrival');
    expect(entry?.atMs).toBe(T0);
    expect(entry?.origin).toBe('act');
  });

  it('приёмка падает на дату прихода без осмотра', () => {
    const [entry] = actStageEntries({ arrivalDate: T0 });
    expect(entry?.code).toBe('arrival');
    expect(entry?.atMs).toBe(T0);
  });

  it('дефектовка — из даты начала разборки', () => {
    const entries = actStageEntries({ defectStartDate: T0 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.code).toBe('disassembly_defect');
    expect(entries[0]?.atMs).toBe(T0);
  });

  it('мусор вместо дат игнорируется', () => {
    expect(actStageEntries({ arrivalDate: 0, defectStartDate: -5 })).toEqual([]);
    expect(actStageEntries({ arrivalDate: NaN })).toEqual([]);
  });

  it('имена — из реестра этапов', () => {
    const entries = actStageEntries({ arrivalDate: T0, defectStartDate: T0 });
    expect(entries.map((e) => e.name)).toEqual(['Приемка двигателя на завод', 'Разборка/Дефектовка']);
  });
});

describe('mergeActStages', () => {
  const derived = actStageEntries({ arrivalDate: T0, defectStartDate: T0 });
  const row = (code: string, atMs: number | null) => ({ code, atMs });

  it('без stored — только выведенные', () => {
    const merged = mergeActStages([], derived);
    expect(merged.map((m) => m.origin)).toEqual(['act', 'act']);
  });

  it('stored тем же кодом в тот же день скрывается', () => {
    const merged = mergeActStages([row('arrival', T0 + 3600_000)], derived);
    expect(merged).toHaveLength(2);
    expect(merged.filter((m) => m.origin === 'stored')).toHaveLength(0);
  });

  it('снесённый код kitting_done гасится выведенной приёмкой того же дня', () => {
    const merged = mergeActStages([row('kitting_done', T0)], derived);
    expect(merged.filter((m) => m.origin === 'stored')).toHaveLength(0);
  });

  it('stored другим днём остаётся', () => {
    const merged = mergeActStages([row('arrival', T0 - DAY)], derived);
    expect(merged).toHaveLength(3);
    expect(merged.filter((m) => m.origin === 'stored')).toHaveLength(1);
  });

  it('stored без даты остаётся всегда', () => {
    const merged = mergeActStages([row('disassembly_defect', null)], derived);
    expect(merged.filter((m) => m.origin === 'stored')).toHaveLength(1);
  });

  it('чужие коды не трогаются', () => {
    const merged = mergeActStages([row('ukladka', T0)], derived);
    expect(merged).toHaveLength(3);
    const stored = merged.find((m) => m.origin === 'stored');
    expect(stored && stored.row.code).toBe('ukladka');
  });

  it('день считается по Москве, а не по равенству меток', () => {
    const sameDay = T0 + 2 * 3600_000;
    expect(moscowDayKey(sameDay)).toBe(moscowDayKey(T0));
    const merged = mergeActStages([row('arrival', sameDay)], derived);
    expect(merged.filter((m) => m.origin === 'stored')).toHaveLength(0);
  });
});
