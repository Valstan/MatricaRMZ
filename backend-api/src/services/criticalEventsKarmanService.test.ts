import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BASKET_DEDUP_WINDOW_MS,
  CRITICAL_EVENTS_TO_BASKET,
  basketFingerprint,
  buildBasketPrompt,
  createKarmanBasketCollector,
  resolveKarmanPromptsBase,
  shouldSendEventToBasket,
  type KarmanBasketDeps,
} from './criticalEventsKarmanService.js';
import { ingestClientCriticalEvent, listCriticalEvents, type CriticalEventRecord } from './criticalEventsService.js';

const PROJECT = 'MatricaRMZ';

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(
  responder: (call: FetchCall) => { status: number; body?: string },
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body = '' } = responder(call);
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function event(overrides: Partial<CriticalEventRecord> = {}): CriticalEventRecord {
  return {
    id: 'evt-1',
    createdAt: Date.now(),
    source: 'client',
    severity: 'error',
    category: 'sync',
    eventCode: 'client.sync.stuck_pending',
    title: 'Очередь отправки на сервер застряла',
    humanMessage: 'Очередь отправки на сервер застряла: строки не уходят — 617 шт.',
    aiDetails: JSON.stringify({ appVersion: '3.149.0' }),
    username: 'oper',
    clientId: 'PC20-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    fingerprint: 'fp-1',
    ...overrides,
  };
}

let dir: string;
let prevLogsDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'basket-'));
  prevLogsDir = process.env.MATRICA_LOGS_DIR;
  process.env.MATRICA_LOGS_DIR = dir;
});

afterEach(() => {
  if (prevLogsDir === undefined) delete process.env.MATRICA_LOGS_DIR;
  else process.env.MATRICA_LOGS_DIR = prevLogsDir;
  rmSync(dir, { recursive: true, force: true });
});

function collectorDeps(fetchImpl: typeof fetch, extra: Partial<KarmanBasketDeps> = {}): KarmanBasketDeps {
  return {
    fetchImpl,
    logsDir: dir,
    config: { base: 'https://karman.example', token: 'secret' },
    resolveMachine: async () => ({ name: 'PC20', version: '3.149.0', username: 'оператор' }),
    ...extra,
  };
}

describe('перечень событий, которые уходят в корзину', () => {
  it('предупреждение в корзину не идёт — это шум, а не задача', () => {
    expect(shouldSendEventToBasket({ eventCode: 'client.sync.network_transient', severity: 'warn' })).toBe(false);
    expect(shouldSendEventToBasket({ eventCode: 'client.update.full_download', severity: 'warn' })).toBe(false);
    expect(
      shouldSendEventToBasket({ eventCode: 'server.sync.pipeline_poll_misconfigured', severity: 'warn' }),
    ).toBe(false);
  });

  it('ошибка клиента из перечня идёт, а чужой код — нет', () => {
    expect(shouldSendEventToBasket({ eventCode: 'client.sync.stuck_pending', severity: 'error' })).toBe(true);
    expect(shouldSendEventToBasket({ eventCode: 'client.sync.blocked_rows', severity: 'error' })).toBe(true);
    expect(shouldSendEventToBasket({ eventCode: 'client.что-то.новое', severity: 'error' })).toBe(false);
  });

  it('критичность сервера идёт в корзину', () => {
    expect(shouldSendEventToBasket({ eventCode: 'server.db.invalid_uuid', severity: 'fatal' })).toBe(true);
    expect(shouldSendEventToBasket({ eventCode: 'server.sync.schema_guard_failed', severity: 'fatal' })).toBe(true);
    expect(shouldSendEventToBasket({ eventCode: 'server.general.error', severity: 'error' })).toBe(true);
  });

  it('перечень записан явно: код и серьёзность', () => {
    const rule = CRITICAL_EVENTS_TO_BASKET.find((item) => item.code === 'client.sync.stuck_pending');
    expect(rule).toBeTruthy();
    expect(rule?.severity).toBe('error');
  });
});

