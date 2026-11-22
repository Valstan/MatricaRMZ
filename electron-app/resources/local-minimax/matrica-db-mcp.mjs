// MCP-сервер «matrica-db»: read-only доступ локального агента к реплике базы завода.
//
// Живёт в ресурсах клиента и запускается самим MiniMax Code (конфиг `.mcp.json`
// в рабочем каталоге прогона). Речи не читает — только спрашивает приложение по
// именованному каналу: база зашифрована, а её ключ доступен только Electron.
//
// Протокол — MCP поверх stdio: JSON-RPC 2.0, сообщения — по одной строке.
// Инструменты: db_schema (список таблиц), db_table (колонки и первые строки),
// db_query (SELECT — и только SELECT: мост сам отбивает запись).

import { connect } from 'node:net';

const PIPE_PATH = process.env.MATRICA_DB_PIPE ?? '';
const TOKEN = process.env.MATRICA_DB_TOKEN ?? '';

const TOOLS = [
  {
    name: 'db_schema',
    description: 'Список таблиц локальной базы завода (реплика на машине оператора).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'db_table',
    description: 'Колонки и первые строки таблицы базы завода.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Имя таблицы (как в db_schema).' },
        limit: { type: 'number', description: 'Сколько строк показать (по умолчанию 20).' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'db_query',
    description:
      'SELECT-запрос к базе завода. Только чтение: INSERT/UPDATE/DELETE отклоняются мостом.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Текст SELECT-запроса.' },
        params: { type: 'array', items: {}, description: 'Параметры запроса (?, ?).' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

/** Один запрос к мосту в приложении. */
function ask(request) {
  return new Promise((resolve) => {
    if (!PIPE_PATH) {
      resolve({ ok: false, error: 'мост к базе не настроен (нет MATRICA_DB_PIPE)' });
      return;
    }
    const socket = connect(PIPE_PATH);
    let buffer = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* уже закрыт */
      }
      resolve(value);
    };
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ ...request, token: TOKEN })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, index)));
      } catch (e) {
        finish({ ok: false, error: `мост ответил неразборчиво: ${String(e)}` });
      }
    });
    socket.on('error', (e) => finish({ ok: false, error: `мост недоступен: ${String(e)}` }));
    socket.on('close', () => finish({ ok: false, error: 'мост закрыл соединение' }));
  });
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function formatRows(columns, rows) {
  if (!rows.length) return `пусто (колонки: ${columns.join(', ')})`;
  const lines = [columns.join(' | ')];
  for (const row of rows) {
    lines.push(columns.map((column) => String(row[columns.indexOf(column)] ?? '')).join(' | '));
  }
  return lines.join('\n');
}

async function callTool(name, args) {
  if (name === 'db_schema') {
    const reply = await ask({ type: 'schema' });
    if (!reply.ok) return { isError: true, ...text(reply.error) };
    return text(`Таблицы: ${(reply.tables ?? []).join(', ')}`);
  }
  if (name === 'db_table') {
    const table = String(args?.table ?? '');
    if (!table) return { isError: true, ...text('нужно имя таблицы') };
    const limit = Number(args?.limit ?? 20);
    const reply = await ask({ type: 'query', sql: `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ?`, params: [limit] });
    if (!reply.ok) return { isError: true, ...text(reply.error) };
    return text(formatRows(reply.columns ?? [], reply.rows ?? []));
  }
  if (name === 'db_query') {
    const sql = String(args?.sql ?? '');
    if (!sql.trim()) return { isError: true, ...text('пустой запрос') };
    const reply = await ask({ type: 'query', sql, params: args?.params ?? [] });
    if (!reply.ok) return { isError: true, ...text(reply.error) };
    return text(formatRows(reply.columns ?? [], reply.rows ?? []));
  }
  return { isError: true, ...text(`неизвестный инструмент: ${name}`) };
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});

async function handle(message) {
  const { id, method, params } = message ?? {};
  if (id === undefined) return; // уведомление — ответа не требуется
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'matrica-db', version: '1.0.0' },
      });
      return;
    }
    if (method === 'ping') {
      reply(id, {});
      return;
    }
    if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const result = await callTool(String(params?.name ?? ''), params?.arguments ?? {});
      reply(id, result);
      return;
    }
    replyError(id, `неизвестный метод: ${String(method)}`);
  } catch (e) {
    replyError(id, String(e));
  }
}
