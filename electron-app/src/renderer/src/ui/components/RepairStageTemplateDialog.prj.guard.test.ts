import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIALOG = readFileSync(resolve(__dirname, './RepairStageTemplateDialog.tsx'), 'utf-8');

describe('RepairStageTemplateDialog — слияние дублей и удаление (PR-J)', () => {
  it('секция объединения дублей с выбором исходного и целевого', () => {
    expect(DIALOG).toContain('data-stage-template-merge');
    expect(DIALOG).toContain('data-stage-merge-source');
    expect(DIALOG).toContain('data-stage-merge-target');
    expect(DIALOG).toContain('data-stage-merge-dry-run');
    expect(DIALOG).toContain('data-stage-merge-apply');
  });

  it('слияние идёт через мост templates.merge с dryRun', () => {
    expect(DIALOG).toContain('workSheets.stages.templates.merge');
    expect(DIALOG).toContain('dryRun: true');
  });

  it('кнопка удаления навсегда с серверным гейтом', () => {
    expect(DIALOG).toContain('workSheets.stages.templates.remove');
    expect(DIALOG).toContain('Удалить');
  });
});
