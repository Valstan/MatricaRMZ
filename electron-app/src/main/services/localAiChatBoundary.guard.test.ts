import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож границы «Ииваныч считает локально» (D-243/D-244, 22.11.2026).
 *
 * До 23.10.2026 действовало правило «Ииваныч считает только сервер», и оно было
 * отменено решением владельца: на машине оператора появляется модуль MiniMax,
 * который отвечает молча и локально. Значит, теперь гейт проверяет ОБРАТНОЕ:
 *
 *   * локальное звено существует и подключено (IPC → preload → контракт → панель);
 *   * вопрос всё равно уходит на сервер (иначе ответ не увидит ни одна машина);
 *   * ответ локального звена кладёт АВТОР своего вопроса, и путь записи — тот же
 *     push-политики, а не отдельная таблица;
 *   * следы прежнего движка (opencode) по-прежнему снимаются, а каталог нового
 *     модуля в список сносимых не попал — иначе уборка съела бы живой модуль.
 *
 * Проверяем текстом исходников: живое поведение проверяется смоуком, а эти
 * договорённости должны быть видны в коде.
 */

const here = resolve(__dirname);
const CHAT_SERVICE = readFileSync(resolve(here, 'aiChatService.ts'), 'utf8');
const LOCAL_SERVICE = readFileSync(resolve(here, 'localMiniMaxService.ts'), 'utf8');
const LOCAL_ENGINE = readFileSync(resolve(here, 'localMiniMax/localMiniMaxEngine.ts'), 'utf8');
const IPC = readFileSync(resolve(here, '../ipc/register/aiChat.ts'), 'utf8');
const PRELOAD = readFileSync(resolve(here, '../../preload/index.ts'), 'utf8');
const TYPES = readFileSync(resolve(here, '../../../../shared/src/ipc/types.ts'), 'utf8');
const PANEL = readFileSync(resolve(here, '../../renderer/src/ui/components/AiAgentChat.tsx'), 'utf8');
const CLEANUP = readFileSync(resolve(here, 'opencodeTracesCleanup.ts'), 'utf8');
const PUSH_POLICY = readFileSync(
  resolve(here, '../../../../backend-api/src/services/sync/aiChatPushPolicy.ts'),
  'utf8',
);

describe('Ииваныч — локальное звение на клиенте', () => {
  it('локальный модуль подключён: IPC → preload → контракт → панель', () => {
    expect(IPC).toContain("ipcMain.handle('aiChat:localStatus'");
    expect(PRELOAD).toContain("ipcRenderer.invoke('aiChat:localStatus')");
    expect(TYPES).toContain('localStatus: () => Promise<');
    expect(PANEL).toContain('AI_CHAT_LOCAL_STATE_LABELS');
    expect(LOCAL_SERVICE).toContain('runLocalAnswer');
  });

  it('вопрос всё равно уходит на сервер: строка создаётся с syncStatus pending', () => {
    expect(CHAT_SERVICE).toContain("syncStatus: 'pending'");
    expect(LOCAL_ENGINE).toContain('answerQuestionLocally');
  });

  it('claim локального звена: строка берётся в работу статусом processing', () => {
    expect(CHAT_SERVICE).toContain("status: args.claimLocal ? 'processing' : 'pending'");
    expect(PUSH_POLICY).toContain("r.status === 'processing' ? 'processing' : 'pending'");
  });

  it('ответ локального звена кладёт автор своего вопроса, и путь — push-политика', () => {
    expect(CHAT_SERVICE).toContain('aiChatAnswerLocally');
    expect(PUSH_POLICY).toContain('clientAnswerFields');
    expect(PUSH_POLICY).toContain("'local_minimax'");
    expect(PUSH_POLICY).toContain("'deepseek_client'");
  });

  it('локальный звено не молчит: пустой пул — честный отказ с причиной', () => {
    expect(LOCAL_ENGINE).toContain('no_free_accounts');
    expect(LOCAL_ENGINE).toContain('аккаунты MiniMax кончились на сегодня');
  });

  it('следы прежнего движка снимаются, каталог нового модуля — нет', () => {
    expect(CLEANUP).toContain("ENGINE_DIR_NAME = 'engine'");
    expect(CLEANUP).toContain("'versions'");
    expect(CLEANUP).toContain('matricarmz-engine');
    expect(CLEANUP).not.toContain('local-minimax');
  });
});
