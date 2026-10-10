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

  // Удаление обязано уметь отказывать: прежде обработчик искал шаблон в личной
  // корзине, потом в общей, а не найдя нигде, молча писал неизменённые настройки
  // и рапортовал успех (успех, ничем не подтверждённый — класс #178). Починено
  // в #764, здесь скрепа: список со стенки снимается, только если строка реально
  // удалена, а отказ виден оператору, а не выглядит удалением.
  it('удаление несуществующего шаблона отказывает, а не рапортует успех', () => {
    const block = IPC.slice(IPC.indexOf("'reports:customTemplateDelete'"), IPC.indexOf("'reports:historyList'"));
    expect(block, 'личная корзина переписывается, только если строка реально удалена').toContain('personal.removed');
    expect(block, 'нет шаблона ни в одной корзине — отказ, а не успех').toMatch(
      /if\s*\(!target\)\s*return\s*\{\s*ok:\s*false/,
    );
  });

  it('экран показывает отказ удаления, а не снимает шаблон со стенки', () => {
    expect(PAGE).toContain('customTemplateDelete(');
    expect(PAGE, 'отказ — notify и возврат без обновления списка').toContain('if (!res.ok) {');
  });
});
