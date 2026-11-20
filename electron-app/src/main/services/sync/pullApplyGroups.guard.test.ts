import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Сторож применения pull: таблица, строки которой разбор pull собрал в группу,
 * обязана быть записана в реплику.
 *
 * Класс тот же, что и в `pullColumnCoverage.guard.test.ts`, с другой стороны:
 * не потерялось поле, а пропала вся таблица. 20.11.2026 так не доезжали профессии
 * приказа (`ppe_occupation_ref`), приказные строки норм (`ppe_norm_line_specs`),
 * личные карточки СИЗ (`ppe_employee_cards`) и шаблоны печатных форм
 * (`ppe_print_templates`): разбор pull складывал их строки в группы, а шага
 * применения не было — строки собирались и молча терялись. Клиентский код эти
 * таблицы читает (выгрузка для 1С берёт из них имя позиции, подразделение и
 * должность; печать личной карточки держит запасной шаблон) — и получал пустоту.
 *
 * Сторож `pullApplyCoverage.guard.test.ts` ловит противоположный край — когда
 * `case` в разборе pull нет вовсе (строка исчезает целиком). Здесь — когда `case`
 * есть, а группа осталась в памяти и в реплику не уехала.
 */
const SERVICE = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8');

interface ClientCase {
  /** Ключ SyncTableName. */
  key: string;
  /** Имя группы, в которую кладёт разбор pull. */
  group: string;
}

/** Клиентские `case` в разборе pull: ключ → имя группы. */
function clientCases(): ClientCase[] {
  const start = SERVICE.indexOf('for (const item of parsedChanges) {');
  expect(start, 'в syncService.ts не найден разбор parsedChanges').toBeGreaterThan(-1);
  const end = SERVICE.indexOf('function isNewerRow(', start);
  expect(end, 'не найден конец switch применения pull').toBeGreaterThan(start);
  const src = SERVICE.slice(start, end);
  const out: ClientCase[] = [];
  const re = /case SyncTableName\.(\w+):([\s\S]*?)(?=\n[ \t]*case SyncTableName\.|\n[ \t]*default:)/g;
  for (const m of src.matchAll(re)) {
    out.push({ key: m[1] ?? '', group: (m[2] ?? '').match(/groups\.(\w+)\.push\(/)?.[1] ?? '' });
  }
  return out;
}

/** Группы, которые реально применяются в реплику (шаг применения pull). */
function appliedGroups(): Set<string> {
  const applied = new Set<string>();
  // Применение таблицы выглядит как `if (groups.<имя>.length > 0) { … }`.
  // Разбор pull кладёт строки через `groups.<имя>.push(...)` — эти два вида не
  // путаются, поэтому ищем по всему файлу.
  for (const m of SERVICE.matchAll(/if \(groups\.(\w+)\.length > 0\)/g)) applied.add(m[1] as string);
  return applied;
}

describe('строки pull доезжают до реплики клиента', () => {
  it('каждая собранная группа применяется в реплику', () => {
    const applied = appliedGroups();
    const cases = clientCases();

    const problems = cases
      .filter((c) => c.group && !applied.has(c.group))
      .map((c) => `${c.group}: строки собираются в pull, но в реплику не пишутся`);
    expect(
      problems,
      `таблицы приезжают в pull и молча теряются: ${problems.join('; ')}`,
    ).toEqual([]);
  });
});
