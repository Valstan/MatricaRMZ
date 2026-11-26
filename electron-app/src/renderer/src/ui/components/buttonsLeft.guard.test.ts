import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Правило владельца от 24.11.2026 (промт КАРМАНА #118, #141): **управляющие кнопки —
// влево**. Жалоба: «на планшете справа некоторые кнопки уходят за край экрана, и
// приходится прокручивать».
//
// Ломается это тихо: кнопку уводит вправо пустая распорка или `marginLeft:'auto'` —
// оператор её не видит и не может нажать. Поэтому сторож держит правило **по всему
// renderer**, а не по одному экрану: иначе через месяц правка вернётся в другом файле.
//
// Что считается нарушением:
//   · пустая распорка (`<span|div style={{ flex: 1 }} />`) прямо перед кнопкой;
//   · `marginLeft: 'auto'` на элементе, который сам держит кнопки.
//
// Что НЕ считается нарушением (и почему):
//   · `flex: 1` у поля ввода — оно тянется по ширине, кнопки не уводит;
//   · `justifyContent: 'flex-end'` в подвале модального окна — это отдельная партия
//     («подвалы модалок») из реестра `docs/pending/knopki-vpravo-obhod-renderer.md`,
//     решение по ней остаётся за владельцем. Правило владельца «управляющие кнопки
//     влево» её тоже покрывает, но молча менять 45 подвалов разом — не то же самое,
//     что починить одну распорку.

const UI_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Все `.tsx` renderer — правило держится на всей программе, а не на списке файлов. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

type Hit = { file: string; line: number; snippet: string };

const BUTTON_START = /^<(Button|button)\b/;

/** Строки-комментарии и пустые — их пропускаем, кнопка может идти после них. */
function isSkippable(line: string): boolean {
  const t = line.trim();
  return (
    t === '' ||
    t.startsWith('/*') ||
    t.startsWith('*') ||
    t.startsWith('//') ||
    t.startsWith('{/*')
  );
}

/** Кнопка в следующих строках (пропуская пустые и комментарии). */
function buttonFollows(lines: string[], from: number, depth = 6): boolean {
  for (let i = from; i < Math.min(lines.length, from + depth); i += 1) {
    const t = lines[i].trim();
    if (isSkippable(t)) continue;
    return BUTTON_START.test(t);
  }
  return false;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of tsxFiles(UI_ROOT)) {
    const rel = file.slice(UI_ROOT.length).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // Пустая распорка перед кнопкой.
      if (/^<(span|div) style=\{\{ flex: 1 \}\} \/>\s*$/.test(line.trim())) {
        if (buttonFollows(lines, i + 1)) {
          hits.push({ file: rel, line: i + 1, snippet: 'пустая распорка перед кнопкой' });
        }
        continue;
      }

      // `marginLeft: 'auto'` на элементе, который сам держит кнопки.
      if (/marginLeft:\s*'auto'/.test(line) && /<(span|div)\b/.test(line)) {
        if (buttonFollows(lines, i + 1)) {
          hits.push({ file: rel, line: i + 1, snippet: "marginLeft:'auto' у группы с кнопками" });
        }
      }
    }
  }
  return hits;
}

describe('управляющие кнопки влево (владелец 24.11.2026, промты КАРМАНА #118 и #141)', () => {
  it('во всём renderer нет ни одной кнопки, уведённой вправо распоркой', () => {
    const hits = scan();
    expect(
      hits.map((h) => `${h.file}:${h.line} — ${h.snippet}`),
      'кнопки уводятся вправо пустой распоркой или marginLeft:auto — на планшете они уезжают за край экрана',
    ).toEqual([]);
  });

  it('в шапке ленты «История ремонта» кнопок, уведённых вправо, нет (заказ #141)', () => {
    const panel = readFileSync(join(UI_ROOT, 'components/EngineHistoryFeedPanel.tsx'), 'utf8');
    const header = panel.slice(
      panel.indexOf("emojiAttrs('История ремонта')"),
      panel.indexOf('{/* Перенос этапов при перебивке номера'),
    );
    expect(header, 'шапка ленты не найдена').not.toBe('');
    expect(header, 'в шапке ленты снова пустая распорка').not.toContain("<div style={{ flex: 1 }} />");
    // Порядок зафиксирован: действие по умолчанию → этап → перенос, чтобы ряд не «прыгал».
    expect(header.indexOf('data-repair-history-add')).toBeLessThan(header.indexOf('data-repair-stage-form-open'));
    expect(header.indexOf('data-repair-stage-form-open')).toBeLessThan(header.indexOf('data-transfer-open'));
  });

  it('метки, по которым смоуки находят кнопки ленты, на месте', () => {
    const panel = readFileSync(join(UI_ROOT, 'components/EngineHistoryFeedPanel.tsx'), 'utf8');
    expect(panel).toContain('data-repair-stage-form-open');
    expect(panel).toContain('data-repair-history-add');
    expect(panel).toContain('data-transfer-open');
  });
});
