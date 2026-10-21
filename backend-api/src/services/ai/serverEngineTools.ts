import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { logError, logInfo } from '../../utils/logger.js';
import { IIVANYCH_TOOLS, runIivanychTool, type IivanychAnswerSide } from './iivanychTools.js';
import { FULL_TOOL_NAMES, executeTool, getToolDefinitions, type ToolContext, type ToolResult } from './llmTools.js';
import type { LlmToolDef, LlmToolUse } from './llmProvider.js';

/**
 * Мост инструментов для серверного движка (контур A).
 *
 * Движок живёт отдельным процессом под своим пользователем и до базы Матрицы не
 * дотягивается. Инструменты он получает так же, как клиентский контур B: движок
 * запускает MCP-прокси (stdio), а прокси перекладывает вызов в этот loopback-мост.
 * Мост исполняет РОВНО те же инструменты, что и путь DeepSeek, с правами
 * спросившего сотрудника — то есть прав движка на базу нет, а права человека есть.
 *
 * Активная задача одна: серверный воркер обрабатывает очередь последовательно
 * (и только на primary), поэтому «чей сейчас контекст» не гадается, а задаётся
 * на время ответа. Вызов без активной задачи честно отбивается — иначе движок,
 * пережив таймаут, мог бы дёргать инструменты от имени прошлого вопроса.
 */

export type EngineTask = {
  toolCtx: ToolContext;
  side: IivanychAnswerSide;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: LlmToolDef['input_schema'];
};

const BODY_LIMIT_BYTES = 1_000_000;

function envText(name: string, fallback: string): string {
  const value = String(process.env[name] ?? '').trim();
  return value || fallback;
}

function envNum(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Порт моста на loopback: движок и бэкенд живут на одной машине. */
const BRIDGE_PORT = envNum('AI_SERVER_ENGINE_TOOLS_PORT', 49_390);
const BRIDGE_TOKEN = envText('AI_SERVER_ENGINE_TOOLS_TOKEN', '');

let bridge: Server | null = null;
let activeTask: EngineTask | null = null;

/**
 * Каталог инструментов в форме MCP. Собирается из тех же определений, что уходят
 * DeepSeek, поэтому набор не может разъехаться между двумя путями ответа.
 */
export function mcpToolCatalog(): McpTool[] {
  return [...getToolDefinitions(FULL_TOOL_NAMES), ...IIVANYCH_TOOLS].map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.input_schema,
  }));
}

/**
 * Выполнить работу движка с одним активным контекстом инструментов. Вложенный
 * вызов — ошибка: значит, кто-то запустил второй ответ поверх первого.
 */
export async function withEngineTask<T>(task: EngineTask, run: () => Promise<T>): Promise<T> {
  if (activeTask) throw new Error('серверный движок уже занят другой задачей');
  activeTask = task;
  try {
    return await run();
  } finally {
    activeTask = null;
  }
}

async function dispatchTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const task = activeTask;
  if (!task) {
    return {
      content: 'Движок вне активной задачи: инструменты доступны только во время ответа сотруднику.',
      isError: true,
    };
  }
  const toolUse: LlmToolUse = { id: `engine_${name}`, name, input };
  const own = await runIivanychTool(toolUse, task.side);
  if (own) return own;
  return executeTool(toolUse, task.toolCtx);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > BODY_LIMIT_BYTES) throw new Error('слишком большой запрос инструмента');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (String(req.headers['x-matrica-token'] ?? '') !== BRIDGE_TOKEN) {
    sendJson(res, 401, { error: 'токен моста не принят' });
    return;
  }
  const path = String(req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === '/tools') {
    sendJson(res, 200, { tools: mcpToolCatalog() });
    return;
  }
  if (req.method === 'POST' && path === '/tool') {
    let payload: { name?: string; args?: Record<string, unknown> };
    try {
      payload = JSON.parse(await readBody(req)) as { name?: string; args?: Record<string, unknown> };
    } catch (e) {
      sendJson(res, 400, { error: `запрос не разобран: ${String(e)}` });
      return;
    }
    const name = String(payload?.name ?? '').trim();
    if (!name) {
      sendJson(res, 400, { error: 'не указан инструмент' });
      return;
    }
    const input = payload?.args && typeof payload.args === 'object' ? payload.args : {};
    const result = await dispatchTool(name, input);
    logInfo('server engine tool', { name, isError: !!result.isError, bytes: result.content.length });
    sendJson(res, 200, { ok: true, data: { content: result.content, isError: !!result.isError } });
    return;
  }
  sendJson(res, 404, { error: 'нет такого пути' });
}

export function startServerEngineToolsBridge(): void {
  if (bridge) return;
  if (!BRIDGE_TOKEN) {
    logError('server engine tools: не задан AI_SERVER_ENGINE_TOOLS_TOKEN — мост не поднят', {});
    return;
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      logError('server engine tools: handler failed', { error: String(e) });
      if (!res.headersSent) sendJson(res, 500, { error: String(e) });
      else res.end();
    });
  });
  server.on('error', (e) => logError('server engine tools: bridge error', { error: String(e) }));
  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    logInfo('server engine tools: bridge listening', { port: BRIDGE_PORT, tools: mcpToolCatalog().length }, { critical: true });
  });
  bridge = server;
}

export function stopServerEngineToolsBridge(): void {
  if (!bridge) return;
  bridge.close();
  bridge = null;
}
