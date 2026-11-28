// MCP-сервер «matrica-actions»: действия агента в программе.
//
// Живёт в ресурсах клиента и запускается самим MiniMax Code (конфиг `.mcp.json` в
// рабочем каталоге прогона). Речи не читает: только спрашивает приложение по
// ИМЕНОВАННОМУ каналу действий.
//
// ОТДЕЛЬНО ОТ «matrica-db». Чтение базы и действия — разные контуры и разные каналы:
// мост к базе read-only по замыслу (писать в реплику агент не может), а действия
// идут отдельным каналом со своим токеном (решение владельца, промт КАРМАНА #176).
//
// СПИСОК ИНСТРУМЕНТОВ НЕ ЗДЕСЬ. Сервер спрашивает у приложения — поэтому набор
// инструментов один (общий реестр программы), и вторая копия списка невозможна.
//
// Протокол — MCP поверх stdio: JSON-RPC 2.0, сообщения — по одной строке.

import { connect } from 'node:net';

const PIPE_PATH = process.env.MATRICA_ACTIONS_PIPE ?? '';
const TOKEN = process.env.MATRICA_ACTIONS_TOKEN ?? '';

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

/** Один запрос к каналу действий в приложении. */
function ask(request) {
  return new Promise((resolve) => {
    if (!PIPE_PATH) {
      resolve({ ok: false, error: 'канал действий не настроен (нет MATRICA_ACTIONS_PIPE)' });
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
        finish({ ok: false, error: `приложение ответило неразборчиво: ${String(e)}` });
      }
    });
    socket.on('error', (e) => finish({ ok: false, error: `канал действий недоступен: ${String(e)}` }));
    socket.on('close', () => finish({ ok: false, error: 'приложение закрыло соединение' }));
  });
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function listTools() {
  const answer = await ask({ type: 'tools' });
  if (!answer.ok) return null;
  return Array.isArray(answer.tools) ? answer.tools : [];
}

async function callTool(name, args) {
  const answer = await ask({ type: 'action', tool: name, args: args ?? {} });
  if (!answer.ok) return { isError: true, ...text(answer.error) };
  const result = answer.result ?? {};
  return text(String(result.summary ?? ''));
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
        serverInfo: { name: 'matrica-actions', version: '1.0.0' },
      });
      return;
    }
    if (method === 'ping') {
      reply(id, {});
      return;
    }
    if (method === 'tools/list') {
      const tools = await listTools();
      reply(id, { tools: tools ?? [] });
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
