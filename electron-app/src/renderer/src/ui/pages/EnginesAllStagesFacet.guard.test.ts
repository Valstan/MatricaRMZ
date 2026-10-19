import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

// PR-2 «Все этапы» (владелец 12.10.2026; с 19.10.2026 ступень зовётся «История»): один
// фильтр прохождения этапа в списке двигателей, колонка даты ИМЕННО выбранного этапа,
// этап в заголовке печати, и снятие движковой ступени из этапов ремонта (дубль «Вид работ»).
// Цепочка рвётся молча: id ступеней совпадают, типы довольны, а подпись и данные
// расходятся — оператор выбирает «История = Укладка» и видит дату другого события.

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repo root with pnpm-workspace.yaml not found');
}
function src(rel: string): string {
  return readFileSync(join(repoRoot(), rel), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('electron-app/src/renderer/src/ui/pages/EnginesPage.tsx');
const FACETS = src('shared/src/domain/engineListFacets.ts');
const WORKSHEETS = src('shared/src/domain/workSheets.ts');
const SERVICE = src('electron-app/src/main/services/engineService.ts');

describe('фильтр «История»: подпись, данные, колонка, печать', () => {
  it('ступень называется «История» в списке двигателей (бывш. «Все этапы»)', () => {
    expect(FACETS).toContain("id: 'hasStage',\n      label: 'История',");
    expect(FACETS).not.toContain("label: 'Есть этап',");
    expect(FACETS).not.toContain("label: 'Все этапы',");
    // id выбранного этапа остаётся прежним: роумившееся состояние не должно обесцениваться.
    expect(FACETS).toContain("id: 'hasStage'");
  });

  it('движковая ступень прохождения убрана из этапов ремонта (дубль «Вид работ»)', () => {
    expect(WORKSHEETS).not.toContain("id: 'engineHasStage'");
    // В шапке документа окружения подтверждение решения, а не «тихо пропала».
    expect(WORKSHEETS).toContain('12.10.2026');
  });

  it('даты прохождения каждого этапа собираются в истории двигателя', () => {
    // Три места: тип, сборка, отдача в EngineListItem.
    expect(SERVICE).toContain('stageDates?: Record<string, number>');
    expect(SERVICE).toContain('const stageDates: Record<string, number> = {}');
    expect(SERVICE).toContain('stageDates: mergedStageDates');
  });

  it('колонка «Дата этапа» отвечает по выбранному этапу, а не по последнему', () => {
    expect(PAGE).toContain("id: 'stageDate',\n        label: 'Дата этапа',");
    expect(PAGE).toContain('export function selectedStageCodeFromSelection');
    // Ровно один выбранный этап — иначе колонка молчит («—»): три ответа хуже, чем ни одного.
    expect(PAGE).toContain('if (!Array.isArray(values) || values.length !== 1) return null;');
    // Скрыта по умолчанию, как остальные даты стадий; «Дата изменения» — тоже (P6, 19.10.2026).
    expect(PAGE).toContain("'scrapDate', 'stageDate', 'updatedAt'");
  });

  it('«Дата этапа» при активном периоде показывает дату ПОПАВШЕГО прохода', () => {
    // Владелец 19.10.2026: у этапа, пройденного дважды, колонка отвечает датой того прохода,
    // который прошёл отбор, — иначе экран показывал бы чужой день рядом с отбором по дню.
    expect(PAGE).toContain('facetRangeOf(facets, \'stageDate\')');
    expect(PAGE).toContain('for (const entry of e.stageEntries ?? [])');
    expect(PAGE).toContain("String(entry.code ?? '').trim().toLowerCase() !== selectedStageCode");
  });

  it('дата изменения скрыта по умолчанию, но остаётся в настройках колонок', () => {
    // Владелец 19.10.2026: «дата внесения — убрать из показа по умолчанию, оставить в
    // настройках колонок (аудит)». Колонка объявлена в allColumns, значит в «Колонках списка» есть.
    expect(PAGE).toContain("id: 'updatedAt',");
    expect(PAGE).toContain("label: 'Дата изменения',");
    const hidden = PAGE.slice(PAGE.indexOf('ENGINE_LIST_HIDDEN_BY_DEFAULT ='));
    expect(hidden.slice(0, hidden.indexOf('];'))).toContain("'updatedAt'");
  });

  it('заголовок печати называет фильтруемый этап', () => {
    expect(PAGE).toContain('Двигатели, прошедшие этап: ${option.label}');
    expect(PAGE).toContain('engineStageFacetOptions(sheetTypes, stageTemplates).find');
  });
});
