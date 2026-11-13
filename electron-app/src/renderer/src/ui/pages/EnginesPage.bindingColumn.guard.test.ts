import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, './EnginesPage.tsx'), 'utf-8');
const STORE = readFileSync(resolve(__dirname, '../hooks/columnLayoutStore.ts'), 'utf-8');

// Колонка «Договор» (владелец 12.11.2026, промт КАРМАНА #8; переименована 13.11.2026):
// вместо слова «договор» — три цифры рабочего номера и номер ДС; колонка выключена по
// умолчанию и остаётся в «Колонках списка».
describe('EnginesPage — колонка «Договор»', () => {
  it('колонка заведена в списке и остаётся в «Колонках списка»', () => {
    expect(PAGE).toContain("id: 'binding'");
    expect(PAGE, 'колонка называется «Договор» (владелец 13.11.2026)').toContain("label: 'Договор'");
  });

  it('подпись ячейки берётся из домена, а не пишется словами', () => {
    const cell = /function renderBindingCell[\s\S]*?\n}/.exec(PAGE)?.[0] ?? '';
    expect(cell, 'ячейка привязки не читает доменное правило').toContain('engineBindingLabel(');
    expect(cell, 'в ячейке снова слово «договор»').not.toContain("'Договор'");
    expect(cell, 'в ячейке снова слово «Не привязан»').not.toContain("'Не привязан'");
  });

  it('печать списка печатает тот же короткий номер, а не слово «договор»', () => {
    // Владелец 13.11.2026: «печать колонки „Привязка“ коротким номером». Правило одно и
    // то же, что на экране (`engineBindingLabel`), иначе печать и список назовут договор
    // по-разному.
    const print = /function bindingTextLabel[\s\S]*?\n}/.exec(PAGE)?.[0] ?? '';
    expect(print, 'печать не читает доменное правило').toContain('engineBindingLabel(');
    expect(print, 'в печати снова слово «Договор»').not.toContain("'Договор'");
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
