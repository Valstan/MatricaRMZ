import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EnginesPage.tsx');

// Цех — атрибут этапа, не двигателя (владелец 13.10.2026): двигатель принадлежит заводу.
// Строка списка несёт id последнего события истории + снимок имени; свежее имя — из
// справочника тем же хуком, что отчёт «Двигатели на заводе». Рвётся молча: колонка есть,
// а показывает «—», потому что читает поле, которое никто не заполняет.
describe('EnginesPage — колонка «Цех» из этапов', () => {
  it('колонка читает подставленное имя цеха и видна по умолчанию', () => {
    expect(PAGE).toContain("id: 'workshop'");
    expect(PAGE, 'колонка читает не то поле').toContain("String(e.workshopName ?? '')");
    const hidden = /ENGINE_LIST_HIDDEN_BY_DEFAULT\s*=\s*\[(.*?)\]/s.exec(PAGE)?.[1] ?? '';
    expect(hidden, 'колонка «Цех» спрятана по умолчанию — владелец её не увидит').not.toContain('workshop');
  });

  it('имена — из общего справочника поверх снимка строки, сортировка и печать заведены', () => {
    expect(PAGE, 'каждый резолвит цеха по-своему — отчёт и список снова разъедутся').toContain('useWorkshopNames()');
    expect(PAGE).toContain('resolveWorkshopName(workshopNameById, engine.workshopId, engine.workshopName)');
    expect(PAGE, 'сортировка колонки не заведена').toContain("case 'workshop':");
    expect(PAGE, 'ключ сортировки не заведён в типе состояния').toContain("| 'workshop'");
    expect(PAGE, 'печать колонки не заведена').toContain("printValue: (e) => String(e.workshopName ?? '')");
  });
});
