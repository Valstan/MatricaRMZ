# Phase 2: parts → nomenclature, Variant A (расширить directory_parts)

Исполнительный план финального слияния legacy-деталей в единый источник истины и **удаления зеркала** parts↔nomenclature. Заменяет устаревшую часть [`MIGRATION_PARTS_TO_NOMENCLATURE.md`](../MIGRATION_PARTS_TO_NOMENCLATURE.md) (там — мотивация, аудит, re-audit 2026-05-31). Выбран **Вариант А** (решение пользователя 2026-05-31): part-spec хранится в расширенной `directory_parts`.

## Принципы
- Каждый Stage — **отдельный релиз** + `/verify`. Не смешивать.
- Зеркало удаляется **последним** (Stage F), только когда UI читает из nomenclature/directory_parts.
- Деструктивные прод-шаги (`--apply`, удаление зеркала) — после `pg_dump` бэкапа и явного OK.
- Критичный риск регрессии — `RepairChecklistPanel.tsx` (дефектовка/ремонт, путь оператора).

## Факты (re-audit 2026-05-31, прод)
- `directory_parts` была тонкой; `mirrorRows=155`, все `item_type='product'`; `entities.type=part`=160.
- FK-orphans очищены → `canApply: TRUE`.
- dev-DB (restore прода) dry-run: 38 марок, 161 деталь (159 insert / 2 update), 57 с brand-links, 161 с template, 1 с dimensions.

## Stages

### Stage B — фундамент данных (DDL + backfill) ✅ (включая prod-apply B.3, 2026-06-01)
- ✅ **B.1 DDL** — миграция `0059_directory_parts_spec_columns.sql`: `directory_parts` + `code`, `template_id`, `dimensions_json`, `brand_links_json` (additive/NULL) + индекс по `code`. Drizzle schema обновлена. *(Журнал ведётся вручную — snapshot-ов в `meta/` нет, `drizzle-kit generate` в этом репо нерабочий.)*
- ✅ **B.2 backfill-скрипты** (dry-run по умолчанию, idempotent upsert by id):
  - `warehouse:backfill-directory-engine-brands` — `entities.type=engine_brand` → `directory_engine_brands`.
  - `warehouse:backfill-directory-parts` — `entities.type=part` → `directory_parts` (code←article, template_id←part_template_id, dimensions_json←dimensions, brand_links_json← entities.type=part_engine_brand).
  - Валидированы dry-run на dev-DB (прод-restore) — SQL исполняется, отчёты корректны.
