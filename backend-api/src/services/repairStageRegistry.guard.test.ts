import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_REPAIR_STAGE_TEMPLATES, REPAIR_STAGE_CODES } from '@matricarmz/shared';

// Сторож полноты состава этапов ремонта.
//
// Реестр этапов живёт в трёх местах сразу: статика `DEFAULT_REPAIR_STAGE_TEMPLATES`
// (fallback клиента — ранги, субординация, «В ремонте»), union `REPAIR_STAGE_CODES`
// (тип кода) и серверная таблица `repair_stage_templates` (живой справочник).
//
// Рассинхрон между ними НЕ ЛОВИТСЯ ничем: код, которого нет в статике, проходит
// в рантайме (сервер кастует строку в union), но его ранг = 0 ⇒ этап «вне линейки»:
// субординация дат его не проверяет, «шаг назад» не помечается, а двигатель с такой
// отметкой попадает в «На заводе», а не в «В ремонте». Этап молча выпадает из
// отчётов и гейтов, и никто об этом не узнаёт.
//
// Поэтому сторож проверяет равенство трёх множеств:
//   1) `REPAIR_STAGE_CODES` == коды `DEFAULT_REPAIR_STAGE_TEMPLATES`;
//   2) каждый код есть в живой линейке (боковая ветка — вне линейки, но в составе);
//   3) миграция сеет каждый код реестра (живой справочник в БД не отстаёт от статики).
//
// Новый этап ⇒ три правки: статика, union, миграция. Забытая миграция падает здесь.

const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/** Коды, посеянные миграциями в `repair_stage_templates` (INSERT ... VALUES). */
function seededStageCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n');
    if (!sql.includes('repair_stage_templates')) continue;
    // Строки вида ('<uuid>', '<code>', '<name>', <sortOrder>, ...)
    for (const m of sql.matchAll(
      /\(\s*'[0-9a-f-]{36}'\s*,\s*'([a-z_]+)'\s*,\s*'[^']*'\s*,\s*\d+/gi,
    )) {
      codes.add(m[1]!);
    }
  }
  return codes;
}

describe('сторож полноты состава этапов ремонта', () => {
  it('union кодов == состав статики (забытый код = этап вне линейки, ранг 0)', () => {
    const staticCodes = DEFAULT_REPAIR_STAGE_TEMPLATES.map((t) => t.code);
    expect([...staticCodes].sort()).toEqual([...REPAIR_STAGE_CODES].sort());
  });

  it('в статике нет дублей кодов и приоритетов', () => {
    const codes = DEFAULT_REPAIR_STAGE_TEMPLATES.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    const live = DEFAULT_REPAIR_STAGE_TEMPLATES.filter((t) => !t.sideBranch).map((t) => t.sortOrder);
    expect(new Set(live).size).toBe(live.length);
  });

  it('живая линейка идёт строго по возрастанию приоритета', () => {
    const live = DEFAULT_REPAIR_STAGE_TEMPLATES.filter((t) => !t.sideBranch).map((t) => t.sortOrder);
    expect(live).toEqual([...live].sort((a, b) => a - b));
  });

  it('миграция сеет каждый код реестра (серверный справочник не отстаёт от статики)', () => {
    const seeded = seededStageCodes();
    const missing = REPAIR_STAGE_CODES.filter((code) => !seeded.has(code));
    expect(missing).toEqual([]);
  });

  it('фаза на месте во всех трёх местах: union, статика, миграция', () => {
    // Этап «Фаза» (слово владельца 24.11.2026) — между укладкой и сборкой.
    expect(REPAIR_STAGE_CODES).toContain('faza');
    const faza = DEFAULT_REPAIR_STAGE_TEMPLATES.find((t) => t.code === 'faza');
    expect(faza?.name).toBe('Фаза');
    const ukladka = DEFAULT_REPAIR_STAGE_TEMPLATES.find((t) => t.code === 'ukladka')!;
    const sborka = DEFAULT_REPAIR_STAGE_TEMPLATES.find((t) => t.code === 'sborka')!;
    expect(faza!.sortOrder).toBeGreaterThan(ukladka.sortOrder);
    expect(faza!.sortOrder).toBeLessThan(sborka.sortOrder);
    expect(seededStageCodes().has('faza')).toBe(true);
  });
});
