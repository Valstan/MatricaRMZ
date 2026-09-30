import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIALOG = readFileSync(resolve(__dirname, './RepairStageTemplateDialog.tsx'), 'utf-8');

describe('RepairStageTemplateDialog — кнопка «Применить приоритеты»', () => {
  it('кнопка применения приоритетов в диалоге шаблона', () => {
    expect(DIALOG).toContain('data-stage-template-apply-priorities');
    expect(DIALOG).toContain('Применить приоритеты');
  });

  it('применение вызывает commitOrder с текущим порядком', () => {
    expect(DIALOG).toContain('commitOrder(live)');
  });
});
