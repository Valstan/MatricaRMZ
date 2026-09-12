import { describe, expect, it } from 'vitest';

import { reportHistorySignature } from './reports.js';

// Подпись набора настроек: по ней журнал отчётов схлопывает повторы в одну строку
// со счётчиком вместо десяти одинаковых записей подряд.
describe('reportHistorySignature', () => {
  it('порядок ключей не меняет подпись', () => {
    const a = reportHistorySignature('engines', { brandIds: ['b1'], startMs: 10 }, []);
    const b = reportHistorySignature('engines', { startMs: 10, brandIds: ['b1'] }, []);
    expect(a).toBe(b);
  });

  it('разные значения дают разные подписи', () => {
    const a = reportHistorySignature('engines', { startMs: 10 }, []);
    const b = reportHistorySignature('engines', { startMs: 11 }, []);
    expect(a).not.toBe(b);
  });

  it('пресет входит в подпись — одинаковые фильтры у разных отчётов не схлопываются', () => {
    expect(reportHistorySignature('engines', { startMs: 10 }, [])).not.toBe(
      reportHistorySignature('work_orders_report', { startMs: 10 }, []),
    );
  });

  it('выключенные фильтры учитываются, а их порядок — нет', () => {
    const a = reportHistorySignature('engines', { startMs: 10 }, ['period', 'brandIds']);
    const b = reportHistorySignature('engines', { startMs: 10 }, ['brandIds', 'period']);
    const none = reportHistorySignature('engines', { startMs: 10 }, []);
    expect(a).toBe(b);
    expect(a).not.toBe(none);
  });

  it('пустые настройки и их отсутствие — одно и то же', () => {
    expect(reportHistorySignature('engines', {}, [])).toBe(reportHistorySignature('engines', undefined, undefined));
  });

  it('undefined в значении фильтра не создаёт отдельной подписи', () => {
    expect(reportHistorySignature('engines', { startMs: 10, brandIds: undefined }, [])).toBe(
      reportHistorySignature('engines', { startMs: 10 }, []),
    );
  });
});
