import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, './EnginesPage.tsx'), 'utf-8');

// Пилот PR6: колонка «Этап» («где двигатель сейчас») в списке двигателей.
// В списке были даты этапов, а самого этапа не было — после серии «Этапы движения»
// это дыра в главном списке. Пилот — одна колонка здесь; раскатка на остальные
// списки — отдельным решением владельца.
describe('EnginesPage — пилотная колонка «Этап»', () => {
  it('колонка читает готовое поле строки, а не ходит за этапом отдельно', () => {
    // lastStageName уже есть в EngineListItem: отдельных запросов, кэшей и мостов
    // колонке не нужно — она только показывает. Иначе пилот тянул бы за собой данные.
    expect(PAGE, 'колонка берёт этап не из строки списка').toContain('e.lastStageName');
    expect(PAGE).toContain("id: 'engineStage'");
  });

  it('возврат виден суффиксом — иначе второй заход выглядел бы как первый', () => {
    expect(PAGE).toContain('e.lastStagePass');
    expect(PAGE, 'суффикс возврата потерян — слепота PR5 вернулась в список').toContain('· возврат');
  });

  it('сортировка — по линейке этапов через repairStageRank, а не по алфавиту', () => {
    // Проверяем выражение целиком, а не присутствие имени: замена ранга на сравнение
    // названий (`localeCompare(lastStageName)`) поставила бы «Сборку» раньше «Укладки»
    // по буквам — и присутствие `repairStageRank` в импорте этого бы не поймало.
    expect(
      PAGE,
      'сортировка этапа ушла с линейки на алфавит — порядок этапов в списке неверный',
    ).toContain("(repairStageRank(a.lastStageCode ?? '') - repairStageRank(b.lastStageCode ?? ''))");
    expect(PAGE, 'сортировка колонки не заведена на sortKey').toContain("case 'engineStage':");
  });

  it('колонка видима по умолчанию — пилот, который надо включать, не пилот', () => {
    // ENGINE_LIST_HIDDEN_BY_DEFAULT прячет даты стадий; этап туда класть нельзя,
    // иначе владелец будет судить о пилоте, которого не видит.
    const hidden = /ENGINE_LIST_HIDDEN_BY_DEFAULT\s*=\s*\[(.*?)\]/s.exec(PAGE)?.[1] ?? '';
    expect(hidden, 'колонка «Этап» попала в скрытые по умолчанию').not.toContain('engineStage');
  });

  it('ключ сортировки заведён в типе состояния — иначе выбор сортировки не скомпилируется', () => {
    expect(PAGE).toContain("| 'engineStage'");
  });
});
