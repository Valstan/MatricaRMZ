# Миграция: Parts → Nomenclature (единый источник истины для изделий)

Документ-план для финального слияния legacy-справочника деталей (`entities.type=part`) и складской номенклатуры (`erp_nomenclature`) в один источник истины. Является Phase-2 продолжением Phase-1 (см. [`WAREHOUSE.md`](WAREHOUSE.md) → секция «Directories -> Nomenclature (phase-1)»).

## Контекст и мотивация

Сегодня в системе живут **3 параллельных способа** хранить «изделие»:

1. **`part` (legacy)** — EAV в `entities` + `attribute_values`. Богатая модель (размеры, шаблоны, привязки к маркам двигателей).
2. **`erp_nomenclature` (текущий склад)** — колоночная таблица с 13 itemType (engine, assembly, part, component, material, consumable, tool, good, service, semi_product, product, waste, tool_consumable). Это **то, что видит склад, прогноз сборки, BOM, документы**.
3. **`directory_*` (phase-1 будущее)** — нормализованные таблицы `directory_engine_brands`, `directory_parts`, `directory_tools`, `directory_goods`, `directory_services`. Связаны с `erp_nomenclature` через `directory_kind` + `directory_ref_id`.

**Симптом проблемы (наблюдаемый пользователем):** позиции, забитые напрямую в номенклатуру склада (для прогноза сборки), не были видны в карточке наряда — потому что наряд читал из legacy `part`, а не из nomenclature. На сегодня (2026-05-20) в hotfix 1.16.6 наряд переведён на nomenclatureList, **но в других 19 UI-местах разночтение источников осталось**.

## Целевое архитектурное состояние

После Phase-2:

- **`erp_nomenclature` — единственный источник истины для всех «изделий»** во всём UI: справочниках, нарядах, BOM, заявках в снабжение, документах склада, ремонтных листах, диалогах сборки/возврата.
- **Specialized метаданные «детали»** (размеры, шаблон, привязки к маркам) живут в `directory_parts`, связаны с nomenclature через `directory_ref_id`. Доступ к ним из карточки номенклатуры через подпанель «Спецификация детали» (показывается при `itemType=part`).
- **Старый раздел «Справочник деталей»** превращается в страницу-фильтр над номенклатурой (`itemType=part`).
- **Legacy зеркало `part→nomenclature`** удаляется. Создание/изменение детали идёт через карточку номенклатуры (с подпанелью спецификации).
- **Legacy `entities.type=part`** архивируется (не удаляется, чтобы остался audit trail), но новых записей туда не пишется.

## Состояние данных на проде (2026-05-20)

Результат `pnpm -C backend-api warehouse:directories-dry-run`:

```
sourceCounts (entities):
  engine_brand: 37
  part:         159   ← кандидаты на миграцию
  tool:         2
  product:      84
  service:      364

targetCounts (directory + nomenclature):
  directory_engine_brands: 0    ← пусто, нужен backfill
  directory_parts:         0    ← пусто, нужен backfill
  directory_tools:         2    ✓ уже мигрировано
  directory_goods:         84   ✓
  directory_services:      363  ✓ (потеря 1 строки — recoverable)
  erp_nomenclature:        633

mirrorRows (part-зеркала): 155  ← из 159 part только 155 имеют зеркало
                                  → 4 part без mirror, нужно восстановить или удалить

fkOrphans:
  stock_balance_nomenclature:  2   ← баланс ссылается на удалённую nomenclature
  stock_movement_nomenclature: 2   ← движение ссылается на удалённую nomenclature
  engine_instances_nomenclature: 0
  document_lines_part_card:    0
  nomenclature_directory_ref_missing: 0

collisionChecks:
  active_sku_duplicates:  0
  active_code_duplicates: 0

canApply: FALSE  ← блок из-за orphans
```

## План работ (релиз 1.17.0)

### Этап A — Подготовка и диагностика

