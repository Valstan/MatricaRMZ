# Объединение Акта комплектности и Листа дефектовки + удаление Контрольного листа ремонта

Версия плана: 2026-05-24
Преемник пунктов [`PENDING_FOLLOWUPS.md`](../../PENDING_FOLLOWUPS.md): **#4** (выбор `variantGroup` BOM в Assembly наряде) и **#5** (третий вариант решения «заменить новой» в дефектовке).

## Context

### Состояние сейчас

[`EngineDetailsPage.tsx`](../../electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx) рендерит **три независимых экземпляра** [`RepairChecklistPanel`](../../electron-app/src/renderer/src/ui/components/RepairChecklistPanel.tsx) для каждого двигателя:

| stage | Бизнес-смысл | UI-метка | Поля |
|---|---|---|---|
| `defect` | Что ремонтопригодно, что утиль | «Лист дефектовки» | `quantity`, `repairable_qty`, `scrap_qty` |
| `completeness` | Всё ли на месте при приёмке | «Акт комплектности» | `quantity`, `present`, `actual_qty` |
| `repair` | (не используется заводом) | «Контрольный лист ремонта» | template-driven |

Каждый stage — **отдельная запись** в `operations.metaJson` с `kind='repair_checklist'`. Источник строк deflect/completeness — `listAllParts({ engineBrandId })` (EAV `brandLinks`), **не** BOM-спецификация.

### Бизнес-фидбек оператора (2026-05-24)

> «Акт комплектности и Акт дефектовки — это почти одно и то же, просто два раза проверяется. Сначала при приходе двигателя проверяют все ли детали на месте — если чего-то не хватает, помечают и распечатывают для заказчика. Потом — дефектовка по тому же списку: какие детали ремонтопригодны, какие в утиль. Можно их объединить — один список деталей с полями для учёта обоих актов + две распечатки. И Контрольный лист ремонта совсем убрать, мы им не пользуемся.»

### Связанные нитки

- **#4 PENDING — выбор `variantGroup` BOM в Assembly наряде.** Здесь нужно: выбранный variantGroup используется как фильтр строк объединённого списка (variantGroup определяет какие детали относятся к этой сборке двигателя).
- **#5 PENDING — третий вариант решения «заменить новой».** Здесь становится новой колонкой `replace_qty` в объединённой схеме.

## Цели

1. **Один список деталей** двигателя — единый источник истины для приёмки и дефектовки.
2. **Удалить `stage='repair'`** (Контрольный лист ремонта) — не используется.
3. **Две печатные формы** из одного списка: «Акт комплектности» и «Акт дефектовки».
4. **Опциональный фильтр по `variantGroup`** — из выбора в Assembly наряде (когда у марки двигателя несколько вариантов сборки).
5. **Третий вариант решения** `replace_qty` в схеме дефектовки.

## Схема объединённой таблицы

Поля одной строки в таблице:

```ts
type EngineInventoryRow = {
  // Идентификация
  part_name: string;
  assembly_unit_number: string;
  bom_variant_group?: string | null;  // если строка пришла из BOM с variantGroup

  // Плановые
  quantity: number;  // плановое кол-во из BOM/brandLink

  // Приёмка (Акт комплектности)
  present: boolean;
  actual_qty: number;

  // Дефектовка (Лист дефектовки)
  repairable_qty: number;
  scrap_qty: number;
  replace_qty: number;  // НОВОЕ — третий вариант (#5)
};
```

Шапка панели:
- подпись приёмщика + дата приёмки (для Акта комплектности)
- подпись дефектовщика + дата дефектовки (для Листа дефектовки)
- общие поля: контракт, № двигателя, марка

## Этапы

### Этап 1 — Подготовка shared + миграция legacy answers

- Расширить `shared/src/domain/repairChecklist.ts`:
  - Новый `stage='engine_inventory'` (или иное имя).
  - Новая нормализация `normalizeEngineInventoryRows`.
  - Pure-функция миграции `mergeLegacyAnswers(defectAnswers, completenessAnswers) → engineInventoryAnswers`.
