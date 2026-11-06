// Сторож выбора модели: движок вправе звать только `deepseek-flash`.
//
// Решение владельца 07.11.2026: счёт DeepSeek оплачен, работаем на новой flash —
// `deepseek-v4-pro` дороже и по качеству не лучше, и в счёте провайдера его видно
// отдельной строкой. Проверяем, что:
//
//   * по умолчанию (без env) берётся flash — в любом профиле;
//   * имя снятой модели в env НЕ проходит: движок сводит её на flash и пишет в лог;
//   * устаревший алиас `deepseek-v4-flash` (та же модель, старое имя) сводится на
//     каноническое имя молча — это не смена модели, а её переименование.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_PROFILE = process.env.AI_PROFILE;
const ORIGINAL_CHAT = process.env.AI_MODEL_CHAT;
const ORIGINAL_ANALYTICS = process.env.AI_MODEL_ANALYTICS;

async function loadCommon(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return await import('../services/ai/common.js');
}

beforeEach(() => {
  delete process.env.AI_PROFILE;
  delete process.env.AI_MODEL_CHAT;
  delete process.env.AI_MODEL_ANALYTICS;
});

afterEach(() => {
  if (ORIGINAL_PROFILE == null) delete process.env.AI_PROFILE;
  else process.env.AI_PROFILE = ORIGINAL_PROFILE;
  if (ORIGINAL_CHAT == null) delete process.env.AI_MODEL_CHAT;
  else process.env.AI_MODEL_CHAT = ORIGINAL_CHAT;
  if (ORIGINAL_ANALYTICS == null) delete process.env.AI_MODEL_ANALYTICS;
  else process.env.AI_MODEL_ANALYTICS = ORIGINAL_ANALYTICS;
  vi.resetModules();
});

describe('выбор модели DeepSeek', () => {
  it('по умолчанию — flash в любом профиле', async () => {
    for (const profile of ['fast', 'balanced', 'quality']) {
      const common = await loadCommon({ AI_PROFILE: profile });
      expect(common.AI_MODEL_CHAT, `профиль ${profile}: чат`).toBe('deepseek-flash');
      expect(common.AI_MODEL_ANALYTICS, `профиль ${profile}: аналитика`).toBe('deepseek-flash');
    }
  });

  it('снятая модель из окружения не проходит — движок идёт на flash', async () => {
    const common = await loadCommon({
      AI_MODEL_ANALYTICS: 'deepseek-v4-pro',
      AI_MODEL_CHAT: 'deepseek-v4-pro',
    });
    expect(common.AI_MODEL_ANALYTICS).toBe('deepseek-flash');
    expect(common.AI_MODEL_CHAT).toBe('deepseek-flash');
  });

  it('устаревший алиас той же модели сводится на каноническое имя', async () => {
    const common = await loadCommon({ AI_MODEL_ANALYTICS: 'deepseek-v4-flash' });
    expect(common.AI_MODEL_ANALYTICS).toBe('deepseek-flash');
  });

  it('явно заданная разрешённая модель не трогается', async () => {
    const common = await loadCommon({ AI_MODEL_ANALYTICS: 'deepseek-flash' });
    expect(common.AI_MODEL_ANALYTICS).toBe('deepseek-flash');
  });
});
