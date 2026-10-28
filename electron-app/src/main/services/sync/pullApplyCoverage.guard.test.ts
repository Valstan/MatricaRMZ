import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Сторож контракта pull: у КАЖДОЙ таблицы синхронизации обязан быть `case` в
// `applyPulledChanges`.
//
// Почему исходником, а не поведением. Пропущенный `case` не даёт ни ошибки, ни
// красного теста: строки таблицы просто не попадают в группы и исчезают, а курсор
// уезжает вперёд — и они недостижимы навсегда (инкрементальный pull отдаёт только
// `last_server_seq > since`). Ровно так 28.10.2026 парк не увидел номера РМЗ:
// клиенты 3.90.0 протащили `erp_engine_numbers`, выбросили 2580 строк и ушли вперёд.
// Тот же файл носил второй, более старый пример: `erp_engine_instances` не был
// упомянут ни разу, хотя сервер их отдаёт.
//
// Контракт читается из `shared/src/sync/tables.ts`, а не из `@matricarmz/shared`:
// собранный `dist` может отставать от исходника, и тогда новая таблица прошла бы
// мимо сторожа именно в тот момент, когда он нужен.
const SERVICE = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8');
const TABLES = readFileSync(new URL('../../../../../shared/src/sync/tables.ts', import.meta.url), 'utf8');

function contractTables(): string[] {
  const start = TABLES.indexOf('export const SyncTableName = {');
  expect(start, 'в tables.ts не найден объект SyncTableName').toBeGreaterThan(-1);
  const block = TABLES.slice(start, TABLES.indexOf('}', start));
  return [...block.matchAll(/^\s{2}(\w+):\s*'([^']+)'/gm)].map((m) => m[2] as string);
}

function applySwitchSource(): string {
  const start = SERVICE.indexOf('for (const item of parsedChanges) {');
  expect(start, 'в syncService.ts не найден разбор parsedChanges').toBeGreaterThan(-1);
  const end = SERVICE.indexOf('function isNewerRow(', start);
  expect(end, 'не найден конец switch применения pull').toBeGreaterThan(start);
  return SERVICE.slice(start, end);
}

function appliedTables(): Set<string> {
  const keys = [...applySwitchSource().matchAll(/case SyncTableName\.(\w+):/g)].map((m) => m[1] as string);
  const start = TABLES.indexOf('export const SyncTableName = {');
  const block = TABLES.slice(start, TABLES.indexOf('}', start));
  const byKey = new Map([...block.matchAll(/^\s{2}(\w+):\s*'([^']+)'/gm)].map((m) => [m[1] as string, m[2] as string]));
  return new Set(keys.map((k) => byKey.get(k) ?? k));
}

describe('каждая таблица контракта применяется из pull', () => {
  it('в applyPulledChanges есть case для каждой таблицы SyncTableName', () => {
    const applied = appliedTables();
    const missing = contractTables().filter((t) => !applied.has(t));
    expect(
      missing,
      `нет case в applyPulledChanges: ${missing.join(', ')} — строки этих таблиц молча исчезнут из pull`,
    ).toEqual([]);
  });

  it('незнакомая таблица не проходит молча — ветка default пишет её в журнал дырок', () => {
    const source = applySwitchSource();
    expect(source, 'в switch применения pull пропала ветка default').toContain('default:');
    expect(source, 'default обязан складывать имя таблицы в unknownTables').toContain('unknownTables.set(');
    expect(SERVICE, 'журнал дырок обязан писаться в настройки').toContain('recordPullGaps(db');
  });
});
