import { describe, expect, it } from 'vitest';

import { DIAGNOSTICS_RETENTION_SCOPES, parseRetentionDays, retentionCutoffMs } from './diagnosticsRetentionService.js';

describe('diagnostics_snapshots retention', () => {
  it('90 дней по умолчанию, пустое значение — тоже умолчание', () => {
    expect(parseRetentionDays(undefined)).toBe(90);
    expect(parseRetentionDays(' ')).toBe(90);
    expect(parseRetentionDays('30')).toBe(30);
  });

  it('ноль и мусор — ошибка конфигурации, а не «выключить ретенцию молча»', () => {
    expect(() => parseRetentionDays('0')).toThrow(/≥ 1/);
    expect(() => parseRetentionDays('90d')).toThrow(/MATRICA_DIAGNOSTICS_RETENTION_DAYS/);
  });

  it('порог — ровно N суток назад в миллисекундах', () => {
    expect(retentionCutoffMs(1_000_000_000_000, 90)).toBe(1_000_000_000_000 - 90 * 86_400_000);
  });

  it('режутся только scope-ы с читателем «свежего»; корпус чата и RAG-факты — нет', () => {
    expect([...DIAGNOSTICS_RETENTION_SCOPES]).toEqual(['server', 'client', 'ai_agent_event']);
    expect(DIAGNOSTICS_RETENTION_SCOPES).not.toContain('ai_agent_chat_corpus');
    expect(DIAGNOSTICS_RETENTION_SCOPES).not.toContain('ai_agent_rag_fact');
  });
});
