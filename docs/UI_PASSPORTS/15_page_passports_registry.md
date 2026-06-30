# Реестр страниц и UI-паспортов

Назначение: быстрый переход от запроса «правим экран X» к нужному паспорту и к исходникам.

## Глобальные артефакты
| Объект | Паспорт | Основные исходники |
|---|---|---|
| Главное окно приложения | `00_global_window_passport.md` | `electron-app/src/renderer/src/ui/App.tsx`, `electron-app/src/renderer/src/ui/layout/Tabs.tsx`, `electron-app/src/renderer/src/ui/global.css` |
| Шаблоны разметки (T1..T5) | `01_templates_passport.md` | `electron-app/src/renderer/src/ui/components/EntityCardShell.tsx`, `electron-app/src/renderer/src/ui/components/SectionCard.tsx`, `electron-app/src/renderer/src/ui/components/DataTable.tsx`, `electron-app/src/renderer/src/ui/pages/ReportPresetPage.tsx` |

## Мой круг / Производство
| Таб/экран | Паспорт | Основные исходники |
|---|---|---|
| `history` | `10_history_production_passport.md` | `electron-app/src/renderer/src/ui/pages/HistoryPage.tsx` |
| `engines` / карточка двигателя | `10_history_production_passport.md` | `electron-app/src/renderer/src/ui/pages/EnginesPage.tsx`, `electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx` |
| `engine_brands` / карточка марки | `10_history_production_passport.md` | `electron-app/src/renderer/src/ui/pages/EngineBrandsPage.tsx`, `electron-app/src/renderer/src/ui/pages/EngineBrandDetailsPage.tsx` |
| `parts` / карточка детали | `10_history_production_passport.md` | `electron-app/src/renderer/src/ui/pages/PartsPage.tsx`, `electron-app/src/renderer/src/ui/pages/PartDetailsPage.tsx` |
| `part_templates` / карточка шаблона | `10_history_production_passport.md` | `electron-app/src/renderer/src/ui/pages/PartTemplatesPage.tsx`, `electron-app/src/renderer/src/ui/pages/PartTemplateDetailsPage.tsx` |
| `engine_assembly_bom` / карточка BOM | `10_history_production_passport.md` | `electron-app/src/renderer/src/ui/pages/EngineAssemblyBomPage.tsx`, `electron-app/src/renderer/src/ui/pages/EngineAssemblyBomDetailsPage.tsx` |

## Снабжение
| Таб/экран | Паспорт | Основные исходники |
|---|---|---|
| `requests` / карточка заявки | `11_supply_passport.md` | `electron-app/src/renderer/src/ui/pages/SupplyRequestsPage.tsx`, `electron-app/src/renderer/src/ui/pages/SupplyRequestDetailsPage.tsx` |
| `work_orders` / карточка наряда | `11_supply_passport.md` | `electron-app/src/renderer/src/ui/pages/WorkOrdersPage.tsx`, `electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx` |
| `tools` / карточка инструмента | `11_supply_passport.md` | `electron-app/src/renderer/src/ui/pages/ToolsPage.tsx`, `electron-app/src/renderer/src/ui/pages/ToolDetailsPage.tsx` |
| `tool_properties` / карточка свойства | `11_supply_passport.md` | `electron-app/src/renderer/src/ui/pages/ToolPropertiesPage.tsx`, `electron-app/src/renderer/src/ui/pages/ToolPropertyDetailsPage.tsx` |
| `products` / карточка товара | `11_supply_passport.md` | `electron-app/src/renderer/src/ui/pages/ProductsPage.tsx`, `electron-app/src/renderer/src/ui/pages/ProductDetailsPage.tsx` |
| `services` / карточка услуги | `11_supply_passport.md` | `electron-app/src/renderer/src/ui/pages/ServicesPage.tsx`, `electron-app/src/renderer/src/ui/pages/ServiceDetailsPage.tsx` |
| Каталоги снабжения (общий шаблон) | `11_supply_passport.md` | `electron-app/src/renderer/src/ui/pages/NomenclatureDirectoryPage.tsx`, `electron-app/src/renderer/src/ui/pages/nomenclatureDirectoryPresets.ts` |

