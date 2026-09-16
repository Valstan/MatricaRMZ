import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Вторая панель «2 рядом» рвётся молча: `SECONDARY_CARD_KINDS` разрешает оператору кнопку ⑃,
 * а `renderSecondaryCard` о таком виде карточки не знает — и панель открывается пустой.
 * Ошибка не видна ни типам (оба места про `TabId`), ни экрану до самого щелчка, и сам код
 * просит держать их в синхроне комментарием. Сторож делает эту просьбу проверяемой.
 */
const APP = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const SHEET_CARD = readFileSync(fileURLToPath(new URL('./pages/WorkSheetDetailsPage.tsx', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** Виды из массива-разрешения. */
function allowedKinds(): string[] {
  const block = /const SECONDARY_CARD_KINDS: ReadonlyArray<TabId> = \[([\s\S]*?)\];/.exec(APP);
  expect(block, 'массив SECONDARY_CARD_KINDS переименован или разобран — сторож ослеп').not.toBeNull();
  return [...block![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** Виды, у которых в `renderSecondaryCard` есть свой case (до `default`). */
function renderedKinds(): string[] {
  const start = APP.indexOf('function renderSecondaryCard()');
  expect(start, 'функция renderSecondaryCard переименована — сторож ослеп').toBeGreaterThan(0);
  const body = APP.slice(start);
  const end = body.indexOf('\n      default:');
  expect(end, 'в renderSecondaryCard нет ветки default — вид без case падал бы молча').toBeGreaterThan(0);
  return [...body.slice(0, end).matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!);
}

describe('вторая панель «2 рядом»', () => {
  // Без этого два ассерта ниже верны тривиально: разбор, съехавший на пустые списки, сравнивал
  // бы пустое с пустым и молчал ровно там, где должен кричать.
  it('разбор видит оба списка, а не пустоту', () => {
    expect(allowedKinds().length, 'видов в SECONDARY_CARD_KINDS').toBeGreaterThan(10);
    expect(renderedKinds().length, 'ветвей case в renderSecondaryCard').toBeGreaterThan(10);
  });

  it('каждый разрешённый вид карточки умеет рисоваться во второй панели', () => {
    const rendered = new Set(renderedKinds());
    const missing = allowedKinds().filter((k) => !rendered.has(k));
    expect(missing, `эти виды разрешены кнопкой ⑃, но renderSecondaryCard их не рисует: ${missing.join(', ')}`).toEqual([]);
  });

  it('лишних case во второй панели нет: нарисованный, но не разрешённый вид недостижим', () => {
    const allowed = new Set(allowedKinds());
    const extra = renderedKinds().filter((k) => !allowed.has(k));
    expect(extra, `эти виды рисуются, но кнопка ⑃ для них не предлагается — мёртвый код: ${extra.join(', ')}`).toEqual([]);
  });

  /**
   * Самая дорогая находка C3: карточка этапа работ звала `props.onClose()` в `closeWithoutSave`,
   * а этот путь проходит и обычная навигация — уход с карточки закрывает её сессию. Приложение
   * читает `onClose` как «карточку закрыли», зануляет её id и убирает вкладку с полосы. Итог:
   * этап работ не мог стать ФОНОВОЙ карточкой, а значок ⑃ показывается только на неактивной
   * вкладке — то есть на этапе работ он не появлялся никогда, сколько его ни разрешай.
   * Соседи (двигатель, договор) в `closeWithoutSave` только чистят черновик.
   */
  it('карточка этапа работ не закрывает себя при уходе с неё — иначе фоновой вкладки не бывает', () => {
    const start = SHEET_CARD.indexOf('closeWithoutSave:');
    expect(start, 'у карточки этапа работ нет closeWithoutSave — сторож ослеп').toBeGreaterThan(0);
    const body = SHEET_CARD.slice(start, SHEET_CARD.indexOf('}', start) + 1);
    expect(body, 'closeWithoutSave только сбрасывает несохранённое; вкладку закрывает оболочка').not.toContain('props.onClose()');
  });

  // Этап работ приехал во вторую панель в C3 (план autumn-2026-program §C3). Отдельным
  // ассертом — потому что это и есть предмет задачи, а не следствие общего инварианта.
  it('этап работ открывается во второй панели существующей строкой, а не пустой карточкой', () => {
    expect(allowedKinds(), 'вид work_sheet разрешён для второй панели').toContain('work_sheet');
    expect(APP, 'во второй панели этап работ — только уже записанная строка').toMatch(
      /case 'work_sheet':[\s\S]{0,400}<WorkSheetDetailsPage[^>]*isNew=\{false\}/,
    );
  });
});
