/**
 * Диалог «Поиск дублей двигателей»: два режима и показ расхождений
 * (владелец 18.11.2026).
 *
 * Раньше режимов не было, а «похожие» клеились кластером — оператору
 * предлагалась одна группа на 1478 РАЗНЫХ двигателей. Теперь переключатель
 * «По номеру / Похожие», а в похожей паре видно, какие поля различаются:
 * без этого склейка выглядит как обычное действие, а это необратимо.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, './EnginesPage.tsx'), 'utf-8');

describe('разбор дублей двигателей — режимы', () => {
  it('переключатель режимов на месте: «По номеру» и «Похожие»', () => {
    expect(PAGE).toContain('data-dedupe-mode-switch');
    expect(PAGE).toContain("'По номеру'");
    expect(PAGE).toContain("'Похожие'");
    expect(PAGE).toContain('data-dedupe-mode={m}');
  });

  it('выбранный режим уходит в запрос разбора', () => {
    expect(PAGE).toContain('dedupeAnalyze({ mode })');
    expect(PAGE).toContain("React.useState<'exact' | 'similar'>('exact')");
  });

  it('в похожей паре видно, какие поля различаются', () => {
    expect(PAGE).toContain('различаются:');
    expect(PAGE).toContain('g.diffFields.join');
  });

  it('склейка похожей пары спрашивает подтверждение с расхождениями', () => {
    // Склейка необратима: в похожем режиме различающиеся поля обязаны быть видны
    // в подтверждении, иначе оператор склеит два разных двигателя.
    expect(PAGE).toContain('Различаются поля:');
    expect(PAGE).toContain("group.kind === 'similar'");
  });

  it('оператор видит, когда список похожих не весь', () => {
    expect(PAGE).toContain('Показаны не все');
    expect(PAGE).toContain('truncated');
  });
});
