import { afterEach, describe, expect, it } from 'vitest';

import { BOT_POLL_MS } from '../services/syncPipelineSupervisorService.js';
import { telegramAttemptBudget, telegramPollWorstCaseMs } from '../services/telegramBotService.js';

// Класс #289: повторы, добавленные в задачу по расписанию, обязаны укладываться в её период.
// Проверка арифметическая и делается в момент правки — иначе она делается в момент разбора,
// через сутки после выката, по 228 строкам «slower than its tick» в логе за день (07.09.2026).
const POLL_ENV = ['MATRICA_TELEGRAM_POLL_ATTEMPTS', 'MATRICA_TELEGRAM_POLL_ATTEMPT_TIMEOUT_MS'] as const;

afterEach(() => {
  for (const key of POLL_ENV) delete process.env[key];
});

describe('бюджет прохода опроса Telegram', () => {
  it('худший случай прохода укладывается в период опроса с запасом', () => {
    const worst = telegramPollWorstCaseMs();
    expect(worst).toBeLessThan(BOT_POLL_MS);
    // Запас нужен на саму обработку обновлений после ответа: проход это не только сетевой вызов.
    expect(worst).toBeLessThanOrEqual(BOT_POLL_MS * 0.8);
  });

  it('бюджет отправки шире бюджета опроса: у разового сообщения повторить некому', () => {
    const send = telegramAttemptBudget('send');
    const poll = telegramAttemptBudget('poll');
    expect(send.attempts * send.timeoutMs).toBeGreaterThan(poll.attempts * poll.timeoutMs);
    expect(poll.attempts).toBeGreaterThanOrEqual(2);
  });

  it('переменные окружения не могут увести бюджет за период незаметно', () => {
    process.env.MATRICA_TELEGRAM_POLL_ATTEMPTS = '6';
    process.env.MATRICA_TELEGRAM_POLL_ATTEMPT_TIMEOUT_MS = '8000';
    // Прежние значения — именно тот случай, который съедал тик: тест обязан их поймать.
    expect(telegramPollWorstCaseMs()).toBeGreaterThan(BOT_POLL_MS);
  });

  it('длинный опрос считается частью бюджета, а не сверх него', () => {
    expect(telegramPollWorstCaseMs(10)).toBeGreaterThan(telegramPollWorstCaseMs(0));
  });
});
