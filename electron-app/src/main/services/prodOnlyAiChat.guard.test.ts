import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож «Ииваныч считает только сервер» (решение владельца 23.10.2026).
 *
 * Локальный движок (opencode на ПК) снят с клиентов: нет ни запуска, ни настроек,
 * ни кнопок, ни IPC. Вопрос всегда ложится в очередь и уходит на прод, ответ
 * приезжает синком. Проверяем текстом исходников: живое поведение проверяется
 * смоуком, а эти договорённости должны быть видны в коде.
 */

const here = resolve(__dirname);
const CHAT_SERVICE = readFileSync(resolve(here, 'aiChatService.ts'), 'utf8');
const IPC = readFileSync(resolve(here, '../ipc/register/aiChat.ts'), 'utf8');
const MAIN = readFileSync(resolve(here, '../index.ts'), 'utf8');
const PRELOAD = readFileSync(resolve(here, '../../preload/index.ts'), 'utf8');
const TYPES = readFileSync(resolve(here, '../../../../shared/src/ipc/types.ts'), 'utf8');
const PANEL = readFileSync(resolve(here, '../../renderer/src/ui/components/AiAgentChat.tsx'), 'utf8');
const CLEANUP = readFileSync(resolve(here, 'opencodeTracesCleanup.ts'), 'utf8');

describe('Ииваныч — только сервер', () => {
  it('вопрос всегда уходит на сервер: строка создаётся pending, локального ответа нет', () => {
    expect(CHAT_SERVICE).toContain("syncStatus: 'pending'");
    expect(CHAT_SERVICE).not.toContain('runLocalAiChatAnswer');
    expect(CHAT_SERVICE).not.toContain('resolveAiEngineMode');
  });

  it('клиент не запускает и не готовит движок', () => {
    expect(MAIN).not.toContain('localAiEngine');
    expect(MAIN).not.toContain('prepareLocalEngineInBackground');
    expect(MAIN).not.toContain('scheduleEngineMaintenance');
  });

  it('поверхности локального движка нет ни в IPC, ни в preload, ни в контракте', () => {
    expect(IPC).not.toContain('aiEngine:');
    expect(PRELOAD).not.toContain('aiEngine');
    expect(TYPES).not.toContain('aiEngine: {');
  });

  it('в окне нет переключателя режимов и диагностики движка', () => {
    expect(PANEL).not.toContain('data-ai-engine-mode');
    expect(PANEL).not.toContain('Проверить движок');
    expect(PANEL).toContain('считает сервер');
  });

  it('следы движка снимаются с машины при старте клиента', () => {
    expect(CLEANUP).toContain("ENGINE_DIR_NAME = 'engine'");
    expect(CLEANUP).toContain("'versions'");
    expect(CLEANUP).toContain('matricarmz-engine');
  });
});
