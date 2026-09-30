import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIALOG = readFileSync(resolve(__dirname, './BulkStageAddDialog.tsx'), 'utf-8');
const PAGE = readFileSync(resolve(__dirname, '../pages/WorkSheetsPage.tsx'), 'utf-8');

describe('BulkStageAddDialog — массовое добавление этапа', () => {
  it('диалог выбирает этап, дату, цех и несколько двигателей', () => {
    expect(DIALOG).toContain('data-bulk-stage-add');
    expect(DIALOG).toContain('data-bulk-stage-code');
    expect(DIALOG).toContain('data-bulk-stage-date');
    expect(DIALOG).toContain('data-bulk-stage-save');
  });

  it('сохранение идёт по каждому выбранному двигателю', () => {
    expect(DIALOG).toContain('for (const engineId of selectedEngineIds)');
    expect(DIALOG).toContain('window.matrica.workSheets.stages.save');
  });

  it('кнопка открытия диалога на странице «Этапы работ»', () => {
    expect(PAGE).toContain('data-bulk-stage-add-open');
    expect(PAGE).toContain('BulkStageAddDialog');
  });
});
