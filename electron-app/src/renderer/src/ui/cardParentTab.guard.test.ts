import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Закрытие последней карточки уводит оператора в её список (CARD_PARENT_TAB),
// а без записи — в «Мой круг» (`?? 'history'`). Запись `work_sheet` в таблице
// не появлялась никогда, и закрытие карточки этапа работ бросало оператора
// в чужой раздел. Сторож — на свойство, а не на написание: каждый вид из
// CARD_DETAIL_TABS обязан иметь родительский список в CARD_PARENT_TAB,
// иначе следующая заведённая карточка повторит тот же путь молча.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const APP = src('./App.tsx');

function block(source: string, name: string, open: string, close: string): string {
  const hit = new RegExp(`const ${name}[^]*?\\${open}([\\s\\S]*?)\\n\\${close};`).exec(source);
  if (!hit) throw new Error(`блок ${name} не найден — сторож устарел вместе с разметкой App.tsx`);
  return hit[1] as string;
}

function parseParentMap(): Record<string, string> {
  const body = block(APP, 'CARD_PARENT_TAB', '{', '}');
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(\w+): '(\w+)',?$/gm)) out[m[1] as string] = m[2] as string;
  return out;
}

function parseDetailKinds(): string[] {
  const body = block(APP, 'CARD_DETAIL_TABS', '[', ']');
  return [...body.matchAll(/'(\w+)'/g)].map((m) => m[1] as string);
}

describe('карточка закрывается в свой список', () => {
  it('каждый вид из CARD_DETAIL_TABS имеет родительский список в CARD_PARENT_TAB', () => {
    const parent = parseParentMap();
    const missing = parseDetailKinds().filter((kind) => parent[kind] == null);
    expect(
      missing,
      `закрытие карточки ${missing.join(', ')} уводит в «Мой круг» вместо её списка — допиши запись в CARD_PARENT_TAB`,
    ).toEqual([]);
  });

  it('карточка этапа работ закрывается в список этапов, а не в «Мой круг»', () => {
    expect(parseParentMap()['work_sheet']).toBe('work_sheets');
  });
});