**A.1.** Расширить `backend-api/src/scripts/dryRunDirectoriesToNomenclature.ts` так, чтобы при флаге `--inspect-orphans` он выводил список конкретных orphan-id (id баланса/движения, проблемный nomenclature_id, warehouse_id, qty, performedAt, документ-источник если есть). Без --inspect-orphans поведение остаётся прежним (counts only).

**A.2.** Прогнать `--inspect-orphans` на проде, классифицировать каждый из 4 orphans:
- **(a) реальные данные с потерянной номенклатурой** → восстановить плейсхолдер в `erp_nomenclature` с placeholder-именем, или перепривязать баланс к существующей nomenclature по spec.
- **(b) артефакты разработки / тестовые данные** → soft-delete (`deleted_at = now()`) с заметкой в notes.
- Решение по каждому документировать в этом файле (секция «Orphan resolution log» внизу).

**A.3.** Исследовать **4 part без mirror**: получить их id из `entities` WHERE `type=part` AND NOT IN `(SELECT id FROM erp_nomenclature WHERE spec_json LIKE '%source":"part%')`. Решить: восстановить mirror (если part действительно используется) или soft-delete part (если он сирота).

**A.4.** Решить про **1 потерянную службу** (entity service: 364, directory_services: 363). Скорее всего это soft-deleted entity не отфильтрованная dry-run-ом. Подтвердить.

### Этап B — Backfill directory_engine_brands + directory_parts

**B.1.** Создать `backend-api/src/scripts/backfillDirectoryEngineBrands.ts`:
- Для каждой `entities` WHERE `type=engine_brand` AND `deleted_at IS NULL`:
  - upsert в `directory_engine_brands` с тем же UUID (`id`), name из displayName/`attribute_values:name`, прочие атрибуты переносим как есть.
- Идемпотентность: если row уже есть — обновляем поля (name, code), не дублируем.
- Поддержать флаги `--dry-run` и `--apply`.

**B.2.** Создать `backend-api/src/scripts/backfillDirectoryParts.ts`:
- Для каждой `entities` WHERE `type=part` AND `deleted_at IS NULL`:
  - upsert в `directory_parts` (схема: id, name, article/sku, template_id, dimensions_json, brand_links_json, ...).
  - Атрибуты из `attribute_values` (name, article, template_id, etc.) → колонки/JSON в `directory_parts`.
  - Привязки `part_engine_brand` (entities) → нормализовать в JSON-массив `brand_links` или (если решим) в отдельную таблицу `directory_parts_brand_links`.
  - Размеры детали (привязки `entities part_dimension`) → JSON-массив.
- Гарантировать существование `erp_nomenclature` строки с тем же UUID + `directory_kind='part'` + `directory_ref_id=part.id` + `item_type='part'`.
- Идемпотентность.

**B.3.** Прогнать оба backfill-скрипта в `--dry-run` на проде → инспекция counters и diff'ов → `--apply`.

**B.4.** Прогнать финальный `dryRunDirectoriesToNomenclature.ts` без флагов:
- ожидаемые counters: `directory_engine_brands: 37`, `directory_parts: 159`, `mirrorRows: 159` (или 0 — зависит от решения по зеркалу), `orphans: 0`, `canApply: TRUE`.
- Если `canApply: TRUE` — этап B завершён.

### Этап C — Backend API для редактирования спецификации детали через nomenclature

**C.1.** Изучить существующий `/parts` API (списки, get, update, attribute-defs). Решить:
- **Вариант 1 (рекомендуется):** добавить новые endpoints `/warehouse/nomenclature/:id/part-spec` (GET, PUT) которые внутри транзакции апдейтят `directory_parts` и связи. Это семантически чисто.
- Вариант 2: переиспользовать `/parts/:id` PUT, но направлять mutation через `directory_parts` (FK на nomenclature). Менее чисто, но меньше нового кода.

**C.2.** В IPC `electron-app/src/main/services/partsService.ts` добавить методы `partsGetSpec(nomenclatureId)` и `partsUpdateSpec(nomenclatureId, spec)` поверх новых endpoints. Старые методы (`partsList`, `partsGet`, `partsCreate`, `partsUpdate`) **временно остаются** для backward-compat (используются другими местами UI до Этапа D).

