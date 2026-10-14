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
});
