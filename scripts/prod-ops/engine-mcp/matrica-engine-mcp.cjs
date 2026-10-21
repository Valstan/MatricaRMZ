'use strict';
// MCP-прокси серверного движка (контур A).
//
// Движок запускает этот файл как локальный MCP-сервер (stdio, JSON-RPC), а он
// перекладывает вызовы инструментов в loopback-мост бэкенда Матрицы
// (backend-api/src/services/ai/serverEngineTools.ts). Отдельный процесс нужен
// потому, что движку нужен stdio-сервер, а права сотрудника и доступ к базе
// живут в процессе бэкенда — отдавать их движку нельзя.
//
// Зависимостей нет: на боксе это просто node + fetch.
const readline = require('node:readline');

const url = (process.env.MATRICA_TOOLS_URL || 'http://127.0.0.1:49390').replace(/\/+$/, '');
const token = process.env.MATRICA_TOOLS_TOKEN || '';

const send = (msg) => {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch {
    // движок закрыл поток — молча выходим
  }
};

async function fetchTools() {
  const res = await fetch(`${url}/tools`, {
    headers: { 'x-matrica-token': token },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (!body || !Array.isArray(body.tools)) throw new Error('мост не отдал каталог инструментов');
  return body.tools;
}

async function callTool(name, args) {
  try {
    const res = await fetch(`${url}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-matrica-token': token },
      body: JSON.stringify({ name, args: args || {} }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.json();
    if (!body || body.ok !== true) {
      return {
        isError: true,
        content: [{ type: 'text', text: String((body && body.error) || 'ошибка инструмента') }],
      };
    }
    const data = body.data || {};
    return {
      ...(data.isError ? { isError: true } : {}),
      content: [{ type: 'text', text: String(data.content ?? '') }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'мост инструментов недоступен: ' + String((e && e.message) || e) }],
    };
  }
}

async function handle(req) {
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: (req.params && req.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'matrica', version: '1.0.0' },
      },
    });
    return;
  }
  if (req.method === 'tools/list') {
    let tools = [];
    try {
      tools = await fetchTools();
    } catch (e) {
      process.stderr.write('matrica-mcp: tools/list failed: ' + String((e && e.message) || e) + '\n');
    }
    send({ jsonrpc: '2.0', id: req.id, result: { tools } });
    return;
  }
  if (req.method === 'tools/call') {
    const params = req.params || {};
    const result = await callTool(params.name, params.arguments);
    send({ jsonrpc: '2.0', id: req.id, result });
    return;
  }
  send({ jsonrpc: '2.0', id: req.id, result: {} });
}

const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  // Уведомления (без id) подтверждения не требуют, но и терять порядок нельзя.
  if (req.id === undefined || req.id === null) return;
  chain = chain.then(() => handle(req)).catch((e) => {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String((e && e.message) || e) } });
  });
});