### Этап D — Frontend: переключение всех UI-мест выбора изделия на nomenclatureList

20 файлов из grep `parts\.list\(|nomenclatureList\(|listAllParts\(` (electron-app/src/renderer). Per-file decision:

| Файл | Текущее использование | Действие в Phase-2 |
|---|---|---|
| `WorkOrderDetailsPage.tsx` | parts.list для «Наименование изделия» | ✅ **Сделано в hotfix 1.16.6** — переведено на nomenclatureList |
| `AssemblyReturnDialog.tsx` | nomenclatureList | Уже nomenclature, проверить фильтр itemType |
| `EngineDismantlePreviewDialog.tsx` | nomenclatureList | Уже nomenclature, проверить |
| `ContractDetailsPage.tsx` | parts.list для привязки изделий контракта | Перевести на nomenclatureList с фильтром itemType=engine/part/assembly |
| `NomenclatureDetailsPage.tsx` | parts.get для подгрузки spec детали (зеркало) | После C.1 переписать на partsGetSpec(nomenclatureId). Здесь же подключить подпанель «Спецификация детали» (Этап E) |
| `NomenclaturePage.tsx` | parts list для сопоставления зеркал | Убрать после удаления зеркала; читать `directory_kind` напрямую из nomenclature |
| `SupplyRequestDetailsPage.tsx` | parts.list для строк заявки | Перевести на nomenclatureList (HAS_STOCK) |
| `EngineAssemblyBomDetailsPage.tsx` | parts.list для компонентов BOM | Перевести на nomenclatureList с фильтром по itemType (Part, Assembly, Component, SemiProduct) |
| `PartDetailsPage.tsx` | редактор карточки детали | После Этапа E удалить или редиректить в карточку номенклатуры |
| `PartTemplateDetailsPage.tsx` | редактор шаблона детали | Сохранить как-есть (шаблоны деталей не мигрируем в nomenclature) |
| `partsPagination.ts` | listAllParts helper | Заменить вызовы на `listAllNomenclature` helper по-аналогии, или удалить если использований не осталось |
| `NomenclatureDirectoryPage.tsx` | parts.list для подгрузки имён | Заменить на прямое чтение из nomenclature |
| `createWarehouseNomenclatureFromDirectory.ts` | parts.create + nomenclatureCreate | Упростить: только nomenclatureCreate с directory_kind + директорной записью |
| `useWarehouseReferenceData.ts` | parts.list | Заменить на nomenclatureList |
| `NomenclaturePropertyEditModal.tsx` | nomenclatureList | Уже nomenclature, проверить |
| `NomenclatureTemplateCompositionEditor.tsx` | nomenclatureList | Уже nomenclature, проверить |
| `RepairChecklistPanel.tsx` | parts.create для inline-создания | Заменить на nomenclatureCreate + partsCreateSpec (если itemType=part) |
| `EngineBrandDetailsPage.tsx` | parts.list для подсчёта деталей марки + partBrandLinks | Переписать на nomenclatureList(itemType=part) + brand_links через directory_parts |
| `EngineBrandsPage.tsx` | parts.list для подсчёта brandLinks | Аналогично EngineBrandDetailsPage |
| `AdminPage.tsx` | parts CRUD admin | Сохранить как admin-fallback или удалить если nomenclature CRUD достаточен |

**D.1.** Реализовать `listAllNomenclature(filter)` хелпер (по аналогии с `listAllParts`) с кешем и фильтрацией по itemType.

**D.2.** Для каждой строки таблицы выше — отдельный коммит с осмысленным сообщением.

### Этап E — Карточка номенклатуры: подпанель «Спецификация детали»

**E.1.** В `NomenclatureDetailsPage.tsx` добавить секцию `<PartSpecificationSection>`, которая показывается только при `itemType === 'part'`:
- Поля: размеры (массив), привязки к маркам двигателей (M:N), template_id, прочие part-only атрибуты.
- Read через `partsGetSpec(nomenclatureId)`, save через `partsUpdateSpec(nomenclatureId, ...)`.
- Создание новой части идёт через карточку номенклатуры с itemType=part: при первом save если нет directory_parts row — backend создаёт.

