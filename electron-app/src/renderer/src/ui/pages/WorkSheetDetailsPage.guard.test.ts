import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./WorkSheetDetailsPage.tsx');
const APP = src('../App.tsx');

describe('PR-3 — пикер двигателя при новом этапе не отсекает', () => {
  it('WorkSheetDetailsPage использует полный props.engines для picker (без фильтра по этап/статусу)', () => {
    // engineOptions строится из props.engines без условий — значит при isNew видны все
    expect(PAGE).toContain('buildEngineSearchOptions(props.engines)');
  });

  it('App.tsx передаёт в WorkSheetDetailsPage полный список engines (без отсева при isNew)', () => {
    // в обоих путях (карточка и вкладка) передаётся именно engines, не производная
    const hits = (APP.match(/<WorkSheetDetailsPage[^>]*engines=\{engines\}/g) ?? []).length;
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it('в WorkSheetDetailsPage picker не ограничен статусом/этапом (isNew не скрывает не прошедшие)', () => {
    // нет условий типа props.engines.filter(...) или фильтра по stage/status в компоненте
    expect(PAGE).not.toMatch(/engines\.filter\(/);
    expect(PAGE).not.toMatch(/filter.*stage|filter.*status/i);
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
