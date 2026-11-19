import { describe, expect, it } from 'vitest';

import { validatePrintTemplateLayout } from '../services/printFormsService.js';

describe('validatePrintTemplateLayout', () => {
  it('пустая раскладка — отказ', () => {
    const result = validatePrintTemplateLayout('');
    expect(result.ok).toBe(false);
  });

  it('битый JSON — отказ с понятным текстом', () => {
    const result = validatePrintTemplateLayout('{не json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('JSON');
  });

  it('корректная раскладка принимается', () => {
    const result = validatePrintTemplateLayout(
      JSON.stringify({ sections: [{ id: 'norms', enabled: false }], headerNote: 'Примечание' }),
    );
    expect(result.ok).toBe(true);
  });

  it('картинка тяжелее потолка — отказ (шаблон едет в каждый клиент)', () => {
    const big = 'A'.repeat(900 * 1024);
    const result = validatePrintTemplateLayout(
      JSON.stringify({ images: [{ id: 'logo', dataUri: `data:image/png;base64,${big}`, placement: 'top' }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('КБ');
  });

  it('картинка в пределах потолка проходит', () => {
    const small = 'A'.repeat(1000);
    const result = validatePrintTemplateLayout(
      JSON.stringify({ images: [{ id: 'logo', dataUri: `data:image/png;base64,${small}`, placement: 'top' }] }),
    );
    expect(result.ok).toBe(true);
  });
});