**E.2.** Старая `PartDetailsPage` → редирект на `NomenclatureDetailsPage` с тем же UUID (поскольку id совпадают через зеркало → новая модель через directory_ref_id).

### Этап F — Удаление зеркальной модели

**F.1.** Снять mirror-creation в backend (в `warehouseService.ts` при чтении nomenclature list и в IPC после CRUD детали). Зеркало больше не нужно: detail-данные читаются напрямую из `directory_parts` через `directory_ref_id`.

**F.2.** Удалить ENV-переменную `MATRICA_WAREHOUSE_PART_MIRROR_MODE` и обе ветки (`legacy`/`directory`) — теперь только directory-first.

**F.3.** Пометить `/parts/*` API как deprecated (HTTP 410 + сообщение «use /warehouse/nomenclature и /warehouse/nomenclature/:id/part-spec»). Удаление endpoints — отдельный релиз через 1-2 цикла после 1.17.0.

### Этап G — Тесты + сборка + acceptance

**G.1.** Существующие unit-тесты в `shared/`, `backend-api/` должны продолжать проходить. Добавить тесты:
- `backfillDirectoryParts.test.ts` — идемпотентность, перенос всех атрибутов.
- `nomenclaturePartSpec.test.ts` — backend roundtrip через новые endpoints.

**G.2.** `pnpm build` для всех пакетов, `pnpm lint` для своих файлов.

**G.3.** Финальный dry-run на проде: `canApply: TRUE`, никаких orphans.

**G.4.** UI smoke-test:
- В Справочнике деталей видно 159 позиций (после миграции — все они = nomenclature.itemType=part).
- В Складе → Номенклатура видно 633 позиции, при открытии part-позиции — подпанель «Спецификация детали» с размерами и привязками.
- В наряде «Наименование изделия» работает поиск по всем 633 позициям с разделением по типу.
- Создание новой детали из карточки номенклатуры → сразу видна в Справочнике деталей.
- Тест BOM, заявок в снабжение, контрактов — не сломаны.

### Этап H — Документация + release 1.17.0

**H.1.** Обновить `docs/WAREHOUSE.md`:
- зафиксировать инвариант «erp_nomenclature — единственный источник истины для изделий в UI»;
- описать схему `directory_parts`, связь через `directory_ref_id`;
- описать API `/warehouse/nomenclature/:id/part-spec`;
- удалить или пометить как устаревшее всё про зеркало и `MATRICA_WAREHOUSE_PART_MIRROR_MODE`.

**H.2.** Обновить `docs/PROJECT_STATE.md`:
- добавить пункт «Завершена Phase-2 миграции part→nomenclature; единый источник истины для изделий»;
- удалить пункт про phase-1 (стал устаревшим) или перенести в «Устаревшие решения».

**H.3.** Обновить этот файл (`MIGRATION_PARTS_TO_NOMENCLATURE.md`):
- проставить «✅ DONE» по каждому этапу;
- заполнить «Orphan resolution log»;
- зафиксировать deferred-задачи (если что-то отложено в 1.18.0).

**H.4.** Bump version 1.17.0 (минор — breaking architectural change, новый редактор спецификации, удалено зеркало). Welcome-текст в `releaseWelcome.ts` суммирует 1.16.4/1.16.5/1.16.6 + ключевые изменения 1.17.0.

**H.5.** Commit, tag, push, VPS sync, deploy (полный — shared+backend+web-admin), ledger publish. Клиентский релиз обязателен (UI breaking).

## Acceptance Criteria

После Phase-2 одновременно должны выполняться:

