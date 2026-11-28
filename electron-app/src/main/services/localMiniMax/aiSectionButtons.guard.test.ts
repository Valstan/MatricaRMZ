import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// СТОРОЖ кнопки нейросети в разделах (промт КАРМАНА #176, разрез 4).
//
// Семь правил, каждое — про конкретный способ разъехаться:
//
//  1. В КАЖДОМ разделе, куда кнопка объявлена, она ЕСТЬ: страница зовёт общую кнопку
//     с ключом своего раздела. Список разделов — здесь, в стороже: новая страница без
//     кнопки видна сразу, а не «когда-нибудь всплывёт».
//  2. Каждый раздел ДОМЕННОГО реестра имеет кнопку на своей странице: правило живёт
//     в домене, значит и кнопка обязана быть — список разделов не придётся вести вручную.
//  3. Отчёт-пресет знает свой раздел по ДОМЕННОМУ правилу (а не по копии на странице).
//  4. Кнопка ОДНА на программу: страницы не рисуют свою кнопку «Нейросеть» и не
//     открывают чат сами — открытие живёт в App (второго чата не заводим).
//  5. Формат вопроса собирает ДОМЕН, а не страница: в страницах нет сборки текста.
//  6. Кнопки нет там, где нет канала действий (планшет): проверка — общая.
//  7. Контекст раздела едет в ТЕКСТЕ вопроса: одна вкладка «ИИваныч», а раздел —
//     часть вопроса (иначе серверный агент не видел бы раздела).

const here = dirname(fileURLToPath(import.meta.url));
const UI = join(here, '../../../renderer/src/ui');
const PAGES = join(UI, 'pages');

function src(rel: string): string {
  return readFileSync(join(UI, rel), 'utf8').replace(/\r\n/g, '\n');
}

const BUTTON = src('ai/AiSectionButton.tsx');
const LAUNCHER = src('ai/AiChatLauncherContext.tsx');
const AVAILABILITY = src('ai/useAiToolsAvailable.ts');
const APP = src('App.tsx');
const DOMAIN = src('../../../../../shared/src/domain/aiSectionContext.ts');

/**
 * Разделы с кнопкой нейросети и страницы, где она живёт.
 *
 * Порядок — порядок внедрения, утверждённый владельцем 27.11.2026: производственная
 * программа → двигатели → дефектовка → склад → заказы → наряды. Дальше — разделы,
 * до которых дошла общая кнопка (справочники, персонал, СИЗ).
 */
