import { beforeEach, describe, expect, it, vi } from 'vitest';

// Журнал в PostgreSQL (план ledger-journal-in-pg). Здесь под тестом ровно те свойства, которые
// нельзя проверить глазами и цена ошибки в которых — молча разъехавшийся клиент:
//   1) курсор берётся из максимума ЗАПИСАННЫХ строк, а не из счётчика последовательности;
//   2) занятый номер лечится и повторяется, а не отдаётся наверх отказом;
//   3) в строку журнала попадают штамп номера и актор.

type Executed = { text: string };

const world = {
  executed: [] as Executed[],
  maxSeq: 0,
  nextSeqStart: 1,
  inserted: [] as Array<Record<string, unknown>>,
  insertFailures: [] as Array<unknown>,
  transactions: 0,
};

/** Текст запроса из drizzle-шаблона `sql` — по нему тесты и отличают запросы друг от друга. */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown })?.value;
      if (Array.isArray(v)) return v.join('');
      if (typeof c === 'string') return c;
      return '';
    })
    .join(' ');
}

/** Скалярные параметры шаблона — у `generate_series(1, ${n})` это и есть размер пачки. */
function sqlParams(q: unknown): unknown[] {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .filter((c) => !!c && typeof c === 'object' && 'value' in (c as Record<string, unknown>) && !Array.isArray((c as { value: unknown }).value))
    .map((c) => (c as { value: unknown }).value);
}

async function runExecute(q: unknown) {
  const text = sqlText(q);
  world.executed.push({ text });
  if (text.includes('max(server_seq)') && !text.includes('setval')) {
    return { rows: [{ seq: String(world.maxSeq), gap: '0' }] };
  }
  if (text.includes('nextval')) {
    const batch = Math.max(1, Number(sqlParams(q)[0] ?? 1));
    const rows: Array<{ seq: string }> = [];
    for (let i = 0; i < batch; i += 1) rows.push({ seq: String(world.nextSeqStart + i) });
    world.nextSeqStart += batch;
    return { rows };
  }
  return { rows: [] };
}

const txMock = {
  execute: vi.fn(async (q: unknown) => runExecute(q)),
  insert: vi.fn(() => ({
    values: vi.fn(async (rows: Array<Record<string, unknown>>) => {
      const failure = world.insertFailures.shift();
      if (failure) throw failure;
      world.inserted.push(...rows);
      for (const r of rows) world.maxSeq = Math.max(world.maxSeq, Number(r.serverSeq));
      return undefined;
    }),
  })),
};

vi.mock('../database/db.js', () => ({
  db: {
    execute: vi.fn(async (q: unknown) => runExecute(q)),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      world.transactions += 1;
      return cb(txMock);
    }),
    select: vi.fn(() => ({ from: vi.fn(async () => []) })),
  },
  pool: {},
}));

const actor = { userId: 'u-1', username: 'operator', role: 'user' };

function payload(over: Record<string, unknown> = {}) {
  return {
    type: 'upsert' as const,
    table: 'entities' as const,
    row: { id: '11111111-1111-4111-8111-111111111111', name: 'деталь' },
    actor,
    ts: 1700,
    ...over,
  };
}

function duplicateSeqError(over: Record<string, unknown> = {}) {
  return Object.assign(new Error('duplicate key value violates unique constraint "ledger_tx_index_pkey"'), {
    code: '23505',
    constraint: 'ledger_tx_index_pkey',
    ...over,
  });
}

beforeEach(() => {
  world.executed = [];
  world.inserted = [];
  world.insertFailures = [];
  world.maxSeq = 0;
  world.nextSeqStart = 1;
  world.transactions = 0;
  vi.clearAllMocks();
});

describe('getLedgerLastSeq — курсор клиента', () => {
  it('берёт максимум записанных строк, а НЕ last_value последовательности', async () => {
    const { getLedgerLastSeq } = await import('./ledgerService.js');
    world.maxSeq = 1_557_929;
    expect(await getLedgerLastSeq()).toBe(1_557_929);
    const q = world.executed.at(-1)?.text ?? '';
    expect(q).toContain('max(server_seq)');
    // Сторож свойства, а не реализации: last_value уходит выше последней записанной строки на
    // каждом откате (nextval не транзакционен). Отдав его курсором, мы перепрыгнули бы строки,
    // которые ещё коммитятся, и клиент не увидел бы их никогда.
    expect(q).not.toContain('last_value');
  });

  it('пустой журнал — ноль, а не NaN', async () => {
    const { getLedgerLastSeq } = await import('./ledgerService.js');
    world.maxSeq = 0;
    expect(await getLedgerLastSeq()).toBe(0);
  });
});

