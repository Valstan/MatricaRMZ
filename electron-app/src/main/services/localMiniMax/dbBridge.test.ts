import { connect } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createSqliteReader, startLocalDbBridge, type LocalDbBridge } from './dbBridge.js';

// Мост «реплика → агент»: базу держит приложение (она зашифрована), агент спрашивает
// по именованному каналу. Проверяем ровно три вещи: чтение проходит, запись
// отбивается, а чужой токен в канал не пускает.

const bridges: LocalDbBridge[] = [];

afterEach(() => {
  while (bridges.length) bridges.pop()!.close();
});

function ask(pipePath: string, token: string, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...(request as object), token })}\n`));
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, index)));
      } catch (e) {
        reject(e);
      }
    });
    socket.on('error', reject);
  });
}

describe('мост к локальной реплике', () => {
  it('читает и отдаёт строки', async () => {
    const reader = {
      tables: () => ['operations', 'entities'],
      query: () => ({ columns: ['id', 'name'], rows: [['1', 'Иваныч']] }),
    };
    const bridge = startLocalDbBridge(reader);
    bridges.push(bridge);

    const reply = await ask(bridge.pipePath, bridge.token, { type: 'query', sql: 'SELECT 1' });
    expect(reply.ok).toBe(true);
    expect(reply.columns).toEqual(['id', 'name']);
    expect(reply.rows).toEqual([['1', 'Иваныч']]);

    const schema = await ask(bridge.pipePath, bridge.token, { type: 'schema' });
    expect(schema.tables).toEqual(['operations', 'entities']);
  });

  it('чужой токен в канал не пускает', async () => {
    const bridge = startLocalDbBridge({ tables: () => [], query: () => ({ columns: [], rows: [] }) });
    bridges.push(bridge);

    const reply = await ask(bridge.pipePath, 'чужой-токен', { type: 'query', sql: 'SELECT 1' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('токен');
  });

  it('оператор записи отбивается: мост читает, а не пишет', () => {
    const reader = createSqliteReader({
      prepare: (sql: string) => ({
        reader: !/^\s*(insert|update|delete|drop|alter|create)/i.test(sql),
        all: () => [{ id: 1 }],
      }),
    });

    const read = reader.query('SELECT * FROM entities');
    expect('rows' in read).toBe(true);

    const write = reader.query('DELETE FROM entities');
    expect('error' in write).toBe(true);
    if ('error' in write) expect(write.error).toContain('только чтение');
  });

  it('список таблиц моста — из sqlite_master', () => {
    const reader = createSqliteReader({
      prepare: () => ({ reader: true, all: () => [{ name: 'entities' }, { name: 'operations' }] }),
    });
    expect(reader.tables()).toEqual(['entities', 'operations']);
  });
});
