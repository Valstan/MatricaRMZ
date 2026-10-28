import { describe, expect, it } from 'vitest';

import {
  PULL_GAPS_CAP,
  PULL_GAP_RETRY_MS,
  gapsToRetry,
  mergePullGaps,
  parsePullGaps,
  serializePullGaps,
  type PullGap,
} from './pullGaps.js';

const NOW = 1_700_000_000_000;

describe('журнал дырок pull', () => {
  it('новая таблица попадает в журнал с временем обнаружения', () => {
    const gaps = mergePullGaps([], new Map([['erp_engine_numbers', 2580]]), NOW);
    expect(gaps).toEqual([{ table: 'erp_engine_numbers', rows: 2580, firstSeenAt: NOW, lastAttemptAt: NOW }]);
  });

  it('повтор не переписывает начало беды, но обновляет попытку и берёт больший счёт', () => {
    const first = mergePullGaps([], new Map([['t', 3]]), NOW);
    const again = mergePullGaps(first, new Map([['t', 7]]), NOW + 60_000);
    expect(again).toEqual([{ table: 't', rows: 7, firstSeenAt: NOW, lastAttemptAt: NOW + 60_000 }]);
    const fewer = mergePullGaps(again, new Map([['t', 1]]), NOW + 120_000);
    expect(fewer[0]?.rows).toBe(7);
  });

  it('таблица, которой нет в контракте этой сборки, тоже записывается', () => {
    // Ради этого случая журнал и заведён: сервер знает таблицу, клиент — нет.
    const gaps = mergePullGaps([], new Map([['erp_future_table', 1]]), NOW);
    expect(gaps.map((g) => g.table)).toEqual(['erp_future_table']);
  });

  it('пустые имена и нечисловые счётчики не засоряют журнал', () => {
    const gaps = mergePullGaps([], new Map([['   ', 5], ['ok', Number.NaN]]), NOW);
    expect(gaps).toEqual([{ table: 'ok', rows: 0, firstSeenAt: NOW, lastAttemptAt: NOW }]);
  });

  it('потолок держит журнал: лишние таблицы не вытесняют уже записанные', () => {
    const full: PullGap[] = Array.from({ length: PULL_GAPS_CAP }, (_, i) => ({
      table: `t${i}`,
      rows: 1,
      firstSeenAt: NOW,
      lastAttemptAt: NOW,
    }));
    const gaps = mergePullGaps(full, new Map([['extra', 1]]), NOW);
    expect(gaps).toHaveLength(PULL_GAPS_CAP);
    expect(gaps.some((g) => g.table === 'extra')).toBe(false);
    expect(gaps[0]?.table).toBe('t0');
  });

  it('повторная попытка — не чаще паузы: иначе сервер получает полное состояние таблицы каждую минуту', () => {
    const gaps: PullGap[] = [{ table: 't', rows: 1, firstSeenAt: NOW, lastAttemptAt: NOW }];
    expect(gapsToRetry(gaps, NOW)).toEqual([]);
    expect(gapsToRetry(gaps, NOW + PULL_GAP_RETRY_MS - 1)).toEqual([]);
    expect(gapsToRetry(gaps, NOW + PULL_GAP_RETRY_MS).map((g) => g.table)).toEqual(['t']);
  });

  it('битый JSON и чужие поля читаются как пустой журнал, а не как падение синхронизации', () => {
    expect(parsePullGaps(null)).toEqual([]);
    expect(parsePullGaps('{')).toEqual([]);
    expect(parsePullGaps('{"table":"t"}')).toEqual([]);
    const duplicated = [
      { table: 't', rows: 1, firstSeenAt: NOW, lastAttemptAt: NOW },
      { table: 't', rows: 2, firstSeenAt: NOW, lastAttemptAt: NOW },
    ];
    expect(parsePullGaps(JSON.stringify(duplicated))).toEqual([
      { table: 't', rows: 1, firstSeenAt: NOW, lastAttemptAt: NOW },
    ]);
  });

  it('сериализация переживает обратное чтение', () => {
    const gaps = mergePullGaps([], new Map([['a', 1], ['b', 2]]), NOW);
    expect(parsePullGaps(serializePullGaps(gaps))).toEqual(gaps);
  });
});
