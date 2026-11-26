import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Наряд (аудит кнопок 10.10.2026, чинено по канону #1240):
// отзыв из работы шёл без flush грязного, сброс — после перезагрузки без чистки,
// закрытие без сохранения не дожидалось in-flight автосейва.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./WorkOrderDetailsPage.tsx');

describe('наряд бережёт введённое', () => {
  it('отзыв из работы флашит грязное, как выдача', () => {
    const fn = PAGE.slice(PAGE.indexOf('async function withdrawFromWork'), PAGE.indexOf('/** Maps WorkOrderTemplateLine'));
    expect(fn).toContain('if (dirtyRef.current) await flushSave(payload);');
  });

  it('«Сброс» гасит dirty и чистит черновик ДО перезагрузки', () => {
    const norm = PAGE.split('\n')
      .map((line) => line.trim())
      .join('\n');
    expect(norm).toContain('dirtyRef.current = false;');
    const resetIdx = norm.indexOf('reset: async () => {');
    const resetBody = norm.slice(resetIdx, resetIdx + 600);
    expect(resetBody.indexOf('dirtyRef.current = false;')).toBeLessThan(resetBody.indexOf('await refresh();'));
    expect(resetBody).toContain('await clearDraft();');
  });

  it('закрытие без сохранения дожидается in-flight автосейва', () => {
    const fn = PAGE.slice(PAGE.indexOf('closeWithoutSave: () => {'), PAGE.indexOf('copyToNew: async () => {'));
    expect(fn).toContain('if (draftWriteRef.current) await draftWriteRef.current.catch(() => undefined);');
    expect(fn).toContain('await clearDraft();');
  });
});

/**
 * Даты выполнения работ (промт КАРМАНА #165): переключатель режимов и колонки
 * даты/исполнителя в таблице видов работ. Сторож читает исходник карточки —
 * он ловит «переключатель отрисовали, а дату в строку не положили».
 */
describe('наряд: даты выполнения работ', () => {
  it('карточка показывает редактор дат с режимом из наряда', () => {
    expect(PAGE).toContain('<WorkOrderDatesEditor');
    expect(PAGE).toContain('mode={payload.workDateMode ?? null}');
    expect(PAGE).toContain('periods={Array.isArray(payload.workPeriods) ? payload.workPeriods : []}');
  });

  it('колонки даты и исполнителя появляются только в режиме «ежедневно»', () => {
    expect(PAGE).toContain("const showWorkDates = payload?.workDateMode === 'daily';");
    expect(PAGE).toContain("const showWorkAssignee = payload?.workDateMode === 'daily' && (payload?.crew.length ?? 0) > 1;");
  });

  it('дата работы кладётся в строку работы, а не в шапку наряда', () => {
    expect(PAGE).toContain('next.workDate = ms;');
    expect(PAGE).toContain('updated.workAssigneeId = next;');
    // Дата выполнения НАРЯДА остаётся отдельной величиной и не перетирается.
    expect(PAGE).toContain('next.completedDate = ms;');
  });
});
