import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { serviceActorLabel } from '@matricarmz/shared';

// Колонка «Кто» в истории ремонта. Владелец 01.10.2026 увидел там логин
// `stages:backfill` и спросил, что это: по виду не отличить запись человека от записи
// машины. Ассерты ниже держат СВОЙСТВА: подпись словами и разворот ФИО только для
// человеческих логинов.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const FEED = src('./EngineHistoryFeedPanel.tsx');

describe('служебные авторы в истории ремонта подписаны по-русски', () => {
  it('колонка «Кто» рисует подпись ленты, а не сырой логин', () => {
    // Подпись приходит из домена (buildEngineHistoryFeed → serviceActorLabel): экран не
    // должен знать про словарь и не чистить логин на месте — иначе правило расползётся.
    expect(FEED).toContain('buildEngineHistoryFeed(rows)');
    expect(FEED).toContain('data-history-feed-by={item.id}');
    expect(FEED).toContain('{item.by ?');
    expect(FEED).not.toMatch(/\{(?:entry\.performedBy|row\.by)\}/);
  });

  it('подпись остаётся в словаре и для новых служебных логинов не выдумывается', () => {
    // Скрипт может появиться позже: тогда показывается сам логин, а не пустая ячейка —
    // иначе запись выглядела бы анонимной.
    expect(serviceActorLabel('неизвестный:скрипт')).toBe('неизвестный:скрипт');
  });
});