describe('запись читается как заявка', () => {
  it('в ней есть что случилось, где, когда, версия, код, сообщение и что делать', () => {
    const prompt = buildBasketPrompt(event({ createdAt: Date.parse('2026-11-28T10:00:00Z') }), {
      name: 'PC20',
      version: '3.149.0',
      username: 'оператор',
    });
    expect(prompt.title).toContain('Критическое событие');
    expect(prompt.body).toContain('## Что случилось');
    expect(prompt.body).toContain('Очередь отправки на сервер застряла');
    expect(prompt.body).toContain('PC20');
    expect(prompt.body).toContain('3.149.0');
    expect(prompt.body).toContain('client.sync.stuck_pending');
    expect(prompt.body).toContain('## Когда');
    expect(prompt.body).toContain('## Что делать');
    expect(prompt.body).toContain('починить очередь');
  });

  it('машина без сведений — запись всё равно уходит и говорит, что не знает', () => {
    const prompt = buildBasketPrompt(event({ clientId: null }), null);
    expect(prompt.body).toContain('Версия программы: неизвестна');
    expect(prompt.body).toContain('Машина: неизвестна');
  });
});

describe('защита от повторов', () => {
  it('десять одинаковых событий подряд дают одну запись', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: '{"id":1}' }));
    const collector = createKarmanBasketCollector(collectorDeps(impl));
    for (let i = 0; i < 10; i += 1) {
      await collector.handleEvent(event({ id: `evt-${i}`, fingerprint: 'fp-same' }));
    }
    expect(calls).toHaveLength(1);
  });

  it('второе, отличное по содержанию, уходит отдельной записью', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: '{"id":1}' }));
    const collector = createKarmanBasketCollector(collectorDeps(impl));
    await collector.handleEvent(event({ id: 'evt-1', fingerprint: 'fp-a' }));
    await collector.handleEvent(event({ id: 'evt-2', fingerprint: 'fp-b' }));
    expect(calls).toHaveLength(2);
  });

  it('та же беда с выросшим счётчиком — новая беда и уходит в корзину', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: '{"id":1}' }));
    const collector = createKarmanBasketCollector(collectorDeps(impl));
    // Отпечаток журнала для застрявшей очереди — «машина + счётчик строк».
    await collector.handleEvent(event({ id: 'evt-1', fingerprint: 'client|PC20|617' }));
    await collector.handleEvent(event({ id: 'evt-2', fingerprint: 'client|PC20|620' }));
    expect(calls).toHaveLength(2);
  });

  it('через четыре часа то же самое сообщение уходит снова', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: '{"id":1}' }));
    let clock = Date.parse('2026-11-28T10:00:00Z');
    const collector = createKarmanBasketCollector(
      collectorDeps(impl, { now: () => clock, windowMs: BASKET_DEDUP_WINDOW_MS }),
    );
    await collector.handleEvent(event({ id: 'evt-1', fingerprint: 'fp-same' }));
    clock += BASKET_DEDUP_WINDOW_MS - 60_000;
    await collector.handleEvent(event({ id: 'evt-2', fingerprint: 'fp-same' }));
    expect(calls).toHaveLength(1);
    clock += 2 * 60_000;
    await collector.handleEvent(event({ id: 'evt-3', fingerprint: 'fp-same' }));
    expect(calls).toHaveLength(2);
  });

  it('отпечаток включает машину и суть сообщения', () => {
    const a = basketFingerprint(event({ clientId: 'PC20', fingerprint: '' }));
    const b = basketFingerprint(event({ clientId: 'PC21', fingerprint: '' }));
    const c = basketFingerprint(event({ clientId: 'PC20', fingerprint: '', humanMessage: 'другая беда' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('корзина недоступна — событие не теряется', () => {
  it('сервер не падает, а событие остаётся в журнале', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 503, body: 'канал не настроен' }));
    const collector = createKarmanBasketCollector(collectorDeps(impl));
    ingestClientCriticalEvent({
      eventCode: 'client.sync.stuck_pending',
      title: 'Очередь отправки на сервер застряла',
      humanMessage: 'Очередь застряла: 617 шт. (проба недоступности корзины)',
      category: 'sync',
      severity: 'error',
      clientId: 'PC20-test',
      username: 'oper',
      dedupMessage: 'PC20-test|617',
    });
    const result = await collector.handleEvent(
      event({ id: 'evt-fail', fingerprint: 'fp-fail', humanMessage: 'Очередь застряла: 617 шт. (проба недоступности корзины)' }),
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    // Событие осталось в журнале: администратор его видит и может удалить.
    const inJournal = listCriticalEvents({ days: 3, limit: 100 });
    expect(inJournal.some((row) => row.eventCode === 'client.sync.stuck_pending')).toBe(true);
  });

  it('нет настройки канала — тихий отказ, а не ошибка', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201 }));
    const collector = createKarmanBasketCollector(collectorDeps(impl, { config: null }));
    const result = await collector.handleEvent(event());
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('внутренний поток промтов не тащится в корзину', () => {
  it('сборщик только пишет: список промтов он не читает', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: '{"id":1}' }));
    const collector = createKarmanBasketCollector(collectorDeps(impl));
    await collector.handleEvent(event());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://karman.example/api/prompts`);
    expect(calls[0]?.init.method).toBe('POST');
    // Ни одного GET'а: раздел промтов сборщик не читает — оттуда приехала бы
    // внутренняя переписка программы, а она не критическая ошибка.
    expect(calls.some((call) => String(call.init.method ?? 'GET').toUpperCase() === 'GET')).toBe(false);
  });

  it('запись уходит в раздел «Матрица РМЗ» с секретом канала', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: '{"id":7}' }));
    const collector = createKarmanBasketCollector(collectorDeps(impl));
    await collector.handleEvent(event());
    const init = calls[0]?.init as { headers?: Record<string, string>; body?: string };
    expect(init.headers?.Authorization).toBe('Bearer secret');
    const body = JSON.parse(String(init.body ?? '{}')) as { project?: string; title?: string; body?: string };
    expect(body.project).toBe(PROJECT);
    expect(body.title).toContain('Критическое событие');
    expect(body.body).toContain('## Что делать');
  });
});

