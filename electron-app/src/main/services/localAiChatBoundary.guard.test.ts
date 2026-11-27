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
const DOMAIN = readFileSync(resolve(here, '../../../../shared/src/domain/aiChatSchedule.ts'), 'utf8');
const CLEANUP = readFileSync(resolve(here, 'opencodeTracesCleanup.ts'), 'utf8');
const CLIENT_SCHEMA = readFileSync(resolve(here, '../database/schema.ts'), 'utf8');
const REGISTRY = readFileSync(resolve(here, '../../../../shared/src/sync/registry.ts'), 'utf8');
const PUSH_POLICY = readFileSync(
  resolve(here, '../../../../backend-api/src/services/sync/aiChatPushPolicy.ts'),
  'utf8',
);

describe('Ииваныч — локальное звение на клиенте', () => {
  it('локальный модуль подключён: IPC → preload → контракт → панель', () => {
    expect(IPC).toContain("ipcMain.handle('aiChat:localStatus'");
    expect(PRELOAD).toContain("ipcRenderer.invoke('aiChat:localStatus')");
    expect(TYPES).toContain('localStatus: () => Promise<');
    expect(PANEL).toContain('aiChatLocalStatusLine');
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
    // Причина пустоты доезжает до оператора своими словами, и различие видно:
    // «нет свободных» ≠ «нет готовых» ≠ «нет пригодных» (промт КАРМАНА #176, п. 4).
    expect(LOCAL_ENGINE).toContain('no_tokens_ready');
    expect(LOCAL_ENGINE).toContain('no_handable_accounts');
    expect(LOCAL_ENGINE).not.toContain('no_handleable_accounts');
    expect(DOMAIN).toContain('AI_CHAT_LOCAL_CAUSE_TEXT');
  });

  it('аккаунт берётся только вместе с заданием — прогрева нет', () => {
    // Единственный вход в локальное звено — создание вопроса оператором. Если
    // появится прогрев (запрос аккаунта при старте клиента), пул будет расходоваться
    // без работы — это ровно то, чего промт #176 требовал не допустить.
    expect(IPC.match(/runLocalAnswer\(/g)?.length).toBe(1);
    expect(IPC).toContain("ipcMain.handle('aiChat:create'");
    expect(LOCAL_SERVICE.match(/answerQuestionLocally\(/g)?.length).toBe(1);
  });

  it('при отказе аккаунта агент берёт свежий и продолжает', () => {
    // Продление своего аккаунта не помогло — берём свежий у пула и повторяем задание.
    expect(LOCAL_ENGINE).toContain('pool.available()');
    expect(LOCAL_ENGINE).toContain('пул вернул тот же аккаунт');
  });

  it('в строке статуса нет служебных подробностей', () => {
    // Оператор видит слова, а не ответ сервера и не коды: подробность уходит в лог.
    // Проверяем по коду: в setState не должна попадать сырая ошибка прогона.
    expect(LOCAL_ENGINE).not.toMatch(/setState\([^)]*attempt\.message/);
    expect(LOCAL_ENGINE).not.toMatch(/setState\([^)]*offer\.message/);
    expect(LOCAL_ENGINE).toContain('console.warn');
  });

  it('причина едет машинным кодом, слова собирает домен', () => {
    // Правило «что видит оператор» живёт в одном месте. Движок пишет коды, панель
    // берёт готовую строку: иначе текст размножается по трём файлам, и служебные
    // слова доезжают до экрана оператора.
    expect(LOCAL_ENGINE).toContain('AiChatLocalCause');
    expect(DOMAIN).toContain('aiChatLocalStatusLine');
    expect(LOCAL_ENGINE).not.toMatch(/setState\([^)]*['"][А-Яа-яЁё]/);
  });

  it('панель не сочиняет своих строк статуса', () => {
    expect(PANEL).toContain('aiChatLocalStatusLine');
    expect(PANEL).toContain('AI_CHAT_ENGINE_UNAVAILABLE_LINE');
    expect(PANEL).not.toContain('AI_CHAT_LOCAL_STATE_LABELS');
  });

  it('следы прежнего движка снимаются, каталог нового модуля — нет', () => {
    expect(CLEANUP).toContain("ENGINE_DIR_NAME = 'engine'");
    expect(CLEANUP).toContain("'versions'");
    expect(CLEANUP).toContain('matricarmz-engine');
    expect(CLEANUP).not.toContain('local-minimax');
  });

  it('ответ локального звена уезжает на сервер: имя поля в реплике совпадает с реестром', () => {
    // Реестр sync берёт поле из строки реплики по имени. Расхождение имён
    // означало бы, что источник ответа уезжает пустым, сервер отвергает такой
    // ответ, и локальный ответ оператора теряется.
    expect(REGISTRY).toContain("{ db: 'answerSource', dto: 'answer_source' }");
    expect(CLIENT_SCHEMA).toContain("answerSource: text('answer_source')");
    expect(CHAT_SERVICE).toContain('answerSource: args.source');
  });
});
