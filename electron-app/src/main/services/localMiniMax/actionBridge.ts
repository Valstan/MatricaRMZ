// Канал действий агента — ОТДЕЛЬНЫЙ именованный канал, свой токен.
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ МОСТА К БАЗЕ. Мост «реплика → агент» — read-only по замыслу:
// «писать в реплику агент не может» (решение владельца, D-243). Если бы действия
// агента шли по нему, мост перестал бы быть read-only по духу — и это закрытое
// решение владельца, а не деталь реализации.
//
// ЧТО МОЖЕТ КАНАЛ. Только зарегистрированные инструменты из общего реестра
// (`agentTools/registry.ts`). «Универсального канала вызова любого IPC» здесь нет:
// гейт разделов работает по префиксам каналов, такой канал под них не попал бы — и
// обошёл бы гейт.
//
// ТОКЕН. Свой, и он не кладётся на диск: агент получает его в `.mcp.json` на время
// прогона. Канал одноразовый на сессию приложения — в имени случайный хвост, поэтому
// вторая копия программы не столкнётся с первой.

import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import { BrowserWindow } from 'electron';

import type { IpcContext } from '../../ipc/ipcContext.js';
import { agentToolMcpTools, runAgentTool } from './agentTools/registry.js';
import type { AgentToolArgs } from './agentTools/types.js';

/** Канал, по которому окно узнаёт, что список номеров готов. */
export const PREPARED_ADD_EVENT = 'agentActions:preparedAdd';

export type ActionBridge = {
  /** Путь именованного канала: его агент получает в `.mcp.json`. */
  pipePath: string;
  /** Токен канала: без него запросы не принимаются. */
  token: string;
  close(): void;
};

/** Что приходит по каналу действий. */
export type ActionBridgeRequest =
  | { type: 'tools' }
  | { type: 'action'; tool: string; args?: AgentToolArgs };

/** Что уходит по каналу действий. */
export type ActionBridgeReply =
  | { ok: true; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }
  | { ok: true; result: { summary: string; data?: Record<string, unknown> } }
  | { ok: false; error: string };

function pipeName(): string {
  return `\\\\.\\pipe\\matricarmz-local-actions-${randomBytes(6).toString('hex')}`;
}

/**
 * Разбор запроса.
 *
 * ВАЖНО: «prepared» (подготовленный список номеров) в ответ агенту НЕ уходит: номера
 * из файла — данные оператора, и выкладывать их в облако мимо его воли не надо.
 * В окно они уходят отдельным событием.
 */
async function handleRequest(ctx: IpcContext, request: any): Promise<ActionBridgeReply> {
  if (!request || typeof request !== 'object') return { ok: false, error: 'плохой запрос' };
  if (request.type === 'tools') return { ok: true, tools: agentToolMcpTools() };
  if (request.type !== 'action') return { ok: false, error: 'неизвестный тип запроса' };
  const tool = String(request.tool ?? '');
  if (!tool.trim()) return { ok: false, error: 'не указан инструмент' };
  const args = (request.args && typeof request.args === 'object' ? request.args : {}) as AgentToolArgs;
  const result = await runAgentTool(ctx, tool, args);
  if (!result.ok) return { ok: false, error: result.error };
  if (result.prepared) broadcastPrepared(result.prepared);
  return {
    ok: true,
    result: { summary: result.summary, ...(result.data ? { data: result.data } : {}) },
  };
}

/** Сказать окнам: список готов. Окно «Добавить списком» его подхватит. */
export function broadcastPrepared(prepared: unknown): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(PREPARED_ADD_EVENT, prepared);
    }
  } catch {
    // окно могло закрыться — список дождётся следующего открытия (пачка лежит в main).
  }
}

/**
 * Поднять канал действий. Канал одноразовый на сессию приложения: имя содержит
 * случайный хвост, поэтому вторая копия программы не столкнётся с первой.
 */
export function startActionBridge(ctx: IpcContext): ActionBridge {
  const pipePath = pipeName();
  const channelToken = randomBytes(24).toString('hex');
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
        let request: unknown;
        try {
          request = JSON.parse(line);
        } catch (e) {
          const reply: ActionBridgeReply = { ok: false, error: `неразборчивый запрос: ${String(e)}` };
          socket.write(`${JSON.stringify(reply)}\n`);
          continue;
        }
        // Токен канала: без него запросы не принимаются (свой на канал, не общий).
        const token = (request as { token?: unknown } | null)?.token;
        if (token !== channelToken) {
          const reply: ActionBridgeReply = { ok: false, error: 'токен канала не совпал' };
          socket.write(`${JSON.stringify(reply)}\n`);
          continue;
        }
        void handleRequest(ctx, request)
          .then((reply) => socket.write(`${JSON.stringify(reply)}\n`))
          .catch((e) => {
            const reply: ActionBridgeReply = { ok: false, error: `неразборчивый запрос: ${String(e)}` };
            try {
              socket.write(`${JSON.stringify(reply)}\n`);
            } catch {
              // канал закрылся — отвечать некому.
            }
          });
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });

  server.listen(pipePath);
  server.on('error', () => {
    // Канал не поднялся — агент просто не получит доступ к действиям, а программа
    // продолжит работать.
  });

  return {
    pipePath,
    token: channelToken,
    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
    },
  };
}
