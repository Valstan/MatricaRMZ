import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож «Ииваныч — Авто» (решение владельца 21.10.2026): сначала считает этот
 * компьютер, при неудаче — сервер; движок готовится тихо сам; есть диагностика.
 * Проверяем текстом исходников: поведение живого движка проверяется смоуком на
 * стенде, а эти договорённости должны быть видны в коде.
 */

const here = resolve(__dirname);
const LOCAL_CHAT = readFileSync(resolve(here, 'localAiChat.ts'), 'utf8');
const CHAT_SERVICE = readFileSync(resolve(here, 'aiChatService.ts'), 'utf8');
const AUTO = readFileSync(resolve(here, 'aiEngineAuto.ts'), 'utf8');
const ENGINE = readFileSync(resolve(here, 'localAiEngine.ts'), 'utf8');
const DIAG = readFileSync(resolve(here, 'localEngineDiagnostics.ts'), 'utf8');
const IPC = readFileSync(resolve(here, '../ipc/register/aiChat.ts'), 'utf8');
const MAIN = readFileSync(resolve(here, '../index.ts'), 'utf8');
const PANEL = readFileSync(resolve(here, '../../renderer/src/ui/components/AiAgentChat.tsx'), 'utf8');
// Подпись источника ответа живёт в shared-хелпере: одна формулировка на всё окно
// (и на серверное звено тоже), проверяем её там, а не поиском строки в панели.
const SCHEDULE = readFileSync(resolve(here, '../../../../shared/src/domain/aiChatSchedule.ts'), 'utf8');

describe('Ииваныч — режим «Авто»', () => {
  it('в окне три режима, и по умолчанию — «Авто»', () => {
    expect(PANEL).toContain("data-ai-engine-mode={o.mode}");
    expect(PANEL).toContain("mode: 'auto' as const");
    expect(PANEL).toContain("mode: 'local' as const");
    expect(PANEL).toContain("mode: 'prod' as const");
    expect(PANEL).toContain("useState<'auto' | 'local' | 'prod'>('auto')");
  });

  it('в «Авто» вопрос сначала считает этот компьютер, при неудаче — сервер', () => {
    // Строка создаётся локальной (на сервер не уезжает)...
    expect(CHAT_SERVICE).toContain("syncStatus: local ? 'synced' : 'pending'");
    // ...а при неудаче движка возвращается в pending — тогда её посчитает сервер.
    expect(LOCAL_CHAT).toContain("syncStatus: 'pending'");
    expect(LOCAL_CHAT).toContain('onFallback');
    expect(AUTO).toContain('askLocalWithBreaker');
  });

  it('в «Только этот ПК» серверу не отдаём — показываем оператору причину', () => {
    expect(LOCAL_CHAT).toContain("mode === 'local'");
    expect(LOCAL_CHAT).toContain('Локальный движок не ответил');
  });

  it('после серии неудач локальный движок не трогаем — пауза (circuit breaker)', () => {
    expect(AUTO).toContain('recordLocalEngineFailure');
    expect(AUTO).toContain('recordLocalEngineSuccess');
    expect(AUTO).toContain('shouldTryLocalEngine');
  });

  it('движок готовится тихо после старта клиента, не на критическом пути', () => {
    expect(MAIN).toContain('prepareLocalEngineInBackground(db, apiBaseUrl)');
    expect(MAIN).toContain('scheduleEngineMaintenance');
    expect(AUTO).toContain('runEngineMaintenance');
  });

  it('рекомендованную версию движка ставим с откатом, а не «любую свежую»', () => {
    expect(ENGINE).toContain('applyEngineManifest');
    expect(ENGINE).toContain('setActiveEngine');
    expect(ENGINE).toContain('sha512HexMatches');
    // Прежняя версия остаётся на диске — откат возможен.
    expect(ENGINE).toContain('engineVersionDir');
  });

  it('есть диагностика «Проверить движок» — отчёт копируется в буфер', () => {
    expect(DIAG).toContain('buildEngineDiagnostic');
    expect(DIAG).toContain('Свободно на диске');
    expect(DIAG).toContain('Последние строки лога движка');
    expect(IPC).toContain('aiEngine:diagnose');
    expect(PANEL).toContain('Проверить движок');
    expect(PANEL).toContain('navigator.clipboard.writeText');
  });

  it('оператор видит, где посчитан ответ', () => {
    // Панель рисует подпись из shared-хелпера, а не собирает текст сама.
    expect(PANEL).toContain('formatAiChatAnswerSourceLabel');
    expect(SCHEDULE).toContain('считал сервер');
    expect(SCHEDULE).toContain('считал движок завода');
    expect(CHAT_SERVICE).toContain('answerSource');
    expect(CHAT_SERVICE).toContain('serverAnswerSource');
  });
});
