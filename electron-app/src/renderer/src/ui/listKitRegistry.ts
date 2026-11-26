/**
 * РЕЕСТР СПИСКОВ ПРОГРАММЫ — состояние источника, а не вид на одном экране (идея #331).
 *
 * Правило нитки «Списки по одним правилам» (промт КАРМАНА #67, D-248): список
 * **объявляет** свои действия, а правила (выделение, контур, перетаскивание, меню) берёт
 * из общего источника. Пока это правило живёт в коде страниц, «везде одинаково» нельзя
 * ни проверить, ни доказать: нельзя прочитать, какие списки на ките, а какие мимо.
 *
 * Этот файл — **реестр**: перечень таблиц-страниц программы с их состоянием.
 *  - `on-kit` — список живёт по общему киту (выделение, контур, меню по объявлению);
 *  - `pending` — список в объёме (D-248 ③: только таблицы-страницы), но ещё не переведён;
 *  - `out-of-scope` — список сознательно вне объёма, с причиной.
 *
 * Сторож `ui/listKitRegistry.guard.test.ts` держит реестр в согласии с кодом: страница
 * с таблицей, которой нет в реестре, роняет гейт — новый список нельзя завести мимо
 * кита молча. Реестр — это и список работы следующих заходов: `pending` = что переводить.
 */

/** Что за страница: список верхнего уровня, отчёт, карточка (список внутри карточки). */
export type ListKitPageKind = 'list-page' | 'report' | 'card';

/** Состояние списка относительно кита. */
export type ListKitPageStatus = 'on-kit' | 'pending' | 'out-of-scope';

export type ListKitPageEntry = {
  /** Файл страницы относительно каталога `ui/`. */
  file: string;
  kind: ListKitPageKind;
  status: ListKitPageStatus;
  /** Почему список вне объёма (обязательно для `out-of-scope`). */
  reason?: string;
  /** Что именно осталось сделать для списка в объёме (для `pending`). */
  note?: string;
};

export const LIST_KIT_PAGES: ListKitPageEntry[] = [
  // --- Списки верхнего уровня (кит + приёмка, PR #1923) ---
  { file: './pages/ContractsPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/CounterpartiesPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/EmployeesPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/EnginesPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/PpeCardsPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/ToolPropertiesPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/WorkOrdersPage.tsx', kind: 'list-page', status: 'on-kit' },
  // --- Справочники: начало фазы «остальные модули» ---
  { file: './pages/EngineBrandGroupsPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/EngineBrandsPage.tsx', kind: 'list-page', status: 'on-kit' },
  // --- Партия 1 «склад и справочники» (25.11.2026): цеха, инвентаризация, остатки по локациям ---
  { file: './pages/MasterdataWorkshopsPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/StockInventoryPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/WarehouseLocationsPage.tsx', kind: 'list-page', status: 'on-kit' },
  // --- Табели и номера РМЗ: переведены на кит 25.11.2026, реестр отставал ---
  { file: './pages/EngineRmzNumbersPage.tsx', kind: 'list-page', status: 'on-kit' },
  { file: './pages/TimesheetsPage.tsx', kind: 'list-page', status: 'on-kit' },
  // --- Производственная программа (шов с ПП, PR #1929 + #1948 + #1972 + этот заход:
  //     подключён слой выделения контуром — до него ПП был единственным списком кита
  //     без Ctrl + рамки). ---
  { file: './pages/ProductionProgramPage.tsx', kind: 'list-page', status: 'on-kit' },
  // --- Отчёты (PR #1927): объём закрыт тремя страницами ---
  { file: './pages/reports/EnginesNowAtPlantReportPage.tsx', kind: 'report', status: 'on-kit' },
  { file: './pages/reports/EnginesReportPage.tsx', kind: 'report', status: 'on-kit' },
  { file: './pages/reports/WorkSheetsReportPage.tsx', kind: 'report', status: 'on-kit' },
  // --- Карточки: списки, которые умеют менять порядок строк (PR #1934 + #1938) ---
  { file: './pages/ContractDetailsPage.tsx', kind: 'card', status: 'on-kit' },
  { file: './pages/EmployeeDetailsPage.tsx', kind: 'card', status: 'on-kit' },
  { file: './pages/StockDocumentDetailsPage.tsx', kind: 'card', status: 'on-kit' },
  { file: './pages/SupplyRequestDetailsPage.tsx', kind: 'card', status: 'on-kit' },
  { file: './pages/TimesheetGridPage.tsx', kind: 'card', status: 'on-kit' },
  { file: './pages/ToolDetailsPage.tsx', kind: 'card', status: 'on-kit' },
  { file: './pages/WorkOrderDetailsPage.tsx', kind: 'card', status: 'on-kit' },

  // --- Вне объёма: решения владельца (D-248 ③ + план §ШАГ 4) ---
  {
    file: './pages/ReportPresetPage.tsx',
    kind: 'list-page',
    status: 'out-of-scope',
    reason: 'пресетные таблицы: строки позиционные, устойчивого ключа строки нет — отдельная задача',
  },
  {
    file: './pages/CustomReportsPage.tsx',
    kind: 'list-page',
    status: 'out-of-scope',
    reason: 'конструктор отчётов: строки позиционные, это редактор запроса, а не список-отчёт',
  },

  // --- В объёме, но ещё не на ките (следующие заходы) ---
  { file: './pages/AccessSectionsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/AdminPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/ChangesPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/ChildrenPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/DraftsPage.tsx', kind: 'list-page', status: 'pending' },
  // «Удалённое за 3 дня» (промт КАРМАНА #169): новая страница-список, в объёме D-248 ③,
  // но ещё не переведена на кит — перевод идёт партиями (см. docs/pending/list-kit-remaining-pages.md).
  { file: './pages/DeletedObjectsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/EmptyCardsCleanupPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/EngineAssemblyBomDetailsPage.tsx', kind: 'card', status: 'pending' },
  { file: './pages/EngineAssemblyBomPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/EngineDetailsPage.tsx', kind: 'card', status: 'pending' },
  { file: './pages/FileSearchPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/NomenclatureDetailsPage.tsx', kind: 'card', status: 'pending' },
  { file: './pages/NomenclatureDirectoryPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/NomenclaturePage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/OrganizationPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PartsDedupePage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PpeCardDetailsPage.tsx', kind: 'card', status: 'pending' },
  { file: './pages/PpeCollectivePage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PpeGroupsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PpeImportPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PpeJournalPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PpeNormsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PpeStockPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PpeVacationSchedulePage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PrintDocumentsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/PrintFormsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/RepairFundAuditPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/ServicePriceOrdersPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/ServicesByBrandPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/StockBalancesPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/StockDocumentsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/SuperadminAuditPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/SupplyRequestsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/SupplyToolMovementsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/UserScreensPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/UserScreenViewPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/WarehouseLocationsAdminPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/WorkOrderTemplatesPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/WorkSheetsPage.tsx', kind: 'list-page', status: 'pending' },
  { file: './pages/WorkshopStatsPage.tsx', kind: 'list-page', status: 'pending' },
];

/** Списки на ките — по ним приёмка читает состояние источника. */
export const LIST_KIT_ON_KIT = LIST_KIT_PAGES.filter((entry) => entry.status === 'on-kit');

/** Списки в объёме, но ещё не переведённые на кит — следующие заходы. */
export const LIST_KIT_PENDING = LIST_KIT_PAGES.filter((entry) => entry.status === 'pending');
