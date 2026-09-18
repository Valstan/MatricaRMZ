/**
 * Ожидание новостей журнала: сервер держит запрос клиента, пока номер журнала не уйдёт
 * выше клиентского курсора, и отвечает В ТОТ ЖЕ МИГ, когда это случилось.
 *
 * Зачем так, а не «пусть клиент опрашивает чаще»: опрос `/ledger/state/changes` стоит
 * запроса к каждой синкаемой таблице, а ждущий запрос — один индексный `max(server_seq)`
 * на ВЕСЬ парк (сколько бы клиентов ни ждало, опрашивает журнал один общий таймер
 * инстанса). Поэтому «мгновенно» здесь дешевле, чем «раз в минуту» опросом.
 *
 * Общий таймер живёт ровно пока есть ожидающие: без них фонового запроса к БД нет.
 */
import { getLedgerLastSeq } from '../../ledger/ledgerService.js';

export type LedgerSeqWaitResult = { changed: boolean; seq: number };

type Waiter = {
  since: number;
  settle: (result: LedgerSeqWaitResult) => void;
  timer: NodeJS.Timeout;
};

const POLL_MS = Math.max(50, Number(process.env.MATRICA_SYNC_WAKE_POLL_MS ?? 400) || 400);

const waiters = new Set<Waiter>();
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;
let lastSeenSeq = 0;
let readLastSeq: () => Promise<number> = getLedgerLastSeq;

/** Подменить источник номера (тесты). Без аргумента — вернуть журнал. */
export function setLedgerSeqReader(fn?: () => Promise<number>): void {
  readLastSeq = fn ?? getLedgerLastSeq;
}

export function ledgerSeqWaitersCount(): number {
  return waiters.size;
}

function stopPollingIfIdle() {
  if (waiters.size > 0 || !pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function releaseWaiters(seq: number) {
  for (const w of Array.from(waiters)) {
    if (seq <= w.since) continue;
    waiters.delete(w);
    clearTimeout(w.timer);
    w.settle({ changed: true, seq });
  }
}

async function pollOnce() {
  // Не наслаиваем запросы: если БД отвечает дольше интервала, ждём прошлый.
  if (polling) return;
  polling = true;
  try {
    lastSeenSeq = await readLastSeq();
    releaseWaiters(lastSeenSeq);
  } catch {
    // Молчим намеренно: ожидающих вернёт их собственный таймаут, а клиент
    // переспросит. Ронять ответ из-за одной неудачной выборки номера нечестно.
  } finally {
    polling = false;
    stopPollingIfIdle();
  }
}

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void pollOnce(), POLL_MS);
  // Таймер не должен держать процесс живым (важно для тестов и graceful-shutdown).
  pollTimer.unref?.();
}

/**
 * Ждать, пока номер журнала не превысит `since`, но не дольше `timeoutMs`.
 * Возвращает `changed: false`, если за окно ничего не произошло — это штатный ответ,
 * а не ошибка: клиент просто спросит снова.
 */
export async function waitForLedgerSeqAbove(
  since: number,
  timeoutMs: number,
  signal?: { aborted: boolean; addEventListener: (type: 'abort', cb: () => void) => void },
): Promise<LedgerSeqWaitResult> {
  const sinceSeq = Math.max(0, Number(since) || 0);

  // Отставший клиент получает ответ сразу, не занимая слот ожидания.
  const current = await readLastSeq().catch(() => lastSeenSeq);
  lastSeenSeq = current;
  if (current > sinceSeq) return { changed: true, seq: current };
  if (signal?.aborted) return { changed: false, seq: current };

  return await new Promise<LedgerSeqWaitResult>((resolve) => {
    let done = false;
    const settle = (result: LedgerSeqWaitResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const waiter: Waiter = {
      since: sinceSeq,
      settle,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        stopPollingIfIdle();
        settle({ changed: false, seq: lastSeenSeq });
      }, Math.max(1, timeoutMs)),
    };
    waiters.add(waiter);
    ensurePolling();
    signal?.addEventListener('abort', () => {
      if (!waiters.delete(waiter)) return;
      clearTimeout(waiter.timer);
      stopPollingIfIdle();
      settle({ changed: false, seq: lastSeenSeq });
    });
  });
}
