import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Плавающие плашки выбранных значений фильтра (владелец 12.11.2026): «плавающие плашки
// наезжают друг на друга… прочитать невозможно, что выбрано, и отключить невозможно».
//
// Ловится это молча: панель рисуется, плашки на месте, а наезжают они только тогда, когда
// выбрано несколько значений в СОСЕДНИХ ступенях. Поэтому сторож держит не картинку, а
// устройство: плашки стоят общим рядом, позиции считает отдельный модуль, и у каждого
// модуля есть свои тесты на раскладку (`facetChipLayout.test.ts`).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const FILTER = src('./FacetFilter.tsx');
const LAYOUT = src('../utils/facetChipLayout.ts');

describe('плашки выбранных значений стоят общим рядом и не наезжают', () => {
  it('плашки живут в отдельной строке, а не плавающим слоем под кнопкой', () => {
    expect(FILTER).toContain('data-facet-chip-row');
    expect(FILTER).toContain('data-facet-chip-group={facet.id}');
    // Прежний вид — плавающий слой под кнопкой, из-за которого плашки соседних ступеней
    // и наезжали друг на друга.
    expect(FILTER, 'плавающий слой под кнопкой вернулся бы').not.toContain("left: '50%'");
    expect(FILTER, 'плавающий слой под кнопкой вернулся бы').not.toContain("transform: 'translateX(-50%)'");
  });

  it('позиции плашек считает отдельный модуль с честными тестами', () => {
    expect(FILTER).toContain('layoutFacetChipGroups(groups, available)');
    expect(LAYOUT).toContain('export function layoutFacetChipGroups');
    expect(LAYOUT).toContain('export const FACET_CHIP_GROUP_GAP');
  });

  it('группа тянется к своей кнопке, но не наезжает на соседнюю', () => {
    // Желаемое место — центр кнопки-родителя; дальше — раздвиг вправо при нехватке места.
    expect(LAYOUT).toContain('const desired = group.parentCenter - width / 2;');
    expect(LAYOUT).toContain('pos[i] = Math.max(pos[i]!, pos[i - 1]! + widths[i - 1]! + gap);');
  });

  it('план считается после отрисовки: иначе плашки прыгают при первом показе', () => {
    expect(FILTER).toContain('React.useLayoutEffect(() => {');
    expect(FILTER).toContain('const plan = layoutFacetChipGroups(groups, available);');
  });

  it('в одну строку плашки ужимаются, но не до нечитаемой ширины', () => {
    expect(FILTER).toContain('const FACET_CHIP_MIN_WIDTH = 90;');
    expect(FILTER).toContain('const FACET_CHIP_MAX_WIDTH = 200;');
  });
});
