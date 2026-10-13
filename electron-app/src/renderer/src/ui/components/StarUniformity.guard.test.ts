import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// B8 (план client-stability-and-ai-2026-10): одна звезда вместо всех прикреплялок.
// Звезда = левое меню (рельса) + «Закреплённые» наверху + ярлык на Верстак —
// для разделов, пресетов отчётов и шаблонов «Моих отчётов». Отдельных пинов
// (📌 в меню, булавка вкладки, «На Верстак» в контекстных меню, экшен в Сервисе)
// больше нет: их возвращение раскололо бы избранное обратно на три оси.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PANEL = src('../shellV2/ButtonPanel.tsx');
const SHELL = src('../shellV3/V3TabShell.tsx');
const CATALOG = src('../pages/ReportsCatalogPage.tsx');
const CUSTOM = src('../pages/CustomReportsPage.tsx');
const APP = src('../App.tsx');
const TYPES = src('../../../../../../shared/src/ipc/types.ts');
const ROUTES = src('../../../../../../shared/src/domain/deepLinkRoute.ts');
const ACTIONS = src('../shellV2/menuActions.ts');
const PRELOAD = src('../../../../preload/index.ts');
const REPORTS_IPC = src('../../../../main/ipc/register/reports.ts');

describe('пинов больше нет', () => {
  it('меню: ни 📌-кнопки, ни пунктов «Закрепить/На Верстак»', () => {
    expect(PANEL).not.toContain('v2-menu-pin');
    expect(PANEL).not.toContain('Закрепить сверху');
    expect(PANEL).not.toContain('Добавить на Верстак');
    expect(PANEL).not.toContain('onDesktopShortcut');
    expect(PANEL).not.toContain('togglePin');
  });

  it('вкладки: булавка снята, ярлык — через контекстное меню вкладки', () => {
    expect(SHELL).not.toContain('ShortcutIcon');
    expect(SHELL).not.toContain('v3-tab-desktop');
    expect(SHELL).toContain('onContextMenu');
    expect(SHELL).toContain('Добавить на Верстак');
  });

  it('каталог отчётов: контекстного меню Верстака нет, звезда тянет ярлык', () => {
    expect(CATALOG).not.toContain('desktopPresetIds');
    expect(CATALOG).not.toContain('onAddToDesktop');
    expect(CATALOG).not.toContain('Добавить на Верстак');
    expect(CATALOG).toContain('onFavoriteChange');
  });

  it('экшена «На Верстак» в Сервисе нет', () => {
    expect(ACTIONS).not.toContain('desktop_shortcut');
  });
});

describe('звезда до закрытия и на карточках', () => {
  it('звезда стоит раньше кнопки закрытия', () => {
    expect(SHELL.indexOf('Золотая звёздочка')).toBeLessThan(SHELL.indexOf('v3-tab-close'));
  });

  it('карточка несёт звезду своего раздела', () => {
    expect(SHELL).toContain("tab.kind === 'list' || tab.kind === 'card'");
    expect(SHELL).toContain('tab.cardKind');
  });
});

describe('закреплённые сверху — это избранное', () => {
  it('блок «Закреплённые» собирается из favoriteTabs, а не из layout.pinned', () => {
    expect(PANEL).toContain('starredButtons');
    expect(PANEL).toContain('Закреплённые');
  });
});

describe('звезда тянет Верстак', () => {
  it('раздел: включение кладёт ярлык, выключение снимает', () => {
    expect(APP).toContain('desktopPutShortcut');
    expect(APP).toContain('starLink');
    expect(APP).not.toContain('addMenuButtonToDesktop');
    expect(APP).not.toContain('onMenuButtonDesktopShortcut');
  });

  it('пресет: страница сообщает, App кладёт/снимает ярлык', () => {
    expect(APP).toContain('syncReportPresetDesktop');
  });

  it('шаблон: страница сообщает, App кладёт/снимает ярлык', () => {
    expect(APP).toContain('syncCustomReportDesktop');
    expect(CUSTOM).toContain('onFavoriteChange');
  });
});

describe('ярлык шаблона «Моих отчётов»', () => {
  it('контракт: tab custom_reports + customReportTemplateId + templateFavorites', () => {
    expect(TYPES).toContain("'custom_reports'");
    expect(TYPES).toContain('customReportTemplateId');
    expect(TYPES).toContain('templateFavoritesGet');
    expect(TYPES).toContain('templateFavoritesSet');
  });

  it('маршрут custom_report ведёт в конструктор на шаблоне', () => {
    expect(ROUTES).toContain("kind: 'custom_report'");
    expect(APP).toContain("route.kind === 'custom_report'");
    expect(APP).toContain('openCustomReport');
  });

  it('шаблоны: звезда в списке с зацепкой для смоука', () => {
    expect(CUSTOM).toContain('data-template-favorite');
    expect(CUSTOM).toContain('templateFavoritesGet');
    expect(CUSTOM).toContain('templateFavoritesSet');
  });

  it('мост шаблонов: контракт, preload и main-канал', () => {
    expect(PRELOAD).toContain('reports:templateFavoritesGet');
    expect(PRELOAD).toContain('reports:templateFavoritesSet');
    expect(REPORTS_IPC).toContain("ipcMain.handle('reports:templateFavoritesGet'");
    expect(REPORTS_IPC).toContain("ipcMain.handle('reports:templateFavoritesSet'");
    expect(REPORTS_IPC).toContain('ReportTemplateFavorites');
  });
});
