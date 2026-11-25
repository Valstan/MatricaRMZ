import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Плашки выбранных значений фильтра (владелец 12.11.2026 → 25.11.2026).
//
// 12.11.2026 плашки висели плавающим слоем под своей кнопкой и наезжали друг на друга:
// «прочитать невозможно, что выбрано, и отключить невозможно». Тогда их отвели в общий ряд под
// кнопками, а место в ряду считала отдельная раскладка (`utils/facetChipLayout.ts`).
//
// 25.11.2026 (промт КАРМАНА #151) плашки переехали В РЯД ПАНЕЛИ — рядом с кнопкой
// сворачивания и «Сбросить фильтры»: [сворачивание] [сброс] [плашки]. Ряд один и переносится,
// если в экран не влезает. Привязки к кнопке-родителю больше нет — плашки идут обычным
// потоком, поэтому и раскладка с замером не нужны.
//
// Ловится это молча: панель рисуется, плашки на месте, а наезжают они только тогда, когда
// выбрано несколько значений в СОСЕДНИХ ступенях. Сторож держит устройство: плашки — в ряду
// панели, потоком, без плавающего слоя.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const FILTER = src('./FacetFilter.tsx');
const LAYOUT_PATH = fileURLToPath(new URL('../utils/facetChipLayout.ts', import.meta.url));

describe('плашки выбранных значений стоят в ряду панели и не наезжают', () => {
  it('плашки живут в ряду панели, а не плавающим слоем под кнопкой', () => {
    expect(FILTER).toContain('data-facet-chip-row');
    expect(FILTER).toContain('data-facet-chip-group={facet.id}');
    // Прежний вид — плавающий слой под кнопкой, из-за которого плашки соседних ступеней
    // и наезжали друг на друга.
    expect(FILTER, 'плавающий слой под кнопкой вернулся бы').not.toContain("left: '50%'");
    expect(FILTER, 'плавающий слой под кнопкой вернулся бы').not.toContain("transform: 'translateX(-50%)'");
  });

  it('группа плашек идёт потоком: ни абсолютного позиционирования, ни замера', () => {
    // Замер и раскладка по кнопкам-родителям больше не нужны: плашки стоят в ряду панели и
    // переносятся, а не висят по координатам.
    const group = FILTER.slice(FILTER.indexOf('data-facet-chip-group'), FILTER.indexOf('data-facet-chip-group') + 700);
    expect(group, 'плашки вернулись в плавающий слой').not.toContain('position: \'absolute\'');
    expect(FILTER, 'замер плашек вернулся бы').not.toContain('layoutFacetChipGroups');
    expect(FILTER, 'замер плашек вернулся бы').not.toContain('measureChipRow');
    expect(FILTER, 'модуль раскладки вернулся бы').not.toContain('FACET_CHIP_ROW_HEIGHT');
  });

  it('модуль раскладки удалён — он больше не нужен', () => {
    // Модуль был чистой функцией с честными тестами, но после переезда плашек в ряд панели
    // его вызывать некому: мёртвый код в проекте не оставляем.
    expect(existsSync(LAYOUT_PATH), 'модуль раскладки плашек остался мёртвым').toBe(false);
  });

  it('ряд панели переносится, а плашка ужимается многоточием, но остаётся читаемой', () => {
    expect(FILTER).toContain('const FACET_CHIP_MAX_WIDTH = 200;');
    expect(FILTER).toContain("textOverflow: 'ellipsis'");
    // Ряд плашек и ряд панели — один и тот же ряд: перенос на вторую строку.
    expect(FILTER).toContain("flexWrap: 'wrap'");
  });
});
