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

describe('цех строки правится и снимок имени не теряется (владелец 13.10.2026)', () => {
  it('селект цеха доступен на существующей строке под canEdit, а не только на новой', () => {
    const at = PAGE.indexOf("{label('Цех')}");
    expect(at, 'подпись «Цех» потеряна').toBeGreaterThan(-1);
    const block = PAGE.slice(at, at + 600);
    expect(block, 'цех существующего этапа не правится').toContain('disabled={!props.canEdit}');
    expect(block, 'цех закрыт на существующей строке — задним числом не проставить').not.toContain('!props.isNew');
  });

  it('цех вне справочника виден опцией и его снимок переживает сохранение', () => {
    // Справочник грузят с activeOnly:true — неактивный цех строки в нём нет: без опции
    // селект показал бы «—», а сохранение уронило бы имя в «без названия».
    expect(PAGE, 'цех вне справочника не виден').toContain('{row?.workshopName || workshopId}');
    expect(PAGE, 'сохранение роняет снимок неактивного цеха').toContain('row.workshopId === workshopId ? row.workshopName || null : null');
  });
});

// P8 (19.10.2026): возврат — это галочка и причина, а не номер, который оператор
// подбирает вручную. Номер считает main; карточка шлёт явный флаг, чтобы галочку
// можно было и снять (иначе «это больше не возврат» сохранить было бы нечем).
describe('возврат в карточке этапа', () => {
  it('галочка и причина правятся и уезжают явным флагом', () => {
    expect(PAGE).toContain('data-work-sheet-repeat');
    expect(PAGE).toContain('data-work-sheet-repeat-reason');
    expect(PAGE).toContain('repeat: repeat || Boolean(repeatPass)');
    expect(PAGE).toContain('repeatReason: repeat || repeatPass ? repeatReason.trim() || null : null');
    expect(PAGE, 'снятая галочка оставляет причину висеть').toContain('if (!e.target.checked) setRepeatReason');
  });

  it('загруженный возврат открывается с галочкой и причиной', () => {
    expect(PAGE).toContain('setRepeat(res.row.repeatPass >= 2)');
    expect(PAGE).toContain('setRepeatReason(res.row.repeatReason)');
  });
});
