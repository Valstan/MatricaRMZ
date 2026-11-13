import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, './EnginesPage.tsx'), 'utf-8');
const STORE = readFileSync(resolve(__dirname, '../hooks/columnLayoutStore.ts'), 'utf-8');

// Колонка «Привязка» (владелец 12.11.2026, промт КАРМАНА #8): вместо слова «договор» —
// три цифры рабочего номера и номер ДС; колонка выключена по умолчанию и остаётся в
// «Колонках списка».
describe('EnginesPage — колонка «Привязка»', () => {
  it('колонка заведена в списке и остаётся в «Колонках списка»', () => {
    expect(PAGE).toContain("id: 'binding'");
    expect(PAGE).toContain("label: 'Привязка'");
  });

  it('подпись ячейки берётся из домена, а не пишется словами', () => {
    const cell = /function renderBindingCell[\s\S]*?\n}/.exec(PAGE)?.[0] ?? '';
    expect(cell, 'ячейка привязки не читает доменное правило').toContain('engineBindingLabel(');
    expect(cell, 'в ячейке снова слово «договор»').not.toContain("'Договор'");
    expect(cell, 'в ячейке снова слово «Не привязан»').not.toContain("'Не привязан'");
  });

  it('колонка выключена по умолчанию — и у тех, у кого она уже видна', () => {
    const hidden = /ENGINE_LIST_HIDDEN_BY_DEFAULT\s*=\s*\[(.*?)\]/s.exec(PAGE)?.[1] ?? '';
    expect(hidden, 'колонка «Привязка» не спрятана по умолчанию').toContain("'binding'");

    // Сохранённая раскладка парка знает про колонку — `defaultHidden` её не трогает,
    // поэтому умолчание применяется один раз через `HIDE_ONCE` (как «Дата изменения»).
    const hideOnce = /'list:engines:columns':\s*\[(.*?)\]/s.exec(STORE)?.[1] ?? '';
    expect(hideOnce, 'у живых раскладок колонка «Привязка» останется на экране').toContain("'binding'");
  });

  it('сортировка колонки не поехала: она по типу привязки, а не по подписи', () => {
    expect(PAGE).toContain('function bindingRank');
    expect(PAGE).toContain("case 'binding':");
  });
});
