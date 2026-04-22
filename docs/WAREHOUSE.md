# Warehouse Module

Краткий рабочий документ по складскому контуру: какие экраны есть в Electron, какие API и lookup-справочники используются, и какие инварианты нельзя ломать.

## Что входит в модуль
- Номенклатура: `electron-app/src/renderer/src/ui/pages/NomenclaturePage.tsx`, `NomenclatureDetailsPage.tsx`
- Остатки и движения: `StockBalancesPage.tsx`
- Журнал документов и карточка документа: `StockDocumentsPage.tsx`, `StockDocumentDetailsPage.tsx`
- Инвентаризация: `StockInventoryPage.tsx`
- Backend API: `backend-api/src/routes/warehouse.ts`, `backend-api/src/services/warehouseService.ts`
- Shared-контракты: `shared/src/domain/warehouse.ts`, `shared/src/ipc/types.ts`, `shared/src/sync/erpDto.ts`, `shared/src/sync/erpTables.ts`

## Основные справочники и lookup-источники
- Склады: masterdata type `warehouse_ref`
- Группы номенклатуры: masterdata type `nomenclature_group`
- Единицы измерения: masterdata type `unit`
- Причины списания: masterdata type `stock_write_off_reason`
- Контрагенты: ERP dictionary `erp_counterparties`
- Сотрудники-авторы: ERP dictionary `erp_employee_cards`

Все перечисленные lookup'и агрегируются через `GET /warehouse/lookups` и в Electron загружаются через `window.matrica.warehouse.lookupsGet()`.

## Экранный контур Electron
- `Номенклатура`: фильтры по типу, группе, активности; карточка умеет редактировать `groupId`, `unitId`, `defaultWarehouseId` и показывает остатки/движения.
- `Остатки`: фильтры по складу и номенклатуре через lookup/select, подсветка low-stock, drill-down в последние движения и переход в документ-основание.
- `Складские документы`: отдельная точка входа помимо вкладок `Приход`, `Расход`, `Перемещения`, чтобы не терять `Списание` и mixed-сценарии.
- `Карточка складского документа`: разные поля для `stock_receipt`, `stock_issue`, `stock_transfer`, `stock_writeoff`, `stock_inventory`; поддержка добавления/удаления строк, загрузки инвентаризации по текущим остаткам, отмены черновика и проведения.
- `Инвентаризация`: загрузка учетных остатков по складу, ввод факта, создание документа инвентаризации с подготовленными строками.

## Backend API
- `GET /warehouse/lookups`
- `GET /warehouse/nomenclature`
- `POST /warehouse/nomenclature`
- `DELETE /warehouse/nomenclature/:id`
- `GET /warehouse/stock`
- `GET /warehouse/documents`
- `GET /warehouse/documents/:id`
- `POST /warehouse/documents`
- `POST /warehouse/documents/:id/post`
- `POST /warehouse/documents/:id/cancel`
- `GET /warehouse/movements`
- `POST /warehouse/forecast/assembly-7d` — stateless прогноз сборки (не пишет в ledger; вход: цель/склады/марки/план поступлений). Реализация: `backend-api/src/services/warehouseForecastService.ts`

## Аудит и прогноз
- Отчёт `warehouse_stock_path_audit` в разделе «Отчёты» показывает случаи двойного учёта одной детали по `nomenclature_id` (зеркало `part`) и `part_card_id` на одном складе.
- Отчёт `assembly_forecast_7d` строит план расхода (до 31 дня) по текущим остаткам **номенклатуры** и связям деталь↔марка; редактируемый план поступлений хранится только в фильтре JSON на клиенте.
- Чистая логика подбора/прогноза вынесена в `shared/src/domain/assemblyForecast.ts` (используется и в Electron, и на backend).
- Результат прогноза включает `deficitRecommendations` — структурированные рекомендации по дефициту комплектующих (что производить/закупать, в каком количестве, для каких марок).

## Документный lifecycle
- Новый/редактируемый складской документ живет в статусе `draft`.
- Редактирование разрешено только для `draft`.
- `POST /warehouse/documents/:id/post` проводит документ и формирует движения/остатки.
- `POST /warehouse/documents/:id/cancel` отменяет только `draft`; проведенный документ без сторнирующей операции не отменяется.

## Что хранится явно, а что остается в payload
- Явные поля номенклатуры: `groupId`, `unitId`, `defaultWarehouseId`, `minStock`, `maxStock`, `barcode`, `itemType`, `isActive`.
- На границе UI/API строки документа уже передают typed-поля: `warehouseId`, `fromWarehouseId`, `toWarehouseId`, `bookQty`, `actualQty`, `adjustmentQty`, `reason`, `nomenclatureId`.
- В `payloadJson` по-прежнему допускаются дополнительные реквизиты, но ключевые складские поля должны проходить через typed API-аргументы и shared types.

