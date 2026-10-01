import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { serviceActorLabel } from '@matricarmz/shared';

// Колонка «Кто» в трёх местах истории ремонта. Владелец 01.10.2026 увидел там логин
// `stages:backfill` и спросил, что это: по виду не отличить запись человека от записи
// машины. Ассерты ниже держат СВОЙСТВА: подпись словами во всех трёх местах и разворот
// ФИО только для человеческих логинов.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const STAGES = src('./RepairStagesSection.tsx');
const HISTORY = src('./EngineRepairHistoryPanel.tsx');
const TIMELINE = src('./EngineTimelinePanel.tsx');

describe('служебные авторы в истории ремонта подписаны по-русски', () => {
  it('все три ленты берут подпись из общего словаря, а не чистят логин на месте', () => {
    for (const [name, code] of [
      ['этапы', STAGES],
      ['лента', HISTORY],
      ['паспорт', TIMELINE],
    ] as const) {
      expect(code, name).toContain('serviceActorLabel');
      // Свой логин в колонке «Кто» больше не рисуется напрямую.
      expect(code, name).not.toMatch(/\{(?:entry\.performedBy|row\.by)\}/);
    }
  });

  it('паспорт не ищет ФИО служебного автора — у скрипта сотрудника нет', () => {
    // Свойство resolveWho: пустая подпись — ничего не показывать; непустая, отличная от
    // логина, — уже слова по-русски и возвращается как есть (иначе пошёл бы resolve).
    const at = TIMELINE.indexOf('function resolveWho');
    expect(at).toBeGreaterThan(-1);
    const fn = TIMELINE.slice(at, TIMELINE.indexOf('\n}', at));
    expect(fn).toContain('serviceActorLabel(login)');
    expect(fn).toMatch(/if \(service !== String\(login/);
  });

  it('подпись остаётся в словаре и для новых служебных логинов не выдумывается', () => {
    // Скрипт может появиться позже: тогда показывается сам логин, а не пустая ячейка —
    // иначе запись выглядела бы анонимной.
    expect(serviceActorLabel('неизвестный:скрипт')).toBe('неизвестный:скрипт');
  });
});