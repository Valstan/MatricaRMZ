import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_PROGRAM_LIST_CARD_COLUMN,
  PRODUCTION_PROGRAM_LIST_STRIP_COLUMN,
  PRODUCTION_PROGRAM_PROGRAM_COLUMN,
  productionProgramFreshnessAt,
  productionProgramLayout,
  productionProgramPeriodLine,
  productionProgramStripLabel,
  sortProductionProgramsByFreshness,
  type ProductionProgramLocalEdit,
} from './productionProgramLayout.js';

// Правила экрана производственной программы (промт КАРМАНА #179):
// порядок плашек по свежести правки и раскладка «программа на весь экран».
//
// Проверяем не картинку, а ПРАВИЛА: их откат к «порядку из реплики» или к
// «программа занимает половину экрана» ломает ровно то, о чём просил владелец.

function program(id: string, updatedAt: number) {
  return { id, updatedAt };
}

describe('плашки производственных программ — по свежести правки', () => {
  it('свежая правка поднимает программу наверх', () => {
    const rows = [program('старая', 100), program('свежая', 300), program('средняя', 200)];
    expect(sortProductionProgramsByFreshness(rows).map((p) => p.id)).toEqual(['свежая', 'средняя', 'старая']);
  });

  it('порядок стабилен: два прогона на одних данных дают один порядок', () => {
    // Живое обновление реплики приезжает каждые 15 секунд — список не должен
    // «прыгать» под рукой у оператора.
    const rows = [program('a', 100), program('b', 100), program('c', 100)];
    const first = sortProductionProgramsByFreshness(rows).map((p) => p.id);
    const second = sortProductionProgramsByFreshness([...rows].reverse()).map((p) => p.id);
    expect(first).toEqual(second);
    expect(first).toEqual(['a', 'b', 'c']);
  });

  it('исходный массив не трогаем — сортировка возвращает копию', () => {
    const rows = [program('старая', 100), program('свежая', 300)];
    const sorted = sortProductionProgramsByFreshness(rows);
    expect(rows.map((p) => p.id)).toEqual(['старая', 'свежая']);
    expect(sorted).not.toBe(rows);
  });

  it('правка, которая ещё не уехала на сервер, берёт время с клиента', () => {
    // Серверное время программы старое (правка не уехала), но оператор её
    // только что правил — значит, она свежее всех.
    const rows = [program('правленная', 100), program('чужая-свежая', 200)];
    const localEdits = new Map<string, ProductionProgramLocalEdit>([
      ['правленная', { at: 500, serverUpdatedAt: 100 }],
    ]);
    expect(sortProductionProgramsByFreshness(rows, localEdits).map((p) => p.id)).toEqual([
      'правленная',
      'чужая-свежая',
    ]);
  });

  it('время правки — большее из серверного и клиентского', () => {
    expect(productionProgramFreshnessAt(program('p', 100))).toBe(100);
    expect(productionProgramFreshnessAt(program('p', 100), { at: 500, serverUpdatedAt: 100 })).toBe(500);
    // Клиентская метка не может «отмазать» серверное время: если сервер отстал
    // (часы), всё равно берётся большее из двух.
    expect(productionProgramFreshnessAt(program('p', 900), { at: 100, serverUpdatedAt: 900 })).toBe(900);
  });
});

describe('раскладка экрана: открытая программа занимает максимум', () => {
  it('программа открыта — рельс узкий, программа забирает остаток', () => {
    const layout = productionProgramLayout({ programOpen: true, listCards: false });
    expect(layout.listColumn).toBe(PRODUCTION_PROGRAM_LIST_STRIP_COLUMN);
    expect(layout.programColumn).toBe(PRODUCTION_PROGRAM_PROGRAM_COLUMN);
    expect(layout.railView).toBe('strip');
    expect(layout.listPanelOpen).toBe(false);
  });

  it('развёрнутый список не отбирает ширину у программы', () => {
    // Список плавает ПОВЕРХ программы: колонка программы та же, рельс узкий.
    const layout = productionProgramLayout({ programOpen: true, listCards: true });
    expect(layout.listColumn).toBe(PRODUCTION_PROGRAM_LIST_STRIP_COLUMN);
    expect(layout.programColumn).toBe(PRODUCTION_PROGRAM_PROGRAM_COLUMN);
    expect(layout.listPanelOpen).toBe(true);
  });

  it('в режиме списка левая колонка — карточки (как было)', () => {
    const layout = productionProgramLayout({ programOpen: false, listCards: true });
    expect(layout.listColumn).toBe(PRODUCTION_PROGRAM_LIST_CARD_COLUMN);
    expect(layout.railView).toBe('cards');
    expect(layout.listPanelOpen).toBe(false);
  });

  it('сжатый список — узкий рельс с полосками', () => {
    const layout = productionProgramLayout({ programOpen: false, listCards: false });
    expect(layout.listColumn).toBe(PRODUCTION_PROGRAM_LIST_STRIP_COLUMN);
    expect(layout.railView).toBe('strip');
  });

  it('программа никогда не отдаёт половину экрана', () => {
    // Старая раскладка была «minmax(260px, 340px) + 1fr» — программа занимала
    // половину. Теперь в режиме программы рельс узкий, а программа — 1fr.
    for (const listCards of [false, true]) {
      const layout = productionProgramLayout({ programOpen: true, listCards });
      expect(layout.listColumn).not.toBe(PRODUCTION_PROGRAM_LIST_CARD_COLUMN);
      expect(layout.programColumn).toBe('minmax(0, 1fr)');
    }
  });
});

describe('подписи периода', () => {
  it('на полоске — диапазон и год', () => {
    const label = productionProgramStripLabel({
      start: new Date(2026, 10, 1, 12).getTime(),
      end: new Date(2026, 10, 15, 12).getTime(),
    });
    expect(label).toBe('01.11–15.11\n2026');
  });

  it('в шапке программы — вид периода и обе даты', () => {
    const line = productionProgramPeriodLine(
      {
        start: new Date(2026, 10, 1, 12).getTime(),
        end: new Date(2026, 10, 15, 12).getTime(),
      },
      'Две недели',
    );
    expect(line).toBe('Две недели · 01.11.2026 — 15.11.2026');
  });
});