const SECTION_BUTTONS: ReadonlyArray<{ section: string; page: string }> = [
  { section: 'production_program', page: 'ProductionProgramPage.tsx' },
  { section: 'engines', page: 'EnginesPage.tsx' },
  { section: 'work_sheets', page: 'WorkSheetsPage.tsx' },
  { section: 'stock_balances', page: 'StockBalancesPage.tsx' },
  { section: 'stock_documents', page: 'StockDocumentsPage.tsx' },
  { section: 'stock_inventory', page: 'StockInventoryPage.tsx' },
  { section: 'nomenclature', page: 'NomenclaturePage.tsx' },
  { section: 'repair_fund_audit', page: 'RepairFundAuditPage.tsx' },
  { section: 'contracts', page: 'ContractsPage.tsx' },
  { section: 'counterparties', page: 'CounterpartiesPage.tsx' },
  { section: 'requests', page: 'SupplyRequestsPage.tsx' },
  { section: 'work_orders', page: 'WorkOrdersPage.tsx' },
  { section: 'work_order_templates', page: 'WorkOrderTemplatesPage.tsx' },
  // Справочник деталей, инструментов и услуг — одна страница: раздел передаёт обёртка.
  { section: 'parts', page: 'PartsPage.tsx' },
  { section: 'tools', page: 'ToolsPage.tsx' },
  { section: 'services', page: 'ServicesPage.tsx' },
  { section: 'employees', page: 'EmployeesPage.tsx' },
  { section: 'ppe_cards', page: 'PpeCardsPage.tsx' },
  { section: 'timesheets', page: 'TimesheetsPage.tsx' },
  { section: 'reports', page: 'ReportsCatalogPage.tsx' },
  { section: 'parts_dedupe', page: 'PartsDedupePage.tsx' },
  { section: 'warehouse_analytics', page: 'WarehouseAnalyticsPage.tsx' },

  // Разделы, до которых дошла кнопка (продолжение разреза 4 нити #176).
  { section: 'file_search', page: 'FileSearchPage.tsx' },
  { section: 'engine_rmz_numbers', page: 'EngineRmzNumbersPage.tsx' },
  { section: 'engine_brands', page: 'EngineBrandsPage.tsx' },
  { section: 'engine_brand_groups', page: 'EngineBrandGroupsPage.tsx' },
  { section: 'engine_assembly_bom', page: 'EngineAssemblyBomPage.tsx' },
  { section: 'repair_norms', page: 'RepairNormsPage.tsx' },
  { section: 'services_by_brand', page: 'ServicesByBrandPage.tsx' },
  { section: 'service_price_orders', page: 'ServicePriceOrdersPage.tsx' },
  { section: 'tool_accounting', page: 'SupplyToolMovementsPage.tsx' },
  { section: 'warehouse_locations', page: 'WarehouseLocationsPage.tsx' },
  { section: 'warehouses_admin', page: 'WarehouseLocationsAdminPage.tsx' },
  { section: 'workshops', page: 'MasterdataWorkshopsPage.tsx' },
  { section: 'workshop_stats', page: 'WorkshopStatsPage.tsx' },
  { section: 'masterdata', page: 'AdminPage.tsx' },
  { section: 'ppe_norms', page: 'PpeNormsPage.tsx' },
  { section: 'ppe_groups', page: 'PpeGroupsPage.tsx' },
  { section: 'ppe_collective', page: 'PpeCollectivePage.tsx' },
  { section: 'ppe_import', page: 'PpeImportPage.tsx' },
  { section: 'ppe_stock', page: 'PpeStockPage.tsx' },
  { section: 'ppe_reports', page: 'PpeReportsPage.tsx' },
  { section: 'ppe_vacations', page: 'PpeVacationSchedulePage.tsx' },
  { section: 'children', page: 'ChildrenPage.tsx' },
  { section: 'organization', page: 'OrganizationPage.tsx' },
  { section: 'access_sections', page: 'AccessSectionsPage.tsx' },
  { section: 'print_forms', page: 'PrintFormsPage.tsx' },
  { section: 'print_documents', page: 'PrintDocumentsPage.tsx' },
  { section: 'custom_reports', page: 'CustomReportsPage.tsx' },
  { section: 'report_templates', page: 'ReportTemplatesShowcasePage.tsx' },
  { section: 'audit', page: 'SuperadminAuditPage.tsx' },
  { section: 'changes', page: 'ChangesPage.tsx' },
  { section: 'deleted', page: 'DeletedObjectsPage.tsx' },
  { section: 'notes', page: 'NotesPage.tsx' },
  { section: 'drafts', page: 'DraftsPage.tsx' },
  { section: 'settings', page: 'SettingsPage.tsx' },
  { section: 'user_screens', page: 'UserScreensPage.tsx' },
  { section: 'history', page: 'HistoryPage.tsx' },
  { section: 'empty_cards', page: 'EmptyCardsCleanupPage.tsx' },
];

/**
 * Отчёты-пресеты, у которых раздел едет из ДОМЕНА (`aiSectionForPreset`): страница
 * пресета не знает, откуда её открыли, поэтому правило живёт в домене. Проверка
 * сторожа — что правило есть и что страница им пользуется.
 */
const PRESET_SECTIONS: ReadonlyArray<{ section: string; presetId: string }> = [
  { section: 'now_at_plant', presetId: 'engines_now_at_plant' },
  { section: 'assembly_forecast', presetId: 'assembly_forecast_7d' },
];