describe('signAndAppendDetailed — запись в журнал', () => {
  it('штампует номер и актора в строку журнала', async () => {
    const { signAndAppendDetailed } = await import('./ledgerService.js');
    world.nextSeqStart = 42;
    const res = await signAndAppendDetailed([payload()]);

    expect(res.applied).toBe(1);
    expect(res.lastSeq).toBe(42);
    expect(res.blockHeight).toBe(0);
    expect(world.inserted).toHaveLength(1);
    const row = world.inserted[0]!;
    expect(row.serverSeq).toBe(42);
    expect(row.tableName).toBe('entities');
    expect(row.op).toBe('upsert');
    expect(row.actorUserId).toBe('u-1');
    expect(row.actorUsername).toBe('operator');
    // Штамп внутри payload обязателен: pullChangesSince отдаёт эту строку клиенту как есть,
    // и без last_server_seq клиент не сможет продвинуть курсор по не-sync таблице.
    expect(JSON.parse(String(row.payloadJson)).last_server_seq).toBe(42);
  });

  it('удаление без строки пишет тумстоун с id и меткой времени', async () => {
    const { signAndAppendDetailed } = await import('./ledgerService.js');
    world.nextSeqStart = 7;
    await signAndAppendDetailed([
      { type: 'delete', table: 'entities', row_id: '22222222-2222-4222-8222-222222222222', actor, ts: 900 } as never,
    ]);
    const body = JSON.parse(String(world.inserted[0]!.payloadJson));
    expect(world.inserted[0]!.op).toBe('delete');
    expect(body.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(body.deleted_at).toBe(900);
    expect(body.last_server_seq).toBe(7);
  });

  it('транзакция без row_id отвергается до записи', async () => {
    const { signAndAppendDetailed } = await import('./ledgerService.js');
    await expect(signAndAppendDetailed([{ type: 'upsert', table: 'entities', row: {}, actor, ts: 1 } as never])).rejects.toThrow(
      /ledger_tx_without_row_id/,
    );
    expect(world.transactions).toBe(0);
  });

  it('пустой список не открывает транзакцию', async () => {
    const { signAndAppendDetailed } = await import('./ledgerService.js');
    const res = await signAndAppendDetailed([]);
    expect(res).toMatchObject({ applied: 0, blockHeight: 0 });
    expect(world.transactions).toBe(0);
  });
});

describe('занятый номер — лечится, а не отдаётся отказом', () => {
  it('дубликат ключа: поднимает последовательность и повторяет запись', async () => {
    const { signAndAppendDetailed } = await import('./ledgerService.js');
    world.insertFailures = [duplicateSeqError()];
    world.nextSeqStart = 100;

    const res = await signAndAppendDetailed([payload()]);

    expect(res.applied).toBe(1);
    expect(world.transactions).toBe(2);
    // Между попытками обязан пройти setval — иначе повтор возьмёт тот же занятый номер.
    expect(world.executed.some((e) => e.text.includes('setval'))).toBe(true);
  });

  it('дубликат, завёрнутый обёрткой драйвера, тоже распознаётся', async () => {
    const { signAndAppendDetailed } = await import('./ledgerService.js');
    world.insertFailures = [Object.assign(new Error('query failed'), { cause: duplicateSeqError() })];
    const res = await signAndAppendDetailed([payload()]);
    expect(res.applied).toBe(1);
    expect(world.transactions).toBe(2);
  });

  it('чужая ошибка НЕ повторяется и уходит наверх как есть', async () => {
    const { signAndAppendDetailed } = await import('./ledgerService.js');
    world.insertFailures = [Object.assign(new Error('violates foreign key constraint'), { code: '23503' })];
    await expect(signAndAppendDetailed([payload()])).rejects.toThrow(/foreign key/);
    expect(world.transactions).toBe(1);
    expect(world.executed.some((e) => e.text.includes('setval'))).toBe(false);
  });

  it('дубликат не лечится бесконечно — после трёх попыток ошибка уходит наверх', async () => {
    const { signAndAppendDetailed } = await import('./ledgerService.js');
    world.insertFailures = [duplicateSeqError(), duplicateSeqError(), duplicateSeqError()];
    await expect(signAndAppendDetailed([payload()])).rejects.toThrow(/duplicate key/);
    expect(world.transactions).toBe(3);
  });
});