describe('адрес и секрет канала', () => {
  it('адрес берётся из настройки, иначе — из адреса хранилища', () => {
    expect(resolveKarmanPromptsBase({ MATRICA_KARMAN_PROMPTS_URL: 'https://karman.example/' } as NodeJS.ProcessEnv)).toBe(
      'https://karman.example',
    );
    expect(
      resolveKarmanPromptsBase({ SECRETS_VAULT_URL: 'https://karman.example/api/secrets' } as NodeJS.ProcessEnv),
    ).toBe('https://karman.example');
    expect(resolveKarmanPromptsBase({} as NodeJS.ProcessEnv)).toBe('');
  });
});

describe('проход по журналу', () => {
  it('новое событие уходит в корзину, а лежавшее до старта — нет', async () => {
    mkdirSync(dir, { recursive: true });
    // Событие, лежавшее в журнале ДО старта сборщика.
    writeFileSync(
      join(dir, 'critical-events.ndjson'),
      `${JSON.stringify(event({ id: 'old-evt', fingerprint: 'fp-old', createdAt: Date.now() - 60_000 }))}\n`,
      'utf-8',
    );
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: '{"id":1}' }));
    const collector = createKarmanBasketCollector(collectorDeps(impl));
    collector.prime(listCriticalEvents({ days: 3, limit: 100 }));
    await collector.tick();
    expect(calls).toHaveLength(0);

    // Новое событие после старта — уходит.
    writeFileSync(
      join(dir, 'critical-events.ndjson'),
      `${JSON.stringify(event({ id: 'old-evt', fingerprint: 'fp-old', createdAt: Date.now() - 60_000 }))}\n${JSON.stringify(
        event({ id: 'new-evt', fingerprint: 'fp-new', createdAt: Date.now() }),
      )}\n`,
      'utf-8',
    );
    await collector.tick();
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.init.body)).toContain('Критическое событие');
  });

  it('журнал отправок лежит рядом с журналом событий и помнит, что ушло', async () => {
    const { impl } = fakeFetch(() => ({ status: 201, body: '{"id":9}' }));
    const collector = createKarmanBasketCollector(collectorDeps(impl));
    await collector.handleEvent(event({ id: 'evt-1', fingerprint: 'fp-write' }));
    const raw = readFileSync(join(dir, 'critical-events-basket.ndjson'), 'utf-8');
    const rows = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { fingerprint: string; promptId: number | null });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fingerprint).toBe('fp-write');
    expect(rows[0]?.promptId).toBe(9);
  });
});
