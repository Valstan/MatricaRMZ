import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Сторож рейтинга пикеров (план autumn-2026 §D4).
//
// Рейтинг живёт не в одном месте, а в трёх ролях, и каждая ломается молча:
//  • поле, забывшее `rankKey`, продолжает работать — просто нужный человек снова тонет в
//    алфавите, и жалоба звучит как «ничего не изменилось»;
//  • счётчик, поднятый НЕ в воронке настоящего выбора (например, при очистке поля), тихо
//    вылизывает рейтинг до бессмыслицы;
//  • подстановка своего имени, вернувшаяся к «всегда, пока пусто», снова будет возвращать
//    оператора в поле, которое он только что стёр, и в акт уедет не тот человек.
//
// Поэтому сторожатся СВОЙСТВА, а не написание: наличие ключа у каждого пикера сотрудника,
// место вызова `bump` и одноразовость подстановки.

const UI = fileURLToPath(new URL('..', import.meta.url));

function src(rel: string): string {
  return readFileSync(join(UI, rel), 'utf8');
}

/** Все .tsx интерфейса — чтобы новый пикер сотрудника не появился мимо сторожа. */
function allTsx(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) allTsx(full, acc);
    else if (entry.name.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

describe('§D4: каждый пикер сотрудника ранжируется', () => {
  it('у любого EntityReferenceField с target="employee" есть rankKey', () => {
    const missing: string[] = [];
    for (const file of allTsx(UI)) {
      const text = readFileSync(file, 'utf8');
      // Блок JSX от тега до закрывающей скобки: `target` и `rankKey` — соседи внутри него.
      for (const block of text.split('<EntityReferenceField').slice(1)) {
        const head = block.split('/>')[0] ?? '';
        if (!head.includes('target="employee"')) continue;
        if (!head.includes('rankKey=')) missing.push(`${file.slice(UI.length)}: ${head.split('\n')[1]?.trim()}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('ключи называют роль, а не экран — иначе рейтинги ролей смешались бы', () => {
    // «Утверждающий» и «член экипажа» — разные люди; общий ключ мешал бы обоим. Проверяем,
    // что ключи начинаются с `employee:` и после префикса несут роль, а не просто «employee».
    const keys = new Set<string>();
    for (const file of allTsx(UI)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/rankKey=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
        keys.add(m[1] ?? m[2] ?? '');
      }
    }
    expect(keys.size).toBeGreaterThan(1);
    for (const key of keys) {
      expect(key.startsWith('employee:')).toBe(true);
      expect(key.length).toBeGreaterThan('employee:'.length);
    }
  });
});

describe('§D4: счётчик поднимается только на настоящем выборе', () => {
  const FIELD = src('components/EntityReferenceField.tsx');
  const SELECT = src('components/SearchSelect.tsx');

  it('EntityReferenceField считает выбор в commit() и не считает очистку', () => {
    const commit = FIELD.split('function commit(')[1]?.split('function clear(')[0] ?? '';
    expect(commit).toContain('rank.bump(option.id)');
    const clear = FIELD.split('function clear(')[1]?.split('}')[0] ?? '';
    expect(clear).not.toContain('bump');
  });

  it('SearchSelect считает выбор в pickByIndex()', () => {
    const pick = SELECT.split('function pickByIndex(')[1]?.split('\n  }')[0] ?? '';
    expect(pick).toContain('rank.bump(item.option.id)');
  });

  it('клик мышью идёт ТОЙ ЖЕ воронкой, что и Enter, — не своим onChange', () => {
    // Смоук §D4 поймал это вживую: у строки списка был собственный `props.onChange`, мимо
    // `pickByIndex`, — счётчик рос с клавиатуры и молчал на клике, то есть на том самом пути,
    // которым ходит оператор. Два пути выбора — два места, где забудут про новое поведение.
    expect(SELECT).toContain('onClick={() => pickByIndex(idx)}');
    expect(SELECT).not.toContain('onClick={() => { props.onChange(option.id)');
  });

  it('оба компонента ранжируют список один раз наверху', () => {
    for (const text of [FIELD, SELECT]) {
      expect(text).toContain('rank.rankOptions(props.options)');
    }
  });

  it('в выпадающий список уезжает ранжированный массив, а не исходный проп', () => {
    // Смысл всего ключа: при пустом запросе виден только первый десяток опций. Отдай сюда
    // `props.options` — и рейтинг останется вычисленным, но невидимым.
    expect(FIELD).toContain('options={options}');
    expect(FIELD).not.toContain('options={props.options}');
    expect(SELECT).toContain('useSuggestionDropdown(options)');
    expect(SELECT).toContain('return options.slice(0, limit)');
  });
});

describe('§D4: подстановка своего имени одноразовая', () => {
  const PANEL = src('components/RepairChecklistPanel.tsx');

  it('панель помнит уже подставленные подписи в ref, привязанном к листу', () => {
    expect(PANEL).toContain('prefilledSignaturesRef');
    expect(PANEL).toContain('sheetKey');
  });

  it('подпись, уже пройденная эффектом, пропускается — стёртую он не заполняет заново', () => {
    const effect = PANEL.split('const sheetKey =')[1]?.split('// Хвост Т6')[0] ?? '';
    expect(effect).toContain('alreadyPrefilled.has(item.id)');
    expect(effect).toContain('alreadyPrefilled.add(item.id)');
  });

  it('одноразовость считается ОТ ЗАГРУЖЕННОГО листа, а не от пустышки до загрузки', () => {
    // Смоук §D4 поймал: эффект успевает отработать раньше, чем лист приедет с сервера.
    // Без гейта он помечал подписи пройденными по пустым `answers`, приехавший лист их
    // перетирал — и своё имя не подставлялось уже никогда, поле молча оставалось пустым.
    // Комментарии снимаем: соседнее пояснение дословно называет тот же гейт, и сторож,
    // читающий файл целиком, проходил бы на коде, из которого гейт удалён (проверено мутацией).
    const code = PANEL.split('\n')
      .map((line) => line.replace(/\/\/.*/, ''))
      .join('\n');
    const effect = code.split('const alreadyPrefilled =')[0]?.split('const fullName =')[1] ?? '';
    expect(effect).toContain('loadVersion === 0');
    expect(code).toContain('${props.stage}:${activeTemplate.id}:${loadVersion}');
  });
});