- [ ] Все 159 part представлены в `erp_nomenclature` как itemType=part + `directory_kind=part` + `directory_ref_id` → строка в `directory_parts`.
- [ ] `dryRunDirectoriesToNomenclature` возвращает `canApply: TRUE`, нет orphans.
- [ ] Любая позиция, забитая в номенклатуру (любой itemType), видна в UI наряда как «Наименование изделия» (с фильтром HAS_STOCK).
- [ ] Карточка номенклатуры при itemType=part показывает подпанель «Спецификация детали» с возможностью редактирования.
- [ ] Все 20 UI-мест выбора изделия читают из `nomenclatureList` (или production-эквивалента), не из `partsList`.
- [ ] Удалены mirror-creation в backend, ENV `MATRICA_WAREHOUSE_PART_MIRROR_MODE` снят.
- [ ] `pnpm build` + `pnpm test` + `pnpm lint` чисты для shared, backend-api, electron-app.
- [ ] Релиз 1.17.0 опубликован в ledger, оба VPS-бэкенда на 1.17.0, клиентский installer доступен.

## Risk Register

| Риск | Mitigation |
|---|---|
| Backfill ломает существующие зеркала | Идемпотентные upserts, перед apply — полная резервная копия БД (`pg_dump` на VPS перед запуском `--apply`). |
| Orphan FK невозможно «починить» (данные потеряны) | Восстанавливаем плейсхолдер в `erp_nomenclature` с пометкой `notes='orphan recovered 2026-XX-XX'`, баланс сохраняется. |
| Старый клиент 1.16.x шлёт partId как nomenclatureId после Phase-2 | Backend продолжает принимать (id совпадает через зеркало → directory_ref_id). После полного отключения зеркала — добавить миграционный lookup на стороне backend. |
| UI-перевод 20 файлов вносит регрессии в BOM/заявках | Smoke-test каждого экрана после миграции (этап G.4); если что-то сломано — патч-релиз. |
| Удаление `/parts` API ломает legacy-интеграции (например, отчёты или внешние скрипты) | НЕ удаляем в 1.17.0, только deprecate с 410 + сообщением. Удаление — через 1-2 релиза. |

## Rollback Plan

Если миграция пошла не так на проде после `--apply` backfill:

1. Бэкенд продолжает работать (зеркало не удалено в этой фазе, оно ортогонально directory_*).
2. Откатить `directory_parts` rows: `UPDATE directory_parts SET deleted_at = now() WHERE created_at > '<apply_timestamp>'`.
3. Откатить `directory_engine_brands` rows аналогично.
4. Восстановить БД из `pg_dump` (если откат через soft-delete не достаточен).
5. Снять `MATRICA_WAREHOUSE_PART_MIRROR_MODE` на `legacy` чтобы вернуться к старой mirror-логике (можно не делать, поскольку directory не активирован).

Frontend (если UI-релиз 1.17.0 ломает что-то критичное): сделать патч-релиз 1.17.1 с откатом конкретного UI на старый источник. Backend данные не повреждены — UI можно откатывать независимо.

## Orphan Resolution Log

Заполняется в Этапе A.2 при запуске `--inspect-orphans` на проде. Шаблон записи:

```
### orphan-id <uuid>
- Type: stock_balance | stock_movement
- nomenclature_id (broken): <uuid>
- warehouse_id: <uuid>
- qty: <number>
- performed_at: <timestamp>
- source_doc_id: <uuid or null>
- Decision: восстановить плейсхолдер | soft-delete | перепривязать к <nomenclature_id>
- Reason: <free text>
- Applied at: <timestamp>
```

(Пусто — будет заполнено в Phase-2 сессии.)

## Связанные документы

- [`WAREHOUSE.md`](WAREHOUSE.md) — текущее устройство складского модуля, секция «Directories -> Nomenclature (phase-1)».
- [`WAREHOUSE_3LEVEL_AUDIT.md`](WAREHOUSE_3LEVEL_AUDIT.md) — pre-migration snapshot 3-уровневой структуры.
- [`PROJECT_STATE.md`](PROJECT_STATE.md) — текущая оперативная память проекта.
- Скрипт dry-run: `backend-api/src/scripts/dryRunDirectoriesToNomenclature.ts`.
- Скрипт backfill governance (часть phase-1): `backend-api/src/scripts/backfillNomenclatureGovernance.ts`.
