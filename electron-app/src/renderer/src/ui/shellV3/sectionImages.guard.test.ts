import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Рисованные иконки разделов (владелец 13.11.2026): «пробегись по картинкам эмодзи…
// для плашки Списка двигателей "Двигатели" надо изображение мотора, двигателя, сделать,
// пусть рисованный, но видно что двигатель, желательно дизельный двигатель. Для
// "Контракты" сделать более наглядную бумагу с ручкой или пакет документов веером».
//
// Эмодзи-шестерёнка не говорит ни о чём; нарисованный мотор — говорит. Картинка живёт
// в плишке ЛЕВОЙ панели: там ей есть место (44px), в МЕНЮ иконка 15px и остаётся эмодзи.
describe('рисованные иконки разделов', () => {
  function src(rel: string): string {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  }

  it('в реестре разделов есть картинки для двигателей, контрактов и табеля', () => {
    const tabs = src('../layout/Tabs.tsx');
    expect(tabs).toContain('sectionEnginesImage');
    expect(tabs).toContain('sectionContractsImage');
    expect(tabs).toContain('sectionTimesheetsImage');
    expect(tabs).toMatch(/engines:\s*\{[^}]*image:\s*sectionEnginesImage/);
    expect(tabs).toMatch(/contracts:\s*\{[^}]*image:\s*sectionContractsImage/);
    expect(tabs).toMatch(/timesheets:\s*\{[^}]*image:\s*sectionTimesheetsImage/);
  });

  it('картинки лежат в ассетах клиента (иначе сборка не найдёт файл)', () => {
    for (const file of ['section-engines.png', 'section-contracts.png', 'section-timesheets.png']) {
      const path = fileURLToPath(new URL(`../../assets/sections/${file}`, import.meta.url));
      expect(existsSync(path), file).toBe(true);
    }
  });

  it('плишка левой панели рисует картинку, а не эмодзи', () => {
    const shell = src('./V3TabShell.tsx');
    expect(shell).toContain('v3-fav-card-img');
    expect(shell).toContain('btn.iconImage');
    const css = src('./shellV3.css');
    expect(css).toMatch(/\.v3-fav-card-img\s*\{[^}]*width:\s*44px/);
  });

  it('в каталоге кнопок иконка раздела доезжает до плишки', () => {
    const catalog = src('../shellV2/v2ButtonCatalog.ts');
    expect(catalog).toContain('iconImage');
    expect(catalog).toContain('TAB_VISUALS[id]?.image');
  });
});
