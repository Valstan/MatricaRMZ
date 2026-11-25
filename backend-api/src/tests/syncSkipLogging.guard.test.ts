import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Пропуск по зависимости уезжает ДВУМЯ путями: в счётчик здоровья (addSkipMetric →
// снимок sync_skipped_rows) и в журнал (logSkip). У чата и общих заметок второго не
// было вовсе: 09.09.2026 гейт показал `critical` с числом, под которое в журнале не
// нашлось ни строки, и разбор начался с доказательства, что число не выдумано.
// Счётчик без следа в журнале называет беду, но не даёт её найти.
const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../services/sync/applyPushBatch.ts'),
  'utf8',
);

describe('пропуск по зависимости', () => {
  it('каждый счётчик сопровождается записью в журнал', () => {
    const lines = source.split(/\r?\n/);
    const silent: string[] = [];
    lines.forEach((line, i) => {
      if (!/addSkipMetric\('dependency'/.test(line)) return;
      const window = lines.slice(i + 1, i + 25);
      const stop = window.findIndex((l) => /addSkipMetric\(/.test(l));
      const scope = stop === -1 ? window : window.slice(0, stop);
      if (!scope.some((l) => /logSkip\(/.test(l))) silent.push(`${i + 1}: ${line.trim()}`);
    });
    expect(silent).toEqual([]);
  });

  it('счётчики вообще есть — гейт не разъехался с тестом', () => {
    expect(source.match(/addSkipMetric\('dependency'/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });
});

// Отброс строки по LWW на уровне ПАРЫ (entity_id + attribute_def_id) шёл молча:
// строка просто выпадала из батча, клиент о ней не узнавал и держал её в очереди
// вечно (инцидент PC63 17–25.11.2026 — 4 строки `attribute_values` в pending неделю,
// при этом данные на сервере были). Отброс должен быть НАЗВАН: клиент по
// `lww_rejected` снимает `pending` — серверная копия новее, её привезёт pull.
describe('отброс строки по LWW назван', () => {
  it('ветка pair-LWW сообщает клиенту причину', () => {
    const lines = source.split(/\r?\n/);
    const idx = lines.findIndex((l) => /pairLwwConflicts \+= 1/.test(l));
    expect(idx, 'ветка pair-LWW не найдена в applyPushBatch').toBeGreaterThan(-1);
    const scope = lines.slice(idx, idx + 20).join('\n');
    expect(scope, 'отброс по LWW не попадает в skipped — клиент о строке не узнает').toMatch(/addSkippedRow\(/);
    expect(scope, 'причина отброса должна быть названа LWW_REJECTED_REASON').toMatch(/LWW_REJECTED_REASON/);
  });
});
