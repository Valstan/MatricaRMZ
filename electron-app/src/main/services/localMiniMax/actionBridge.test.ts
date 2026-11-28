import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Канал действий — именованный канал, и модуль тянет Electron ради вещания в окна.
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));

import type { IpcContext } from '../../ipc/ipcContext.js';
import { startActionBridge, type ActionBridge } from './actionBridge.js';

const bridges: ActionBridge[] = [];

afterEach(() => {
  while (bridges.length) bridges.pop()!.close();
});

function ctxStub(): IpcContext {
  return {
    currentPermissions: async () => ({}),
    currentViewer: async () => ({ login: '', role: '' }),
    currentActor: async () => 'operator',
    mode: () => ({ mode: 'live' as const }),
    dataDb: () => {
      throw new Error('в тесте базы нет');
    },
  } as unknown as IpcContext;
}

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

describe('канал действий агента', () => {
  it('чужой токен в канал не пускает', async () => {
    const bridge = startActionBridge(ctxStub());
    bridges.push(bridge);

    const reply = await ask(bridge.pipePath, 'чужой-токен', { type: 'tools' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('токен');
  });

  it('список инструментов приходит из общего реестра', async () => {
    const bridge = startActionBridge(ctxStub());
    bridges.push(bridge);

    const reply = await ask(bridge.pipePath, bridge.token, { type: 'tools' });
    expect(reply.ok).toBe(true);
    expect(Array.isArray(reply.tools)).toBe(true);
    expect(reply.tools.map((t: { name: string }) => t.name)).toContain(
      'productionProgram.prepareAddByNumbers',
    );
  });

  it('неизвестный инструмент — отказ с понятной причиной', async () => {
    const bridge = startActionBridge(ctxStub());
    bridges.push(bridge);

    const reply = await ask(bridge.pipePath, bridge.token, {
      type: 'action',
      tool: 'productionProgram.неСуществует',
      args: {},
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('неизвестный инструмент');
  });

  it('неизвестный тип запроса — отказ, а не молчание', async () => {
    const bridge = startActionBridge(ctxStub());
    bridges.push(bridge);

    const reply = await ask(bridge.pipePath, bridge.token, { type: 'выдумка' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('неизвестный тип запроса');
  });
});