- Unit-тесты:
  - Миграция defect-only записи → row с `repairable_qty/scrap_qty`, поля приёмки = defaults.
  - Миграция completeness-only → row с `present/actual_qty`, поля дефектовки = defaults.
  - Миграция обоих → объединение по `(part_name, assembly_unit_number)` сигнатуре.
- Поле `replace_qty: 0` default везде.

### Этап 2 — Backend (миграция данных в проде)

- Admin-скрипт `pnpm -F @matricarmz/backend-api engine-inventory:migrate` с `--dry-run | --apply`.
- Для каждой пары `operations(stage='defect') + operations(stage='completeness')` одного `engine_entity_id`:
  - Создать новый `operations(stage='engine_inventory')` с объединённым answers.
  - Soft-delete старых двух записей (`deleted_at = now`).
- Audit log: `engine_id`, `row_count_defect`, `row_count_completeness`, `row_count_merged`.
- Скрипт не пишет в `change_log` — миграция БД, sync через next-run.

### Этап 3 — UI (объединённая панель)

Разбит на подэтапы 3a → 3b → 3c. Решено **не выделять** отдельный `EngineInventoryPanel.tsx`, а ввести в существующий `RepairChecklistPanel` ветку `stage='engine_inventory'` — экономит дублирование табличной/подписной инфраструктуры. 3a/3b ✅ раскатаны в v1.23.0.