/** Разделы, объявленные в доменном реестре (`AI_SECTION_CONTEXT`). */
function registrySections(): string[] {
  const start = DOMAIN.indexOf('export const AI_SECTION_CONTEXT');
  expect(start, 'в домене нет реестра AI_SECTION_CONTEXT').toBeGreaterThan(-1);
  const end = DOMAIN.indexOf('\n};', start);
  const block = DOMAIN.slice(start, end > -1 ? end : DOMAIN.length);
  const keys: string[] = [];
  for (const line of block.split('\n')) {
    const m = /^\s{2}([a-z_]+):\s*\(/.exec(line);
    const key = m?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

/** Тексты страниц: имя файла → исходник. */
function pageSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(PAGES)) {
    if (!file.endsWith('.tsx')) continue;
    out.set(file, readFileSync(join(PAGES, file), 'utf8').replace(/\r\n/g, '\n'));
  }
  return out;
}

describe('кнопка нейросети в разделах — сторож', () => {
  it('в каждом разделе кнопка есть: страница зовёт общую кнопку со своим разделом', () => {
    for (const entry of SECTION_BUTTONS) {
      const page = readFileSync(join(PAGES, entry.page), 'utf8').replace(/\r\n/g, '\n');
      const hasButton =
        page.includes(`section="${entry.section}"`) || page.includes(`aiSection="${entry.section}"`);
      expect(hasButton, `${entry.page}: нет кнопки нейросети для раздела «${entry.section}»`).toBe(
        true,
      );
    }
  });

  it('каждый раздел доменного реестра имеет кнопку на своей странице', () => {
    const sources = pageSources();
    // Прямая кнопка: страница зовёт общую кнопку со своим разделом.
    const direct = (section: string) =>
      [...sources.values()].some(
        (src) =>
          src.includes('AiSectionButton') &&
          (src.includes(`section="${section}"`) || src.includes(`aiSection="${section}"`)),
      );
    // Обёртка справочника: раздел передаётся пропом (`aiSection="..."`), а кнопку рисует
    // общая страница-обёртка (`section={props.aiSection}`).
    const wrapperPages = [...sources.values()].filter(
      (src) => src.includes('AiSectionButton') && src.includes('section={props.aiSection}'),
    );
    const wrapper = (section: string) =>
      wrapperPages.length > 0 && [...sources.values()].some((src) => src.includes(`aiSection="${section}"`));

    // Разделы отчётов-пресетов: у них кнопка на странице пресета, а раздел едет из
    // доменного правила — их проверяет отдельное правило ниже.
    const presetSections = new Set(PRESET_SECTIONS.map((entry) => entry.section));

    for (const section of registrySections()) {
      if (presetSections.has(section)) continue;
      expect(
        direct(section) || wrapper(section),
        `в доменном реестре есть раздел «${section}», а кнопки на его странице нет`,
      ).toBe(true);
    }
  });

  it('отчёт-пресет знает свой раздел по доменному правилу', () => {
    for (const entry of PRESET_SECTIONS) {
      expect(DOMAIN, `в домене нет правила «пресет → раздел» для ${entry.presetId}`).toContain(
        entry.presetId,
      );
      expect(DOMAIN).toContain(entry.section);
    }
    const presetPage = readFileSync(join(PAGES, 'ReportPresetPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
    expect(presetPage).toContain('aiSectionForPreset');
    expect(presetPage).toContain('AiSectionButton');
  });

  it('кнопка одна на программу: страницы не рисуют свою и не открывают чат сами', () => {
    for (const file of readdirSync(PAGES)) {
      if (!file.endsWith('.tsx')) continue;
      const page = readFileSync(join(PAGES, file), 'utf8').replace(/\r\n/g, '\n');
      // Своя кнопка «Нейросеть» мимо общей — вторая копия правила.
      expect(page, `${file}: своя кнопка «Нейросеть» мимо общей`).not.toMatch(
        />\s*Нейросеть\s*</,
      );
      // Второй чат не заводим: открытие «ИИваныча» живёт в App.
      expect(page, `${file}: страница открывает чат сама`).not.toContain("'ai_chat'");
      expect(page, `${file}: страница открывает чат сама`).not.toContain('setAiPrefill');
      expect(page, `${file}: страница открывает чат сама`).not.toContain('openAiChatWith');
    }
    // Открытие чата — одно место.
    expect(APP).toContain('openAiChatWith');
    expect(APP).toContain('AiChatLauncherProvider');
  });

  it('формат вопроса собирает домен, а не страница', () => {
    expect(DOMAIN).toContain('export function aiSectionQuestion');
    expect(DOMAIN).toContain('AI_SECTION_CONTEXT');
    for (const file of readdirSync(PAGES)) {
      if (!file.endsWith('.tsx')) continue;
      const page = readFileSync(join(PAGES, file), 'utf8').replace(/\r\n/g, '\n');
      expect(page, `${file}: страница собирает текст вопроса сама`).not.toContain('aiSectionQuestion(');
      expect(page, `${file}: страница собирает текст вопроса сама`).not.toContain(
        'productionProgramAiQuestion(',
      );
    }
    // ПП отдаёт домену название программы — и больше ничего.
    expect(BUTTON).toContain('aiSectionQuestion');
  });

  it('кнопки нет там, где нет канала действий (планшет)', () => {
    expect(AVAILABILITY).toContain('localStatus');
    expect(AVAILABILITY).toContain('configured === true');
    expect(BUTTON).toContain('useAiToolsAvailable');
    expect(BUTTON).toContain('if (!launcher || !available) return null;');
  });

  it('контекст раздела едет в тексте вопроса, а не в отдельном поле', () => {
    // Один композер, одна вкладка «ИИваныч»: префилл кладёт текст в поле ввода.
    expect(LAUNCHER).toContain('openAiChat');
    expect(BUTTON).toContain('launcher.openAiChat(question)');
    // Формат вопроса — общий хвост «данные в любом виде».
    expect(DOMAIN).toContain('Excel');
    expect(DOMAIN).toContain('Word');
  });
});
