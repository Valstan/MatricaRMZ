import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Конфликт опроса (409) должен доходить до владельца: ingestion кладёт его
// как error/network, а нотификатор шлёт fatal всегда и error — по категориям.
// Если любая из сторон тихо сменит тяжесть или набор категорий, 409 снова
// станет видимым только глазами в журнале.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const NOTIFIER = src('../services/criticalEventsTelegramService.ts');

describe('конфликт опроса доходит до владельца', () => {
  it('нотификатор шлёт error из категорий по умолчанию, network — среди них', () => {
    expect(NOTIFIER).toContain("const DEFAULT_ALERT_ERROR_CATEGORIES = ['sync', 'network', 'database'];");
    expect(NOTIFIER).toContain("if (event.severity === 'fatal') return true;");
    expect(NOTIFIER).toContain("if (event.severity !== 'error') return false;");
    expect(NOTIFIER).toContain('return opts.errorCategories.has(');
  });
});
