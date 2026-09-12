import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// «Мои отчёты» жили только на машине: на втором компьютере владельца их не было вовсе.
// Роуминг идёт секцией профиля, и у него два хрупких места. Первое — правило сохранности
// бакета: импорт обязан добавлять, а не переписывать чужие строки (серверной копии у
// шаблонов нет, восстановить было бы неоткуда). Второе — общий бакет: попав в личный
// профиль, общий шаблон размножился бы личной копией у каждого оператора.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const IPC = src('./register/reports.ts');
const APP = src('../../renderer/src/ui/App.tsx');
const PAGE = src('../../renderer/src/ui/pages/CustomReportsPage.tsx');

describe('роуминг «Моих отчётов»', () => {
  it('выгрузка и вливание есть в мосте', () => {
    expect(IPC).toContain("ipcMain.handle('reports:customTemplatesExport'");
    expect(IPC).toContain("ipcMain.handle('reports:customTemplatesImport'");
  });

  it('едет только личный бакет, общий остаётся общим', () => {
    const block = IPC.slice(IPC.indexOf("'reports:customTemplatesExport'"), IPC.indexOf("'reports:periodStagesCsv'"));
    expect(block, 'listCustomTemplates подмешивает общие шаблоны — в профиль им нельзя').not.toContain('listCustomTemplates(');
    expect(block).toContain('listTemplates(byScope[scope])');
  });

  it('вливание не трогает шаблон, который уже есть на этой машине', () => {
    const block = IPC.slice(IPC.indexOf("'reports:customTemplatesImport'"), IPC.indexOf("'reports:periodStagesCsv'"));
    expect(block).toContain('if (findTemplate(bucket, { id: entry.id })) continue;');
    expect(block, 'запись идёт через upsert бакета, а не заменой массива целиком').toContain('upsertTemplate(bucket, entry)');
  });

  it('без пользователя роуминг не работает — иначе шаблоны утекли бы в общий scope', () => {
    const block = IPC.slice(IPC.indexOf("'reports:customTemplatesExport'"), IPC.indexOf("'reports:periodStagesCsv'"));
    expect((block.match(/scope === REPORT_USER_SCOPE_FALLBACK/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('App выгружает секцию и вливает приехавшую', () => {
    expect(APP).toContain('snapshot.customReportTemplates = customReportsSnap');
    expect(APP).toContain('customTemplatesImport(');
    expect(APP).toContain('customTemplatesExport(');
  });

  it('экран «Мои отчёты» перечитывает список после вливания', () => {
    expect(APP).toContain("new Event('matrica:custom-reports-changed')");
    expect(PAGE).toContain("window.addEventListener('matrica:custom-reports-changed'");
  });
});