## Склад
| Таб/экран | Паспорт | Основные исходники |
|---|---|---|
| `nomenclature` / карточка номенклатуры | `12_warehouse_passport.md` | `electron-app/src/renderer/src/ui/pages/NomenclaturePage.tsx`, `electron-app/src/renderer/src/ui/pages/NomenclatureDetailsPage.tsx` |
| `stock_balances` | `12_warehouse_passport.md` | `electron-app/src/renderer/src/ui/pages/StockBalancesPage.tsx` |
| `stock_documents` / карточка документа | `12_warehouse_passport.md` | `electron-app/src/renderer/src/ui/pages/StockDocumentsPage.tsx`, `electron-app/src/renderer/src/ui/pages/StockDocumentDetailsPage.tsx` |
| `stock_receipts` | `12_warehouse_passport.md` | `electron-app/src/renderer/src/ui/pages/StockReceiptsPage.tsx` |
| `stock_issues` | `12_warehouse_passport.md` | `electron-app/src/renderer/src/ui/pages/StockIssuesPage.tsx` |
| `stock_transfers` | `12_warehouse_passport.md` | `electron-app/src/renderer/src/ui/pages/StockTransfersPage.tsx` |
| `stock_inventory` | `12_warehouse_passport.md` | `electron-app/src/renderer/src/ui/pages/StockInventoryPage.tsx` |

## Договоры и контрагенты / Персонал
| Таб/экран | Паспорт | Основные исходники |
|---|---|---|
| `contracts` / карточка контракта | `13_business_people_passport.md` | `electron-app/src/renderer/src/ui/pages/ContractsPage.tsx`, `electron-app/src/renderer/src/ui/pages/ContractDetailsPage.tsx` |
| `counterparties` / карточка контрагента | `13_business_people_passport.md` | `electron-app/src/renderer/src/ui/pages/CounterpartiesPage.tsx`, `electron-app/src/renderer/src/ui/pages/CounterpartyDetailsPage.tsx` |
| `employees` / карточка сотрудника | `13_business_people_passport.md` | `electron-app/src/renderer/src/ui/pages/EmployeesPage.tsx`, `electron-app/src/renderer/src/ui/pages/EmployeeDetailsPage.tsx` |

## Контроль и аналитика / Админ / Системные
| Таб/экран | Паспорт | Основные исходники |
|---|---|---|
| `reports` / шаблоны отчётов | `14_control_admin_passport.md` | `electron-app/src/renderer/src/ui/pages/ReportsPage.tsx`, `electron-app/src/renderer/src/ui/pages/ReportPresetPage.tsx` |
| `report_preset` (детальный рендер отчёта) | `14_control_admin_passport.md` | `electron-app/src/renderer/src/ui/components/AssemblyForecastReportView.tsx` |
| `changes` | `14_control_admin_passport.md` | `electron-app/src/renderer/src/ui/pages/ChangesPage.tsx` |
| `audit` | `14_control_admin_passport.md` | `electron-app/src/renderer/src/ui/pages/SuperadminAuditPage.tsx` |
| `notes` | `14_control_admin_passport.md` | `electron-app/src/renderer/src/ui/pages/NotesPage.tsx` |
| `masterdata` | `14_control_admin_passport.md` | `electron-app/src/renderer/src/ui/pages/MasterdataPage.tsx`, `electron-app/src/renderer/src/ui/pages/MasterdataDirectoryPage.tsx` |
| `admin` | `14_control_admin_passport.md` | `electron-app/src/renderer/src/ui/pages/AdminPage.tsx`, `electron-app/src/renderer/src/ui/pages/AdminUsersPage.tsx`, `electron-app/src/renderer/src/ui/pages/AdminRolesPage.tsx` |
| `settings` | `14_control_admin_passport.md` | `electron-app/src/renderer/src/ui/pages/SettingsPage.tsx` |
| `auth` | `14_control_admin_passport.md` | `electron-app/src/renderer/src/ui/pages/AuthPage.tsx` |

## Как ссылаться в задачах
- Формат: `Паспорт: <имя_файла>; Экран: <tab/страница>; Source: <1-2 файла>`
- Пример: `Паспорт: 11_supply_passport.md; Экран: requests; Source: SupplyRequestsPage.tsx`
