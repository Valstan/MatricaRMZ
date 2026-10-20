import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

/**
 * Read-only доступ локального Ииваныча к базе (контур B).
 *
 * Модель не получает ни файла базы, ни ключа: она зовёт инструменты, а запросы
 * исполняет клиент. Запрос обязан быть читающим — это проверяет сам SQLite
 * (`Statement.readonly`), а не регулярка по тексту, поэтому `DROP` из строкового
 * литерала не пролезет и не притворится SELECT'ом.
 *
 * Транспорт — loopback-HTTP с одноразовым токеном: движок запускает рядом
 * маленький MCP-прокси, тот стучится сюда. Наружу порт не слушает.
 */

export const AI_TOOLS = [
  {
    name: 'db_schema',
    description:
      'Список таблиц локальной базы и их колонок. Можно передать filter — подстроку имени таблицы (например "engine", "stock").',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'подстрока имени таблицы' } },
      additionalProperties: false,
    },
  },
  {
    name: 'db_query',
    description:
      'Выполнить один читающий SQL-запрос (SELECT/WITH) к локальной базе. Возвращает до 200 строк. Пишущие запросы запрещены.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'один SELECT-запрос' },
        limit: { type: 'number', description: 'сколько строк вернуть, по умолчанию 50, максимум 200' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'db_table',
    description: 'Первые строки таблицы по её имени — чтобы быстро посмотреть, что внутри.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'имя таблицы' },
        limit: { type: 'number', description: 'сколько строк вернуть, по умолчанию 20, максимум 200' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
] as const;

export type AiToolName = (typeof AI_TOOLS)[number]['name'];

const MAX_ROWS = 200;

type SqliteLike = {
  prepare: (sql: string) => { readonly: boolean; all: (...params: unknown[]) => unknown[] };
};

function clampLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_ROWS);
}

/** Один читающий запрос; дописываем LIMIT, если модель его не поставила. */
export function readOnlySql(raw: string, limit: number): string {
  const sql = String(raw ?? '').trim().replace(/;+\s*$/, '');
  if (!sql) throw new Error('пустой запрос');
  if (sql.includes(';')) throw new Error('только один запрос за раз');
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('разрешены только SELECT/WITH');
  return /\blimit\b/i.test(sql) ? sql : `${sql} LIMIT ${clampLimit(limit, 50)}`;
}

export function tableRowsSql(table: string, limit: number): string {
  const name = String(table ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('имя таблицы с недопустимыми символами');
  return `SELECT * FROM "${name}" LIMIT ${clampLimit(limit, 20)}`;
}

export function runTool(sqlite: SqliteLike, name: string, args: Record<string, unknown>): unknown {
  if (name === 'db_schema') {
    const filter = String(args.filter ?? '').trim().toLowerCase();
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`)
      .all() as Array<{ name: string }>;
    return tables
      .filter((t) => !filter || String(t.name).toLowerCase().includes(filter))
      .slice(0, 200)
      .map((t) => {
        const cols = sqlite.prepare(`PRAGMA table_info("${String(t.name).replace(/"/g, '""')}")`).all() as Array<{
          name: string;
          type: string;
        }>;
        return { table: t.name, columns: cols.map((c) => `${c.name} ${c.type}`.trim()) };
      });
  }

  const sql =
    name === 'db_table'
      ? tableRowsSql(String(args.table ?? ''), Number(args.limit))
      : readOnlySql(String(args.sql ?? ''), Number(args.limit));

  const stmt = sqlite.prepare(sql);
  if (!stmt.readonly) throw new Error('запрос пишущий — в базе разрешено только чтение');
  return stmt.all().slice(0, MAX_ROWS);
}

export type AiToolsBridge = { url: string; token: string; close: () => Promise<void> };

/** Поднимает loopback-мост для MCP-прокси. Один на запуск клиента. */
export async function startAiToolsBridge(getSqlite: () => SqliteLike | null): Promise<AiToolsBridge> {
  const token = randomBytes(24).toString('hex');
  const server: Server = createServer((req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/tool') return reply(404, { ok: false, error: 'not found' });
    if (req.headers['x-matrica-token'] !== token) return reply(403, { ok: false, error: 'forbidden' });

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name?: string; args?: Record<string, unknown> };
        const sqlite = getSqlite();
        if (!sqlite) return reply(503, { ok: false, error: 'база ещё не открыта' });
        const data = runTool(sqlite, String(body.name ?? ''), body.args ?? {});
        reply(200, { ok: true, data });
      } catch (e) {
        reply(200, { ok: false, error: String((e as Error)?.message ?? e) });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/tool`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
