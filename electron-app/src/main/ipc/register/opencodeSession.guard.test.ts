import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// D10, слайс 2: фоновая агентская сессия — одна на клиент. Каналы, мост
// и контракт обязаны совпасть, иначе renderer зовёт пустоту, а сторож
// молча зеленеет (класс #494: обработчик осиротел, кнопка мёртвая).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const IPC = src('./opencodeSession.ts');
const REGISTER = src('../registerIpc.ts');
const PRELOAD = src('../../../preload/index.ts');
const CONTRACT = src('../../../../../shared/src/ipc/types.ts');
const CHAT = src('../../../renderer/src/ui/components/AiAgentChat.tsx');

describe('opencodeSession IPC (D10 слайс 2)', () => {
  it('каналы ensure/status/remove зарегистрированы и за гейтом суперадмина', () => {
    for (const ch of ['opencodeSession:ensure', 'opencodeSession:status', 'opencodeSession:remove']) {
      expect(IPC, `канал ${ch} не зарегистрирован`).toContain(`ipcMain.handle('${ch}'`);
    }
    expect(IPC).toContain('superadmin');
    expect(IPC).toContain('isViewMode');
  });

  it('регистр подключён к общему реестру IPC', () => {
    expect(REGISTER).toContain('registerOpencodeSessionIpc');
  });

  it('мост и контракт несут те же три канала', () => {
    for (const ch of ['opencodeSession:ensure', 'opencodeSession:status', 'opencodeSession:remove']) {
      expect(PRELOAD, `в мосте нет ${ch}`).toContain(ch);
    }
    expect(CONTRACT).toContain('opencodeSession: {');
    expect(CONTRACT).toContain('ensure: () => Promise<');
  });

  it('вопрос/опрос/стоп: каналы, мост и контракт (D10 слайс 3)', () => {
    for (const ch of ['opencodeSession:ask', 'opencodeSession:poll', 'opencodeSession:stop']) {
      expect(IPC, `канал ${ch} не зарегистрирован`).toContain(`ipcMain.handle('${ch}'`);
      expect(PRELOAD, `в мосте нет ${ch}`).toContain(ch);
    }
    expect(CONTRACT).toContain('ask: (args: { text: string })');
    expect(CONTRACT).toContain('poll: (args: { askId: string })');
    expect(CONTRACT).toContain('stop: (args: { askId: string })');
  });

  it('окно чата спрашивает узел первым, DeepSeek — запасным (D10 слайс 3)', () => {
    expect(CHAT).toContain('opencodeSession');
    expect(CHAT).toContain('.ask({ text: q })');
    expect(CHAT).toContain('opencodeSession.poll');
    expect(CHAT).toContain('opencodeSession.stop');
    expect(CHAT).toContain('data-node-answer');
    expect(CHAT).toContain('Ответ узла');
    expect(CHAT).toContain('спросил ИИваныча (DeepSeek)');
  });
});
