import { afterEach, describe, expect, it, vi } from 'vitest';

import { ledgerSeqWaitersCount, setLedgerSeqReader, waitForLedgerSeqAbove } from './ledgerSeqWatch.js';

afterEach(() => {
  setLedgerSeqReader();
  vi.useRealTimers();
});

describe('ожидание новостей журнала', () => {
  it('отставший клиент получает ответ сразу и слот ожидания не занимает', async () => {
    setLedgerSeqReader(async () => 120);
    const r = await waitForLedgerSeqAbove(100, 5_000);
    expect(r).toEqual({ changed: true, seq: 120 });
    expect(ledgerSeqWaitersCount()).toBe(0);
  });

  it('просыпается, как только номер ушёл выше курсора', async () => {
    let seq = 100;
    setLedgerSeqReader(async () => seq);
    const waiting = waitForLedgerSeqAbove(100, 5_000);
    // Даём ожиданию встать в очередь до того, как номер сдвинется.
    await vi.waitFor(() => expect(ledgerSeqWaitersCount()).toBe(1));
    seq = 101;
    await expect(waiting).resolves.toEqual({ changed: true, seq: 101 });
    expect(ledgerSeqWaitersCount()).toBe(0);
  });

  it('пустой ответ по истечении окна — штатный исход, а не ошибка', async () => {
    setLedgerSeqReader(async () => 100);
    const r = await waitForLedgerSeqAbove(100, 60);
    expect(r.changed).toBe(false);
    expect(ledgerSeqWaitersCount()).toBe(0);
  });

  it('обрыв со стороны клиента снимает ожидание', async () => {
    setLedgerSeqReader(async () => 100);
    const ac = new AbortController();
    const waiting = waitForLedgerSeqAbove(100, 10_000, ac.signal);
    await vi.waitFor(() => expect(ledgerSeqWaitersCount()).toBe(1));
    ac.abort();
    await expect(waiting).resolves.toEqual({ changed: false, seq: 100 });
    expect(ledgerSeqWaitersCount()).toBe(0);
  });

  it('неудачная выборка номера не роняет ожидающих — их вернёт окно', async () => {
    let calls = 0;
    setLedgerSeqReader(async () => {
      calls += 1;
      if (calls === 1) return 100;
      throw new Error('db down');
    });
    const r = await waitForLedgerSeqAbove(100, 80);
    expect(r.changed).toBe(false);
    expect(ledgerSeqWaitersCount()).toBe(0);
  });

  it('один сдвиг номера будит всех ждущих сразу', async () => {
    let seq = 500;
    setLedgerSeqReader(async () => seq);
    const a = waitForLedgerSeqAbove(500, 5_000);
    const b = waitForLedgerSeqAbove(499 + 1, 5_000);
    await vi.waitFor(() => expect(ledgerSeqWaitersCount()).toBe(2));
    seq = 501;
    await expect(Promise.all([a, b])).resolves.toEqual([
      { changed: true, seq: 501 },
      { changed: true, seq: 501 },
    ]);
  });
});
