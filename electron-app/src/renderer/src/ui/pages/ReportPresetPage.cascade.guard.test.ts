import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REPORT_PRESET_DEFINITIONS } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

// Сторож каскада фильтров отбора (заказчик → договор → марка).
//
// Логика каскада — чистая `cascadeVisibleOptions` и связи `buildFilterCascadeLinks`, обе
// покрыты своими тестами. Рвётся не она, а провод: список опций контрола и снятие уже
// выбранного при сужении родителя — две отдельные точки, и любая отваливается молча:
// типы сойдутся, линт промолчит, а оператор получит либо полный список вопреки выбору,
// либо невидимый фильтр по значению, которого в списке больше нет.

const PAGE = readFileSync(fileURLToPath(new URL('./ReportPresetPage.tsx', import.meta.url)), 'utf8');

describe('каскад фильтров доезжает до контрола', () => {
  it('список multi_select строится каскадом от выбранного выше', () => {
    expect(PAGE, 'контрол снова рисует полный список, минуя каскад').toContain(
      'cascadeVisibleOptions(sourceOptions, filter.cascadeFrom, activeFilters)',
    );
  });

  it('выбранное, выпавшее из каскада, снимается — иначе фильтр невидим', () => {
    const calls = PAGE.split('cascadeVisibleOptions(').length - 1;
    expect(calls, 'осталась одна точка каскада: либо контрол, либо отсев выбранного').toBeGreaterThanOrEqual(2);
    expect(PAGE).toContain('filter.cascadeFrom?.length');
  });

  it('подписи выбранного берутся из полного списка, а не из суженного', () => {
    expect(PAGE).toContain('const selectedLabels = sourceOptions.filter((o) => selected.includes(o.value));');
  });

  it('сужение списка видно оператору строкой под контролом', () => {
    expect(PAGE).toContain('data-cascade-note');
    expect(PAGE).toContain('Список сужен выбором выше');
  });

  it.each(['engine_flow_by_counterparty', 'engines'])('каскад объявлен в отчёте %s', (presetId) => {
    const preset = REPORT_PRESET_DEFINITIONS.find((item) => item.id === presetId);
    const cascade = (key: string) => {
      const filter = preset?.filters.find((f) => 'key' in f && (f as { key: string }).key === key);
      return filter && 'cascadeFrom' in filter ? filter.cascadeFrom : undefined;
    };
    expect(cascade('contractIds')).toEqual(['counterpartyIds']);
    expect(cascade('brandIds')).toEqual(['counterpartyIds', 'contractIds']);
  });

  it('секция «Отбор» отчёта «Двигатели» перечисляет ступени в порядке каскада', () => {
    // Секция раскладывает контролы по своему списку ключей, а не по порядку в пресете:
    // разъедутся — на экране марка окажется прежде заказчика, который её сужает.
    expect(PAGE).toContain("'Отбор', scopeSummary, ['counterpartyIds', 'contractIds', 'brandIds']");
  });
});
