/**
 * Сторож бюджета push'а: отсечение не молчит, а бизнес-строки журнала не
 * вытесняются телеметрией.
 *
 * Инцидент 26.11.2026 (машина PC20): три строки `audit_log` висели в очереди двое
 * суток — их никто не видел, потому что:
 *  - таблицы `audit_log` не было в клиентском снимке диагностики (сервер и
 *    автолечение очередь не видели);
 *  - бюджет push'а общий, и таблица, до которой не дошла, получала НОЛЬ строк —
 *    молча: в лог попадало только отсечение пяти таблиц, берущих строки через
 *    `takePending`, а остальные брали строки сырым `.limit(limitFor(…))`;
 *  - телеметрия интерфейса (`ui.*`) занимала очередь целиком, вытесняя бизнес-строки.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(fileURLToPath(new URL('./syncService.ts', import.meta.url)), 'utf8');

describe('бюджет push не отсекает таблицы молча', () => {
  it('все таблицы, берущие строки сырым limit, зовут limitForLoud', () => {
    expect(SOURCE, 'сырой limitFor остался — отсечение снова молчит').not.toContain(
      '.limit(limitFor(SyncTableName.',
    );
    const loud = SOURCE.match(/\.limit\(limitForLoud\(SyncTableName\./g) ?? [];
    expect(loud.length, 'ожидаем много таблиц через limitForLoud').toBeGreaterThanOrEqual(10);
  });

  it('отсечение называется в логе таблицей и бюджетом', () => {
    expect(SOURCE).toContain('push budget cut table=');
  });
});

describe('журнал действий: бизнес-строки идут первыми', () => {
  it('телеметрия ui.* отбирается отдельно и не вытесняет бизнес-строки', () => {
    expect(SOURCE).toContain('notLike(auditLog.action, DEFERRED_AUDIT_ACTION_PREFIX)');
    expect(SOURCE).toContain('like(auditLog.action, DEFERRED_AUDIT_ACTION_PREFIX)');
  });

  it('правило отложенных строк одно — из localPending', () => {
    expect(SOURCE).toContain('DEFERRED_AUDIT_ACTION_PREFIX');
  });
});
