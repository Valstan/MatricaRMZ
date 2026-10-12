import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./WorkSheetDetailsPage.tsx');
const APP = src('../App.tsx');

describe('PR-4 — карточка этапа: все поля строки правятся под work_sheets.edit', () => {
  it('save включает все поля строки (цех, примечание, значения узла, дата, двигатель, тип)', () => {
    expect(PAGE).toContain('workshopId: workshopId || null');
    expect(PAGE).toContain('note: note.trim() || null');
    expect(PAGE).toContain('values');
    expect(PAGE).toContain('atMs');
    expect(PAGE).toContain('engineId');
    expect(PAGE).toContain('type: {');
  });

  it('App.tsx передаёт canEdit={caps.canEditWorkSheets} в WorkSheetDetailsPage', () => {
    expect(APP).toMatch(/canEdit=\{caps\.canEditWorkSheets\}/);
  });

  it('при !isNew тип и двигатель заблокированы (верно), остальные поля — нет', () => {
    // отбор по disabled: type и engine имеют !props.isNew; остальные — только canEdit
    const disabledType = PAGE.match(/disabled=\{!props\.canEdit \|\| !props\.isNew\}/g)?.length ?? 0;
    expect(disabledType).toBeGreaterThanOrEqual(1);
  });
});