## Инварианты
- Проведенный документ не редактируется.
- Для `stock_transfer` склады отправителя и получателя не могут совпадать.
- Инвентаризация может формировать движения при `actualQty - bookQty != 0` даже если строковое `qty` равно `0`.
- Отрицательные остатки при проведении не допускаются.
- Остатки и движения синхронизируются через ledger-only контур; warehouse DTO в `shared/src/sync/erpDto.ts` и перечень таблиц в `shared/src/sync/erpTables.ts` должны оставаться согласованными с backend schema.

## Базовая проверка после изменений
```bash
pnpm build
pnpm lint
```

## Двойной учёт остатков: nomenclature_id vs part_card_id

`erp_reg_stock_balance` поддерживает два альтернативных ключа учёта:
- `(nomenclature_id, warehouse_id)` — используется складским контуром (`postWarehouseDocument`). Все новые балансовые строки создаются с `partCardId: null`.
- `(part_card_id, warehouse_id)` — используется legacy ERP-контуром (`postErpDocument` в `erpService.ts`). Этот путь не записывает `nomenclatureId`.

`erp_document_lines` не имеет явной колонки `nomenclature_id` — он хранится в `payloadJson`. Регистр движений `erp_reg_stock_movements` работает только с `nomenclature_id`.

**Текущее состояние:**
- Складской контур (приход/расход/перемещение/инвентаризация через UI) работает корректно через `nomenclature_id`.
- ERP-контур (legacy части/документы) пишет через `part_card_id`, создавая параллельные балансовые строки.
- Для диагностики существует отчёт `warehouse_stock_path_audit`.

**План унификации (не блокирует текущую разработку):**
1. Все новые складские операции проводить **только** через `nomenclature_id`.
2. ERP-путь `postErpDocument` при необходимости — legacy; новые документы создаются через складской контур.
3. В перспективе добавить явную колонку `nomenclature_id` в `erp_document_lines`.
4. Миграция существующих `part_card_id`-only балансов: через dry-run скрипт выявить такие строки и привязать к соответствующим `nomenclature_id` через зеркала `erp_nomenclature.directory_ref_id`.

## Directories -> Nomenclature (phase-1)
- В `erp_nomenclature` добавлены поля происхождения: `directory_kind`, `directory_ref_id`.
- Добавлены таблицы справочников-шаблонов: `directory_engine_brands`, `directory_parts`, `directory_tools`, `directory_goods`, `directory_services`.
- Legacy-таблицы и зеркальный контур не удаляются на этой фазе; миграция только расширяет модель и помечает новый вектор развития.
- Режим зеркала детали в номенклатуру теперь управляется `MATRICA_WAREHOUSE_PART_MIRROR_MODE`:
  - `legacy` — старое поведение (зеркала + запрет редактирования linked строк),
  - `directory` (по умолчанию) — подготовка к модели directory-first без жесткой блокировки карточки.

### Dry-run перед APPLY MIGRATION
```bash
pnpm -C backend-api warehouse:directories-dry-run
pnpm -C backend-api warehouse:directories-dry-run -- --json
```

Dry-run проверяет:
- счетчики источников (`entities` по типам) vs целевые `directory_*`/`erp_nomenclature`,
- сироты FK для `erp_reg_*`, `erp_engine_instances`, `erp_document_lines.part_card_id`,
- неконсистентные ссылки `erp_nomenclature.directory_ref_id`,
- коллизии `sku`/`code`,
- текущий объем legacy-зеркал `spec_json.source = part`.

## Управляемая номенклатура (templates/properties/types)

- Для номенклатуры введен governance-контур на базе masterdata:
  - типы номенклатуры: `nomenclature_item_type`,
  - свойства номенклатуры: `nomenclature_property`,
  - шаблоны номенклатуры: `nomenclature_template`.
- `GET /warehouse/lookups` теперь отдает также:
  - `nomenclatureItemTypes`,
  - `nomenclatureProperties`,
  - `nomenclatureTemplates`.
- Добавлены API-ручки CRUD:
  - `GET/POST/DELETE /warehouse/nomenclature/item-types`,
  - `GET/POST/DELETE /warehouse/nomenclature/properties`,
  - `GET/POST/DELETE /warehouse/nomenclature/templates`.
- В `POST /warehouse/nomenclature` ужесточена валидация создания:
  - обязательны `directoryKind`, `directoryRefId`, `groupId`, `unitId`,
  - обязательна ссылка на шаблон в `specJson.templateId`,
  - обязательные свойства шаблона должны быть заполнены в `specJson.propertyValues`,
  - имя при создании берется из записи источника (`directory_*`), а не из свободного ручного ввода.

### Backfill legacy записей

- Добавлен скрипт `backend-api/src/scripts/backfillNomenclatureGovernance.ts`.
- Скрипт:
  - создает fallback-шаблоны `legacy_*`,
  - проставляет `specJson.templateId` и пустой `propertyValues` там, где governance-метки отсутствуют.
