import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// СТОРОЖ кнопки нейросети в разделах (промт КАРМАНА #176, разрез 4).
//
// Пять правил, каждое — про конкретный способ разъехаться:
//
//  1. В КАЖДОМ разделе, куда кнопка объявлена, она ЕСТЬ: страница зовёт общую кнопку
//     с ключом своего раздела. Список разделов — здесь, в стороже: новая страница без
//     кнопки видна сразу, а не «когда-нибудь всплывёт».
//  2. Кнопка ОДНА на программу: страницы не рисуют свою кнопку «Нейросеть» и не
//     открывают чат сами — открытие живёт в App (второго чата не заводим).
//  3. Формат вопроса собирает ДОМЕН, а не страница: в страницах нет сборки текста.
//  4. Кнопки нет там, где нет канала действий (планшет): проверка — общая.
//  5. Контекст раздела едет в ТЕКСТЕ вопроса: одна вкладка «ИИваныч», а раздел —
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
];

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
