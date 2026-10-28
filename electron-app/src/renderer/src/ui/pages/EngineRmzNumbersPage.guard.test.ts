import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ACCESS_SECTION_CATALOG, MENU_TAB_LABELS, groupForTab, resolveMenuTab } from '@matricarmz/shared';

// Сторож раздела «Номера РМЗ» (план engine-rmz-numbers-2026-10, PR-4).
//
// Почему исходником, а не поведением. Плитка меню живёт в shared-реестре разделов, а
// отрисовка — в App.tsx: разъехавшись, они дают кнопку, которая открывает пустой экран,
// и молча: ошибки нет, просто ничего не происходит. То же с мостом (`engine:rmzNumbers`)
// и подписями вкладки. Обычный тест страницы этого не поймает — он её рисует, минуя меню.
const APP = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const TABS = readFileSync(new URL('../layout/Tabs.tsx', import.meta.url), 'utf8');
const PRELOAD = readFileSync(new URL('../../../../preload/index.ts', import.meta.url), 'utf8');
const IPC = readFileSync(new URL('../../../../main/ipc/register/enginesOpsAudit.ts', import.meta.url), 'utf8');

describe('раздел «Номера РМЗ» подключён целиком', () => {
  it('в shared-реестре: подпись, группа «Производство», разрешитель', () => {
    expect(MENU_TAB_LABELS.engine_rmz_numbers).toBe('Номера РМЗ');
    expect(groupForTab('engine_rmz_numbers')).toBe('production');
    expect(resolveMenuTab('engine_rmz_numbers')).toBe('engine_rmz_numbers');
  });

  it('доступ — разделом «Производство», как у двигателей', () => {
    const production = ACCESS_SECTION_CATALOG.find((s) => s.id === 'production');
    expect(production?.menuTabs).toContain('engine_rmz_numbers');
  });

  it('App.tsx рисует страницу по ключу вкладки', () => {
    expect(APP).toContain("t === 'engine_rmz_numbers'");
    expect(APP).toContain('EngineRmzNumbersPage');
  });

  it('плитка не появляется без права видеть двигатели — и не прячется за чужим правом', () => {
    expect(APP).toMatch(/canViewEngines \? \(\['engines'\] as const\) : \[\]\)[\s\S]{0,400}engine_rmz_numbers/);
  });

  it('подписи вкладки есть в обоих словарях — иначе оператор увидит ключ', () => {
    const occurrences = APP.match(/engine_rmz_numbers: 'Номера РМЗ'/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    expect(TABS).toContain('engine_rmz_numbers:');
  });

  it('мост и канал на месте, канал гейтится правом двигателей', () => {
    expect(PRELOAD).toContain("ipcRenderer.invoke('engine:rmzNumbers')");
    expect(IPC).toContain("ipcMain.handle('engine:rmzNumbers'");
    const handler = IPC.slice(IPC.indexOf("ipcMain.handle('engine:rmzNumbers'"));
    expect(handler.slice(0, 300)).toContain("requirePermOrThrow(ctx, 'engines.view')");
  });

  it('причина удаления пишется ДО удаления карточки', () => {
    // Порядок — не стиль: сервер отбивает удаление двигателя, к которому нет записи
    // `engine.delete` с причиной (`engine_delete_reason_required`). Обратный порядок
    // оставляет окно, где карточка уже удалена, а причина не записалась, — и причина
    // теряется навсегда (шесть карточек, 28.10.2026).
    const handler = IPC.slice(IPC.indexOf("ipcMain.handle('engine:delete'"));
    const body = handler.slice(0, handler.indexOf('ipcMain.handle', 1));
    const auditAt = body.indexOf('addAudit(');
    const deleteAt = body.indexOf('softDeleteEntity(');
    expect(auditAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(auditAt, 'аудит обязан идти первым').toBeLessThan(deleteAt);
  });
});