- ✅ **B.3 prod-apply** (выполнено 2026-06-01): `0059` накатан точечно (`db:migrate`, source pull'нут до main `8642d28e`, dist остался v1.34.3 — колонки additive, старому коду невидимы). Бэкап `~/backup-stagec-directories-2026-06-01.sql` (+ `~/data-key.json.bak-stagec-2026-06-01`). `--apply` обоих скриптов. **Итог:** `directory_parts` 1→**160** (159 insert / 1 update, 56 с brand-links, 15 с code, 160 с template), `directory_engine_brands` 0→**37**. Финальный `directories-dry-run`: fkOrphans=0, коллизий=0, **`canApply: true`**. Health прода `1.34.3 ok`.

### Stage C — backend endpoint part-spec ✅ (код готов, едет следующим релизом)
- ✅ `GET/PUT /warehouse/nomenclature/:id/part-spec` (`warehouseService.getWarehouseNomenclaturePartSpec` / `upsertWarehouseNomenclaturePartSpec`). Пишет spec-колонки `directory_parts` (code/template_id/dimensions_json/brand_links_json) через `onConflictDoUpdate`; name резолвится (существующая строка → nomenclature) чтобы insert не упал на NOT NULL.
- ⚠️ **Без ledger-signing намеренно**: `directory_parts` — серверная таблица (нет локальной схемы в Electron-клиенте, нигде не подписывается; пишет только backfill напрямую). Part-spec читается живьём через API, не через client-sync. Если позже понадобится sync в клиент — добавить signing + локальную SQLite-схему.
- ✅ IPC `warehouse:nomenclature:partSpec:get|update` (preload `nomenclaturePartSpecGet`/`nomenclaturePartSpecUpdate`). Старые `parts.*` IPC остаются для backward-compat.
- ✅ Shared-тип `PartSpec` / `PartSpecBrandLink` (`shared/src/domain/part.ts`).
- ✅ Roundtrip-тест `backend-api/src/tests/warehouse.partSpec.roundtrip.test.ts` (5 кейсов, мок-БД).
- **Релиз Stage C занесёт миграцию `0059` на прод** штатным `db:migrate` → снимает открытый вопрос «накатывать 0059 точечно». После него можно делать B.3 prod-backfill на готовой схеме.

### Stage D — переключение UI на nomenclatureList ⬜ (per-file, по 1 коммиту, каждый /verify)
8 точек категории A (см. MIGRATION doc): `ContractDetailsPage`, `EngineBrandDetailsPage` (×2), `EngineBrandsPage`, `NomenclatureDirectoryPage`, `RepairChecklistPanel` (×3 — **критичный, тестировать тщательно**). Хелпер `listAllNomenclature({itemType})`.

**⚠️ Находка 2026-06-01 (разведка перед Stage D): своп НЕ механический.** Потребители читают с legacy part-строки инлайн-поля, которых нет в `nomenclatureList`:
- `article` → у номенклатуры `code`;
- `brandLinks[]` (engineBrandId/quantity/assemblyUnitNumber) — у parts инлайн в строке; у номенклатуры отдельная таблица `erp_nomenclature_engine_brand` (≠ та же структура);
- `templateName`, `dimensions` — у номенклатуры в base-строке отсутствуют.

`EngineBrandsPage`/`NomenclatureDirectoryPage` агрегируют детали по `brandLinks[].engineBrandId`; `RepairChecklistPanel` (×3) читает `brandLinks` для partNumber/quantity. Эти поля — ровно те, что Stage C сложил в `directory_parts` (`code`/`brand_links_json`/`dimensions_json`/`template_id`).

**⚠️ Находка 2 (prod-данные 2026-06-01, после B.3):** идентификация part-класса в `erp_nomenclature` НЕ по `directory_kind='part'` (на проде таких строк **0**; код зеркала `syncPartsToWarehouseNomenclature` это задаёт, но старые строки его не получили). Факты прода: 157/160 `directory_parts.id` совпадают с `erp_nomenclature.id` (связка Variant A по `id` держится), эти строки `directory_kind=NULL`, `item_type='product'`; 3 `directory_parts` без nomenclature-строки (orphans). **Надёжный источник part-класса — сам `directory_parts`** (теперь содержит name/code/brandLinks/dimensions/templateId), его `id` = nomenclature id → downstream-ссылки валидны. Backend-list Stage D сделан поверх `directory_parts`, а не по `directory_kind`.

**Решение (принято 2026-06-01):** `listAllNomenclature({itemType})` должен **гидрировать part-spec из `directory_parts`** (LEFT JOIN spec-колонок на nomenclature part-class строки, `brand_links_json` распарсить в `brandLinks[]`), чтобы потребители продолжали читать те же поля (`article`←`code`, `brandLinks`, `dimensions`). Реализуется backend-list-endpoint'ом, переиспользующим Stage C-хранилище. Это **предусловие** Stage D — без гидрации свопы сломают brand-агрегации и чеклист. Делать backend-list + helper до UI-свопов; UI-точки потом per-file с `/verify` (RepairChecklistPanel — последним и тщательно).

**⚠️ Находка 3 (2026-06-01, перед свопом пункта 2): `directory_parts` spec-колонки не живут под legacy-записью.** `brand_links_json`/`code`/`dimensions_json`/`template_id` заполняются только backfill'ом + Stage C endpoint'ом. Legacy-мутации их НЕ трогают: `parts.create` пишет лишь `(id,name)` (`onConflictDoNothing`); `upsertPartBrandLink`/`deletePartBrandLink` пишут только EAV. Значит любой Stage D-потребитель brandLinks показывает данные «с последнего backfill» — а `EngineBrandDetailsPage.loadBrandParts` (108) редактирует brand-links на той же странице и перечитывает их на reload → регрессия данных.

**Решение (принято пользователем 2026-06-01): dual-write bridge.** `mirrorPartBrandLinksToDirectory(partId)` в `partsService` после upsert/delete brand-link пересобирает `directory_parts.brand_links_json` из текущих EAV-линков (best-effort: ошибка зеркала логируется, не валит legacy-правку; строка ожидаемо существует — `createPart` её сеет). Теперь directory_parts актуален под правками brand-links → свопы пунктов 1/2/3 корректны на reload. Проверено live (`/verify`): legacy upsert qty=7 → сразу виден в `nomenclaturePartSpecsList`; delete → исчез.

**Stage D пункт 1 ✅ (PR #154):** `EngineBrandsPage`/`NomenclatureDirectoryPage` счётчики деталей ← `nomenclaturePartSpecsList`. diffCount=0 vs legacy, UI 37 марок.

**Stage D пункт 2 ✅ (PR #156):** `ContractDetailsPage:824` + `EngineBrandDetailsPage:90,108` ← новый хелпер `listAllPartSpecs()` (поверх `nomenclaturePartSpecsList`, маппит `article←code`, резолвит `templateName` клиентом через `parts.templates.list`, отдаёт legacy-форму). Инвалидации кэша перенацелены на `invalidateListAllPartSpecsCache`. `listAllParts` НЕ тронут.

**Stage D пункт 3 ✅ (PR — этот):** `RepairChecklistPanel.tsx` (3 стадии 520/566/603 + rebuild 747) ← `listAllPartSpecs`; инвалидации (639/666/679) → `invalidateListAllPartSpecsCache`. Потребление полностью drop-in (всё через `getBrandLinkForPart`, читающий `brandLinks[].{engineBrandId,assemblyUnitNumber,quantity}` + `p.name/article/id`). Проверено live: реконструкция brand-rows (`{partNumber←assemblyUnitNumber, quantity}`) из нового источника **идентична** legacy для марки с 36 деталями (`diffCount=0`). **Все 8 точек категории A Stage D закрыты.**

**Остатки после пункта 2 (follow-up, НЕ блокеры):**
- **Dual-write code/template_id/dimensions** не сделан (только brandLinks). Эти поля правятся через общий EAV-attribute-путь (нет чистого chokepoint) и лагают лишь в подсказке дропдауна (label — по name). Добить при Stage E (write-миграция) или когда тронем part-attribute write-path.
- **`EngineBrandDetailsPage:62` `listPartsByBrand` (summaryDeps)** — 3-е использование `parts.list` (для persistBrandSummary), не входило в список пункта 2. Dual-write делает его консистентным; своп — отдельно/при Stage F.

**Полный blast-radius parts.list** (помимо 8 точек кат. A — для справки, НЕ Stage D): `AdminPage` (×3), `PartDetailsPage`, `PartTemplateDetailsPage`, `partsPagination.ts` (`listAllParts`). Эти управляют самими parts — трогать после Stage F или отдельно.

### Stage E — карточка номенклатуры: подпанель «Спецификация детали»

**Разнесено на 2 релиза (решение пользователя 2026-06-01):** редирект E.2 убрал бы у оператора доступ к полям, которых нет в карточке номенклатуры (описание, «где используется», вложения, поставщик/дата/статусы). Пользователь подтвердил, что все они нужны → редирект = полное слияние карточек (большая работа). Поэтому E.1 (аддитивная подпанель, ничего не теряет) едет первым, E.2 (слияние + редирект) — отдельным релизом.

**Stage E.1 ✅ (этот PR):** inline-подпанель «Спецификация детали» в `NomenclatureDetailsPage`, видимая при part-class (`partSpec !== null || itemType==='part'`). Редактирует **размеры / шаблон детали (part_template) / применяемость по маркам**; read/write через Stage C endpoint (`nomenclaturePartSpecGet`/`Update`, `directory_parts` = источник истины). Запись свёрнута в существующую кнопку «Сохранить» (последовательно: nomenclatureUpsert → partSpecUpdate; ошибка спецификации не теряется). `code` round-trip без изменений (его владелец — поле «Код» карточки = `erp_nomenclature.code`). Маппинг payload вынесен в чистый `utils/partSpecPayload.ts` (+ vitest). В `MatricaApi` (`shared/src/ipc/types.ts`) добавлены `nomenclaturePartSpecGet`/`Update` (Stage C добавил в preload, но в тип — только `…List`). **Редирект НЕ делается** — `PartDetailsPage` остаётся.

**Stage E.2 ⬜ (следующий релиз, отдельный план — [`parts-nomenclature-stage-e2.md`](parts-nomenclature-stage-e2.md)):** перенос оставшихся полей `PartDetailsPage` в карточку номенклатуры (описание, «где используется», вложения, поставщик/дата/статусы, произвольные EAV-поля) + редирект `openPart → openNomenclature` + удаление/деприкейт `PartDetailsPage`. Снимет транзитный риск расхождения двух редакторов (см. ниже). **Подход — извлечь переиспользуемые секции (не copy-paste); бэкенд без изменений (`directory_parts.id == nomenclature id`); 3 orphan'а — backfill pre-release.**

**Транзитный риск E.1→E.2:** подпанель пишет в `directory_parts`, legacy `PartDetailsPage` — в EAV (brandLinks зеркалятся в directory bridge'ем `mirrorPartBrandLinksToDirectory`, размеры/шаблон — нет; обратного зеркала directory→EAV нет). Правка спецификации в одной карточке не видна в другой и в EAV-читателях (AdminPage, PartTemplateDetailsPage). **Операторски-критичный путь (чеклист/дефектовка, бренд-счётчики) уже читает `directory_parts` (Stage D) — консистентен с подпанелью.** Рекомендация в release notes: спецификацию редактировать в карточке номенклатуры; полная сходимость — на E.2.

### Stage F — удаление зеркала ✅ (2026-06-02, последним)
- ✅ Сняты `syncPartsToWarehouseNomenclature` / `refreshPartWarehouseNomenclatureLinks`, ENV `MATRICA_WAREHOUSE_PART_MIRROR_MODE`, `isLegacyPartMirrorMode` + 3 гейт-ветки (`listWarehouseReferenceData`/`upsertWarehouseNomenclature`/`deleteWarehouseNomenclature`) + ставшие мёртвыми `nomenclatureRowIsLinkedPart`, параметры `_syncFromPart`/`allowLinkedPartMirror`. 3 call-site в `partsService.ts` удалены. На проде зеркало уже было off (`directory`-режим) → поведение не изменилось.
- ✅ Снят недостижимый standalone-маршрут детали в `App.tsx` (`tab==='part'` render/empty-state, `selectedPartId` state + breadcrumb/title/aiContext/appLink-ссылки, мёртвый импорт `PartDetailsPage`). `openPart`/`openByCode.part`/deep-link `route.kind==='part'` и структурная принадлежность `'part'` к `TabId` (нужна для narrowing в tab-gate) — оставлены.
- ⏸️ **`/parts/* → 410` ОТЛОЖЕНО:** embedded `PartDetailsPage` (Stage E.2) вызывает почти все `/parts/*` (get/create/delete/attributes/brand-links/attribute-defs). 410 сломал бы карточку. `/parts/*` остаются как EAV-CRUD; депрекацию пересмотреть отдельной ниткой, когда EAV-поля детали переедут из `parts`.
- ✅ Обновлены `WAREHOUSE.md` / `PROJECT_STATE.md`: «erp_nomenclature + directory_parts — единственный источник истины, зеркало удалено».
- Follow-up (не Stage F): `EngineBrandDetailsPage:62` `listPartsByBrand` — последний `parts.list` в brand-read-пути, отдельным PR.

## Acceptance (как в MIGRATION doc §Acceptance Criteria) + directory_parts заполнена для всех active part.