**Этап 3a — backend template (`v1.23.0`, PR #39).** Зарегистрирован `defaultEngineInventoryTemplate()` в [`backend-api/src/services/checklistService.ts`](../../backend-api/src/services/checklistService.ts). 9 колонок таблицы `engine_inventory_items` под все поля `EngineInventoryRow`. Подписи acceptance_signed_by / defect_signed_by / approved_by.

**Этап 3b — UI-панель (`v1.23.0`, PR #41+#42).** `RepairChecklistPanel` поддерживает `stage='engine_inventory'`: единая таблица, autopopulate brand/number/contract/arrivalDate, lock-поля, brand-rows-sync. Кнопки «Печать акта комплектности» и «Печать акта дефектовки» поставлены как **заглушки** (status-toast «в Этапе 3c»). Все 1625 двигателей мигрированы (`engine-inventory:migrate --apply`).

**Этап 3c — печатные шаблоны (текущая нитка).** Восстановить функциональность двух кнопок: каждая открывает свой A4-preview из единого `EngineInventoryRow`-источника.

Объём:

- Новый файл `electron-app/src/renderer/src/ui/utils/engineInventoryPrintHtml.ts`:
  - `buildInventoryActHtml(opts)` — **Акт комплектности**. Шапка: contract_number / engine_brand / engine_number / arrival_date / acceptance_method. Таблица: part_name, assembly_unit_number, part_number, quantity (План), present (Наличие), actual_qty (Фактически). Подписи: acceptance_signed_by, approved_by.
  - `buildInventoryDefectHtml(opts)` — **Акт дефектовки**. Шапка: contract_number / engine_brand / engine_number / defect_start_date / defect_end_date. Таблица: part_name, part_number, quantity (Кол-во), repairable_qty (Ремонтопригодная), scrap_qty (Утиль), replace_qty (Заменить новой). Подписи: defect_signed_by, approved_by.
  - Общий стиль: A4 portrait, Times New Roman, шапка с реквизитами, табличная часть, блок подписей.
  - Источник данных — `answers[engine_inventory_items].rows: EngineInventoryRow[]` плюс остальные поля из `answers` (даты, подписи) и `props` (engineBrand, engineNumber).
- В `RepairChecklistPanel.tsx`: заменить два status-toast на реальные вызовы `buildInventoryActHtml` / `buildInventoryDefectHtml` + открытие нового окна (паттерн как у существующего `printChecklist`).
- `/verify` на TEST-001: открыть карточку, нажать обе кнопки, визуально проверить превью.
- PR `feat/checklist-unify-stage-3c-print-templates` → merge → релиз **v1.24.0** (UI-only, без `db:migrate`).

### Этап 4 — Удаление legacy `stage='repair'`

- Убрать `<RepairChecklistPanel stage="repair">` из `EngineDetailsPage`.
- Soft-delete всех `operations(stage='repair')` миграционным admin-скриптом (опционально — пользователь подтвердил «не используется»).
- Удалить template `repair-checklist` если он отдельная сущность.
- Очистить ветки в `RepairChecklistPanel` про `stage === 'repair'` (или удалить компонент целиком если Этап 3 уже закончен).

### Этап 5 — Интеграция с #4 (variantGroup в Assembly наряде) ✅ ЗАВЕРШЁН 2026-06-07

**Готово** (`feat/checklist-unify-stage-5-variant-filter`): список деталей двигателя
(`RepairChecklistPanel(engine_inventory)`) фильтруется по варианту сборки активного
Assembly-наряда. electron-main DAL `getActiveAssemblyVariant(engineId)` + IPC; панель строит
`Map<nomenclatureId, Set<variantGroup>>` из активного BOM марки; view-time фильтр через
`TableEditor.isRowHidden` (строки скрываются, не удаляются — save/индексы/brand-sync целы).
Баннер + тумблер «Показать все детали», ON по умолчанию; общие детали (без variantGroup) видны
всегда. Pure-хелпер `isInventoryRowVisibleForVariant` + 6 юнит-тестов. Попутно исправлен латентный
баг: `assemblyBomGet` отдаёт линии под `.bom.lines` (и селектор Stage 5 part 1 в `WorkOrderDetailsPage`
читал `.lines` → не появлялся). CDP /verify PASS. **Нитка checklist-unify закрыта целиком.**

Исходный план этапа (для истории):

- Расширить `WorkOrderPayload` полем `assemblyVariantGroup?: string | null`.
- `WorkOrderDetailsPage` (Assembly наряд):
  - При выборе двигателя — загрузить BOM марки → собрать уникальные `variantGroup`'ы → SearchSelect.
  - При сохранении наряда — поле летит в payload и через ledger в `operations.metaJson`.
- `EngineInventoryPanel`: если `engineId` имеет активный Assembly наряд с непустым `assemblyVariantGroup` — использовать его как default filter для строк (показывать только строки с совпадающим `bom_variant_group` либо без variantGroup вообще).
- При необходимости — отдельный endpoint `GET /warehouse/assembly-bom/variants?engineBrandId=` (если BOM ещё не загружается на клиенте при выборе двигателя).

## Риски

- **Критический путь оператора** — обязательно `/verify` (live UI) перед merge каждого этапа.
- **Миграция answers** — данные старых двигателей. Forward скрипт обязательно с `--dry-run` режимом, audit row counts, документация в `DEVELOPMENT_LOG.md`.
- **Sync compat** — новый `stage='engine_inventory'` должен быть в whitelist у старых клиентов или они должны его игнорировать без ошибок. Проверить `applyPushBatch.ts` и shared registry.
- **Печатные формы** — пользователь может попросить точную копию старых шаблонов. Лучше показать макет до Этапа 3 финала.

## Объём

5 PR в указанном порядке. Каждый — независимый, проверяемый, реверсивный. Каждый кроме Этапа 1 требует `/verify`. Совокупный объём — несколько сессий разработки.

## Этап 0 — Подтверждение (до старта)

Перед Этапом 1 уточнить у пользователя:
- [ ] Печатные формы: использовать существующие HTML-шаблоны (defect-act / completeness-act) как старт, либо новые макеты?
- [ ] Удаление `stage='repair'` сразу или после прогона Этапов 1-3 (на случай если оператор вспомнит use case)?
- [ ] Имя нового stage: `engine_inventory` / `engine_parts` / иное?
- [ ] Подтверждение поля `replace_qty` (третий вариант решения) — оно дополняет repairable+scrap или **заменяет** один из них?
