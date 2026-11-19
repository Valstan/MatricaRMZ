import { describe, expect, it } from 'vitest';

import {
  estimateDownloadRate,
  formatEtaSeconds,
  formatUpdateProgressLabel,
  monotonicOverallPct,
  stageOverallPct,
  UPDATE_STAGE_RANGES,
  type UpdateStage,
} from './updateProgress.js';

describe('части полосы по этапам', () => {
  it('у каждого этапа своя часть, идут по порядку', () => {
    expect(UPDATE_STAGE_RANGES.downloading).toEqual({ from: 0, to: 60 });
    expect(UPDATE_STAGE_RANGES.downloaded).toEqual({ from: 60, to: 60 });
    expect(UPDATE_STAGE_RANGES.verifying).toEqual({ from: 60, to: 70 });
    expect(UPDATE_STAGE_RANGES.installing).toEqual({ from: 70, to: 95 });
    expect(UPDATE_STAGE_RANGES.restarting).toEqual({ from: 95, to: 100 });
  });

  it('общий процент — отрезок этапа, а не его процент', () => {
    expect(stageOverallPct('downloading', 0)).toBe(0);
    expect(stageOverallPct('downloading', 50)).toBe(30);
    expect(stageOverallPct('downloading', 100)).toBe(60);
    expect(stageOverallPct('verifying', 50)).toBe(65);
    expect(stageOverallPct('installing', 50)).toBe(82);
    expect(stageOverallPct('restarting', 50)).toBe(97);
  });

  it('скачанное обновление стоит на 60% и не сбрасывается', () => {
    expect(stageOverallPct('downloaded', 100)).toBe(60);
  });

  it('мусор на входе не ломает полосу', () => {
    expect(stageOverallPct('downloading', Number.NaN)).toBe(0);
    expect(stageOverallPct('downloading', -5)).toBe(0);
    expect(stageOverallPct('downloading', 500)).toBe(60);
  });
});

describe('полоса не прыгает назад', () => {
  it('следующий этап не уменьшает показанный процент', () => {
    expect(monotonicOverallPct(60, 55)).toBe(60);
    expect(monotonicOverallPct(60, 70)).toBe(70);
    expect(monotonicOverallPct(null, 12)).toBe(12);
  });

  it('вся последовательность обновления не убывает', () => {
    const sequence: Array<[UpdateStage, number]> = [
      ['checking', 0],
      ['downloading', 0],
      ['downloading', 40],
      ['downloading', 100],
      ['downloaded', 100],
      ['verifying', 50],
      ['installing', 20],
      ['installing', 100],
      ['restarting', 100],
    ];
    let shown = 0;
    for (const [stage, pct] of sequence) {
      shown = monotonicOverallPct(shown, stageOverallPct(stage, pct));
    }
    expect(shown).toBe(100);
  });

  it('установка, начавшаяся с нуля, не откатывает полосу', () => {
    // Раньше скачивание доходило до 100%, а установка начиналась с 80% — полоса прыгала назад.
    const afterDownload = monotonicOverallPct(0, stageOverallPct('downloading', 100));
    const afterInstall = monotonicOverallPct(afterDownload, stageOverallPct('installing', 0));
    expect(afterInstall).toBeGreaterThanOrEqual(afterDownload);
  });
});

describe('секунды честные', () => {
  it('нет данных — прочерк, а не ноль', () => {
    expect(formatEtaSeconds(null)).toBe('оценка недоступна');
    expect(formatEtaSeconds(undefined)).toBe('оценка недоступна');
    expect(formatEtaSeconds(Number.NaN)).toBe('оценка недоступна');
  });

  it('секунды и минуты читаются как у человека', () => {
    expect(formatEtaSeconds(18)).toBe('осталось 18 с');
    expect(formatEtaSeconds(90)).toBe('осталось 1 мин 30 с');
    expect(formatEtaSeconds(0)).toBe('осталось 0 с');
  });
});

describe('подпись полосы', () => {
  it('называет версии, процент и остаток', () => {
    const label = formatUpdateProgressLabel({
      fromLabel: 'Матрица3-РМЗ (135)',
      toLabel: 'Матрица3-РМЗ (136)',
      pct: 42,
      etaSeconds: 18,
    });
    expect(label).toBe('Матрица3-РМЗ (135) → Матрица3-РМЗ (136) · 42% · осталось 18 с');
  });

  it('без оценки времени подпись не врёт', () => {
    const label = formatUpdateProgressLabel({ fromLabel: 'Матрица3-РМЗ (135)', toLabel: 'Матрица3-РМЗ (136)', pct: 0 });
    expect(label).toContain('оценка недоступна');
  });
});

describe('скорость и ETA по окну', () => {
  it('считает скорость по дельте байтов за окно, а не по накопленным', () => {
    // За секунду пришло 5 МиБ: раньше делились бы все 10 МиБ, что завышало скорость вдвое.
    const r = estimateDownloadRate({
      transferredBytes: 10 * 1024 * 1024,
      previousBytes: 5 * 1024 * 1024,
      totalBytes: 20 * 1024 * 1024,
      windowSeconds: 1,
    });
    expect(r.bytesPerSecond).toBeCloseTo(5 * 1024 * 1024, 0);
    expect(r.etaSeconds).toBeCloseTo(2, 0);
  });

  it('без объёма ничего не выдумывает', () => {
    const r = estimateDownloadRate({ transferredBytes: 100, totalBytes: null, windowSeconds: 1 });
    expect(r.bytesPerSecond).toBeNull();
    expect(r.etaSeconds).toBeNull();
  });
});
