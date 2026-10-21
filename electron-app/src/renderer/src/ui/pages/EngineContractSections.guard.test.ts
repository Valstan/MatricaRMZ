import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Список ДС в карточке двигателя читался ОДИН раз на выбранный договор. ДС заводят в карточке
// договора, пока карточка двигателя уже открыта, — и список оставался прежним до сохранения
// двигателя (владелец 21.10.2026: «после нажатия Сохранить ДС появляются»). Сторож держит
// провод перезапроса и вторую половину той же ловушки: поле, выключенное из-за пустого списка,
// нечем «ткнуть», чтобы повторить запрос.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./EngineDetailsPage.tsx');

describe('ДС в карточке двигателя не ждут «Сохранить»', () => {
  it('секции перезапрашиваются по обращению к полю, а не только при открытии карточки', () => {
    expect(PAGE).toContain('onPointerDownCapture={() => {');
    expect(PAGE).toContain('onFocusCapture={() => {');
    expect(PAGE).toContain('refreshContractSections()');
    expect(PAGE, 'эффект секций перестал зависеть от тика перезапроса').toContain('[contractId, contractSectionsTick]');
  });

  it('возврат окна в фокус тоже обновляет секции', () => {
    expect(PAGE).toContain("window.addEventListener('focus', refresh)");
    expect(PAGE).toContain("document.addEventListener('visibilitychange', refresh)");
  });

  it('поле ДС не выключается из-за пустого списка', () => {
    expect(PAGE, 'пустой список снова запирает поле — оператору нечем повторить запрос').not.toContain(
      '|| contractSectionOptions.length === 0',
    );
    expect(PAGE).toContain('disabled={!canEditEnginesEff || !contractId}');
  });

  it('отказ чтения секций виден оператору, а не молчит', () => {
    expect(PAGE).toContain("setContractSectionsState('error')");
    expect(PAGE).toContain('Не удалось прочитать ДС договора');
  });
});
