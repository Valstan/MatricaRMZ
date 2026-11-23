import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Промт КАРМАНА #80 (23.11.2026): в шапке модуля «Производственная программа» поля ввода
// налезали друг на друга — «поле цеха наезжало на поле названия программы».
//
// Причина: у контролов шапки не было `min-width: 0`, а у грид-элемента `min-width: auto` =
// собственная min-content ширина. У инпута в планшетных токенах (`--ui-input-font-size: 16px`)
// она шире трека ⇒ контрол не давал сжаться, выходил за пределы своего трека и наезжал на
// соседнее поле. Плюс одна сетка `auto-fit` на все поля давала «Названию программы» ту же
// ширину, что и «Цеху».
//
// Сторож по тексту (как и остальные гарды страницы): экран собирается из компонентов, а
// проверять надо ИМЕННО форму раскладки — иначе правка тихо вернёт «поле снова полезло на
// соседа», и это увидит только оператор.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./ProductionProgramPage.tsx');

/** Блок шапки: от поля «Название программы» до начала ряда выбора договора/двигателя. */
function headerBlock(): string {
  const start = PAGE.indexOf("'Название программы'");
  const end = PAGE.indexOf('marginTop: 12', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe('ПП: сетка шапки без наложений (промт #80)', () => {
  it('ряда шапки больше нет одной сетки auto-fit на все поля', () => {
    expect(PAGE).not.toContain("gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))'");
  });

  it('ряд шапки — flex с переносом (поля переносятся, а не наезжают)', () => {
    expect(PAGE).toMatch(/display: 'flex',\s*flexWrap: 'wrap',\s*gap: 10,\s*alignItems: 'flex-start',/);
  });

  it('ширины полей заданы явно, «Название программы» — шире остальных', () => {
    const block = headerBlock();
    expect(block).toContain("{ flex: '2 1 260px' }");
    expect(block).toContain("{ flex: '1 1 170px' }");
    expect(block).toContain("{ flex: '1 1 150px' }");
    expect(block).toContain("{ flex: '1 1 180px' }");
  });

  it('у всех шести контролов шапки — min-width: 0 и box-sizing: border-box', () => {
    const block = headerBlock();
    // По одному на каждое поле шапки: «Название», «Цех», «Период», «Период с»,
    // «Период по», «Статус» — и по одной явной ширине на каждое же поле.
    expect(block.split('minWidth: 0').length - 1).toBe(6);
    expect(block.split("boxSizing: 'border-box'").length - 1).toBe(6);
    expect(block.split('{ flex: ').length - 1).toBe(6);
  });

  it('подпись поля — одна строка (иначе поля разъезжаются по высоте подписи)', () => {
    expect(PAGE).toContain("whiteSpace: 'nowrap'");
  });

  it('ряд выбора договора и двигателя — тоже с переносом (треки не могут не сжаться)', () => {
    expect(PAGE).not.toContain("gridTemplateColumns: 'minmax(220px, 1fr) minmax(240px, 1fr) auto'");
    expect(PAGE).toMatch(/display: 'flex',\s*flexWrap: 'wrap',\s*gap: 8,\s*alignItems: 'flex-end',/);
  });
});
