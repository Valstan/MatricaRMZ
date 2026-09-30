import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PANEL = readFileSync(resolve(__dirname, './RepairStagesSection.tsx'), 'utf-8');

describe('RepairStagesSection — кнопка «Применить» при изменении даты', () => {
  it('дата не сохраняется без явного подтверждения', () => {
    expect(PANEL).toContain('editingDate');
    expect(PANEL).toContain('data-repair-stage-apply-date');
    expect(PANEL).toContain('Применить');
  });

  it('режим редактирования даты открывается кнопкой ✎', () => {
    expect(PANEL).toContain('data-repair-stage-edit-date');
    expect(PANEL).toContain('setEditingDate({ id: row.id, code: row.code, value: toInputDate(row.at) })');
  });

  it('отмена редактирования даты', () => {
    expect(PANEL).toContain('setEditingDate(null)');
  });
});
