// Мост «локальная реплика → локальный агент» (D-243, решение владельца № 4).
//
// Агенту нужен read-only доступ к базе завода, но открыть базу из отдельного процесса
// нельзя: она зашифрована (SQLCipher), а ключ лежит под DPAPI и доступен только
// Electron. Поэтому базу держит приложение, а агент спрашивает его по ИМЕНОВАННОМУ
// каналу (Windows pipe) — без порта, без правила брандмауэра и без копии ключа на диске.
//
// Правило записи зашито здесь: готовится ТОЛЬКО оператор чтения (better-sqlite3
// `Statement.reader`), всё остальное — отказ. Писать в реплику агент не может.

import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

export type LocalDbReader = {
  /** Таблицы реплики. */
  tables(): string[];
  /** Выполнить ТОЛЬКО чтение. Реализация сама отбивает запись. */
  query(sql: string, params?: unknown[]): { columns: string[]; rows: unknown[][] } | { error: string };
};

export type LocalDbBridge = {
  /** Путь именованного канала: его агент получает в `.mcp.json`. */
  pipePath: string;
  /** Токен канала: без него запросы не принимаются. */
  token: string;
  close(): void;
};

const MAX_ROWS = 500;

function pipeName(): string {
  return `\\\\.\\pipe\\matricarmz-local-minimax-${randomBytes(6).toString('hex')}`;
}

/** Ответ моста на один запрос. */
export type BridgeReply =
  | { ok: true; columns: string[]; rows: unknown[][] }
  | { ok: true; tables: string[] }
  | { ok: false; error: string };

function handleRequest(reader: LocalDbReader, request: any): BridgeReply {
  if (!request || typeof request !== 'object') return { ok: false, error: 'плохой запрос' };
  if (request.type === 'schema') return { ok: true, tables: reader.tables() };
  if (request.type !== 'query') return { ok: false, error: 'неизвестный тип запроса' };
  const sql = typeof request.sql === 'string' ? request.sql : '';
  if (!sql.trim()) return { ok: false, error: 'пустой запрос' };
  const params = Array.isArray(request.params) ? request.params : [];
  const result = reader.query(sql, params);
  if ('error' in result) return { ok: false, error: result.error };
  return {
    ok: true,
    columns: result.columns,
    rows: result.rows.slice(0, MAX_ROWS),
  };
}

/**
 * Читатель поверх better-sqlite3. Запись отбивается самим SQLite: готовится только
 * оператор чтения (`Statement.reader`), всё остальное — отказ.
 */
export function createSqliteReader(client: {
  prepare(sql: string): { reader: boolean; all(...params: unknown[]): unknown[] };
}): LocalDbReader {
  return {
    tables() {
      try {
        const rows = client
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as { name: string }[];
        return rows.map((row) => String(row.name));
      } catch {
        return [];
      }
    },
    query(sql, params) {
      let statement: { reader: boolean; all(...params: unknown[]): unknown[] };
      try {
        statement = client.prepare(sql);
      } catch (e) {
        return { error: `запрос не готовится: ${String(e)}` };
      }
      if (!statement.reader) {
        return { error: 'только чтение: оператор не возвращает строки' };
      }
      try {
        const rows = statement.all(...(params ?? [])) as Record<string, unknown>[];
        const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
        return { columns, rows: rows.map((row) => columns.map((column) => row[column])) };
      } catch (e) {
        return { error: `запрос не выполнен: ${String(e)}` };
      }
    },
  };
}

/**
 * Поднять мост. Канал одноразовый на сессию приложения: имя содержит случайный хвост,
 * поэтому вторая копия программы не столкнётся с первой.
 */
export function startLocalDbBridge(reader: LocalDbReader): LocalDbBridge {
  const pipePath = pipeName();
  const token = randomBytes(24).toString('hex');
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        let reply: BridgeReply;
        try {
          const request = JSON.parse(line);
          if (request?.token !== token) {
            reply = { ok: false, error: 'токен канала не совпал' };
          } else {
            reply = handleRequest(reader, request);
          }
        } catch (e) {
          reply = { ok: false, error: `неразборчивый запрос: ${String(e)}` };
        }
        socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });

  server.listen(pipePath);
  server.on('error', () => {
    // Канал не поднялся — агент просто не получит доступ к базе, а не уронит программу.
  });

  return {
    pipePath,
    token,
    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
    },
  };
}
