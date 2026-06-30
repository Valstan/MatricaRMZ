# Phase 3 — parts EAV → directory_parts (полная депрекация `/parts/*`)

> Master-план многорелизной нитки. Дисциплина стадий B→H как в Phase 2 ([`parts-nomenclature-phase2-variant-a.md`](parts-nomenclature-phase2-variant-a.md)). Статус стадий и текущий шаг — в `SESSION_HANDOFF.md` / `PENDING_FOLLOWUPS.md`. Утверждён 2026-06-03.

## Context

Phase 2 (Variant A) свела «деталь» к строке номенклатуры: `erp_nomenclature` + spec-колонки `directory_parts` (`directory_parts.id == nomenclature.id`) — источник истины для **спеков** детали. Но остаточные EAV-поля детали (описание, поставщик, узел, даты, файлы, статус-флаги, произвольные кастом-атрибуты) **до сих пор живут в legacy-сторе `parts`** (`entities` + `attribute_values`), и почти все `/parts/*` эндпойнты живы: их дёргает embedded `PartDetailsPage` (карточка детали внутри карточки номенклатуры) и независимые страницы (Admin, EngineBrand, Templates, Supply, Contract, Stock, RepairChecklist). Поэтому массовый «`/parts/* → 410`» был намеренно отложен в Stage F (см. `PROJECT_STATE.md:46`, `WAREHOUSE.md:126`).

**Цель Phase 3:** перенести ВСЕ остаточные данные детали из `parts` EAV в `directory_parts` (typed-колонки + `metadataJson`-блоб), перевести каждый живой `window.matrica.parts.*`-вызов на directory/nomenclature-эндпойнты, затем депрецировать parts-data маршруты `/parts/*` в HTTP 410 (стандарт проекта — `backend-api/src/routes/sync.ts:5-11`). Конечное состояние: `directory_parts` + `erp_nomenclature` — единственный источник истины; `/parts/*` (кроме `/parts/templates/*`, см. Решение C) — 410.

**Ключевые факты, де-рискующие миграцию (проверено 2026-06-03):**
- `directory_parts` уже имеет все нужные колонки: `code, templateId, dimensionsJson, brandLinksJson, deprecatedAt, metadataJson` (`backend-api/src/database/schema.ts`, `directoryParts`). **`metadataJson` сейчас всегда пишется `null`** (`warehouseService.ts:1564`) — это естественный дом для остаточных EAV-полей.
- Part-spec эндпойнты уже есть (Stage C Phase 2): `getWarehouseNomenclaturePartSpec` / `upsertWarehouseNomenclaturePartSpec` / `listWarehouseNomenclaturePartSpecs` (`warehouseService.ts:1857-1958`), читают/пишут `code/templateId/dimensions/brandLinks`. Клиентский хелпер `listAllPartSpecs` (`electron-app/.../utils/partsPagination.ts`) уже их потребляет.
- Клиент ходит в `/parts/*` по HTTP (`electron-app/src/main/services/partsService.ts` → `httpAuthed`), НЕ из локального SQLite — детали уже online-only. Значит server-only `directory_*` (raw SQL допустим) ничего не ломает в offline-чтении.
- Не-card create-вызовы передают только `{name}`/`{name, code}` (проверено: ContractDetailsPage, EngineBrand, Stock, RepairChecklist, createWarehouseNomenclatureFromDirectory) → чистый своп на directory-create.
- Реально мёртвы (0 вызовов, 410 сразу): `POST /parts/templates/:id/create-part` (`createFromTemplate`), `GET /parts/:id/files` (`getFiles`).

## Решения по открытым вопросам (приняты)

- **A. Файлы (drawings/tech_docs/attachments):** хранить `FileRef[]` в `metadataJson` без смены формы. Файлы и так лежат в `/files`; деталь держит только ссылки. UI-аплоад/превью — near drop-in.
- **B. Кастом-атрибуты (`createAttributeDef`):** сохранить расширяемость, но перенести в `metadataJson.custom` (code→value) + `metadataJson.customDefs` (code/name/dataType/sortOrder для рендера). Семантика меняется на **per-part** (было global на тип). Backfill-dry-run посчитает, есть ли в проде global-использование; новые **общие** поля направлять в свойства шаблона номенклатуры (`nomenclaturePropertyUpsert`). `POST /parts/attribute-defs` удаляется.
- **C. Part-шаблоны (`/parts/templates/*`):** **вне scope Phase 3.** Это самодостаточный EAV-подсистем (`part_template`), на который указывает `directory_parts.templateId`. Stage H 410-ит только parts-data маршруты; `/parts/templates/*` остаётся живым (named follow-on «Phase 3.5»). Чтобы dropdown шаблонов был самодостаточным, list-эндпойнт отдаёт `templateName` server-side.

## Field → target-store таксономия

Target: **DP-col** (typed-колонка `directory_parts`, уже есть) · **DP-meta** (`metadataJson`-блоб) · **NOM** (`erp_nomenclature`).

| EAV-поле | Сейчас | Phase-3 дом |
|---|---|---|
| name | DP-col (mirror) | NOM (владелец) + DP-col `name` (денорм-копия, NOT NULL, используется в сортировке) |
| article | DP-col `code` | DP-col `code` |
| part_template_id | DP-col `templateId` | DP-col `templateId` |
| dimensions | DP-col `dimensionsJson` | DP-col `dimensionsJson` |
| brand-links (engine_brand_ids/qty/assembly) | EAV `part_engine_brand` → mirror `brandLinksJson` | DP-col `brandLinksJson` |
| description | EAV | DP-meta `description` |
| assembly_unit_number (part-level) | EAV | DP-meta `assemblyUnitNumber` |
| engine_node_id | EAV | DP-meta `engineNodeId` |
| purchase_date | EAV | DP-meta `purchaseDate` (ISO) |
| supplier_id / supplier(legacy) | EAV | DP-meta `supplierId` / `supplierLegacy` |
| contract_id (историч. прямой) | EAV | DP-meta `contractId` (читается `loadUsage`, `PartDetailsPage.tsx:784`) |
| drawings / tech_docs / attachments | EAV JSON | DP-meta `drawings[]/techDocs[]/attachments[]` (FileRef[]) |
| status-флаги (`STATUS_CODES`) | EAV bool | DP-meta `statusFlags: Partial<Record<StatusCode,boolean>>` |
| кастом-атрибуты | EAV defs+values | DP-meta `custom` + `customDefs[]` |

Новый shared-тип `PartMetadata` рядом с `PartSpec` (`shared/src/domain/part.ts`); все поля — conditional spread (`exactOptionalPropertyTypes: true`).

## Write-path consolidation

Сегодня сохранение embedded-карточки = 3 раздельных записи (`NomenclatureDetailsPage.tsx:463-525`): `nomenclatureUpsert` (база) → `nomenclaturePartSpecUpdate` (spec-колонки) → `embeddedPartSaverRef` (per-field `parts.updateAttribute`). Цель = **2 записи, обе directory-backed**: расширить `upsertWarehouseNomenclaturePartSpec` принимать `{ spec, metadata }` и писать `code/templateId/dimensions/brandLinks/metadataJson` одним `onConflictDoUpdate` (existing upsert уже делает 4 из 5 колонок, `warehouseService.ts:1907-1924`). Read: `get`/`list` отдают `metadata` (новый `rowToPartMetadata` рядом с `rowToPartSpec`).

## Стадии (каждая = отдельный релиз, обратимая)

Правило auto-update: backend терпит **старых И новых клиентов** до финального 410. B–D — чисто backend. E–G — клиентские релизы; между ними dual-write (Stage C) держит консистентность. H — последний.

- **Stage B — фундамент metadata (без DDL) + backfill · backend-only.** `metadataJson` уже есть → DDL не нужен. Shared `PartMetadata` + `rowToPartMetadata`. `upsertWarehouseNomenclaturePartSpec` принимает optional `metadata` (пишет только когда передан — не нуллит у старых клиентов). `get/list` возвращают `metadata`. Roundtrip-тест (как `warehouse.partSpec.roundtrip.test.ts`). Backfill `warehouse:backfill-directory-parts-metadata` (по образцу `backfillDirectoryParts.ts`: raw SQL, dry-run default, `--apply`, idempotent; dry-run считает `withDescription/withAttachments/withCustom`, в т.ч. global-custom-defs). Обратимость: чисто аддитивно.
- **Stage C — dual-write мост всех полей · backend-only.** `updatePartAttribute`/`createPart`/`createPartAttributeDef` после EAV-записи зеркалят в `directory_parts` (cols+metadata) через `mirrorPartFieldsToDirectory(partId)` (best-effort, логируется, не бросает — контракт как у `mirrorPartBrandLinksToDirectory`, `partsService.ts:1938`). Закрывает Stage-D follow-up #1. Обратимость: убрать вызовы.
- **Stage D — directory-first create/get/list эндпойнты · backend-only.** `createDirectoryPart({name, code?})` (insert в `directory_parts`, dup-детект по name/code; сохранить контракт ошибки `duplicate part exists: <uuid>` — его парсит `createWarehouseNomenclatureFromDirectory.ts:157`; вернуть `{ part: { id } }`). Расширить `getWarehouseNomenclaturePartSpec` отдавать `name/isActive/metadata` (покрывает `parts.get`). `listAllPartSpecs` + server-side `templateName` (покрывает `parts.list` + dropdown). IPC/preload/`MatricaApi` под новые методы (в namespace `nomenclaturePartSpec*`). Обратимость: чистое добавление.
- **Stage E — своп записей embedded-карточки · client release.** `NomenclatureDetailsPage.tsx:498-520` + `PartDetailsPage.tsx` (`saveCore:1579`, `saveAttributeCore:1505/1513`, brand-link-очередь `:1271/1281`, «добавить поле» `:1364`, load `:748`) → пишут через unified endpoint + metadata + part-spec brandLinks; убраны `parts.updateAttribute/createAttributeDef/partBrandLinks.*` из карточки. Dropdown шаблонов пока на `parts.templates.list` (Решение C). Verify: полный `/verify` (verifier-electron CDP) — правка description/supplier/status/dimensions/template/brand-links/custom → save → reload → persisted; RepairChecklist + brand-счётчики не задеты. Обратимость: revert клиента; dual-write держит консистентность.
- **Stage F — своп `parts.create/get` чисто-свопаемых вызовов · client release.** *(Re-scoped 2026-06-04 после разведки — см. ниже «Re-scope Stage F/G».)* Только сайты, не сцепленные с EAV-`entities` и без поведенческого риска. **create → `nomenclatureDirectoryPartCreate({name, code?})`:** `createWarehouseNomenclatureFromDirectory.ts:146` (эталон: парно зовёт `nomenclatureUpsert(directoryRefId)` — orphan-safe; дубль-контракт `duplicate part exists:<uuid>` сохраняется), `ContractDetailsPage.tsx:948` (после — `loadParts`→`listAllPartSpecs`, directory_parts surfaces), `StockDocumentDetailsPage.tsx:622` (поведение-сохраняющий: `refreshRefs`-fallback неизменен; orphan-склонность **pre-existing**, не регресс), `RepairChecklistPanel.tsx:637/664/677` (локальная опция). **get → directory:** `SupplyRequestDetailsPage.tsx:418` (`loadLinkLists` — name+unit через `nomenclatureList({id})`, т.к. part id == nomenclature id), `:505` (`enrichUnitIfMissing`, `refKind='part'` → свернуть в соседнюю ветку `refKind='nomenclature'`). **Мёртвый код (non-embedded `PartDetailsPage`, недостижим — `App.tsx:1875` `openPart→openNomenclature`, карточка только embedded):** get `:813`, create `:1124/2249` (`copyToNew`), delete `:1784` (`handleDelete`) — убрать/конвертировать, чтобы grep-гейт Stage H был чист. **`deleteDirectoryPart` строить НЕ нужно** — 0 живых `parts.delete`. Verify: `/verify` create-входы (Contract/Stock/RepairChecklist/directory-preset) + SupplyRequest lookup.
- **Stage G — своп `parts.list` + brand-link-редакторов + EAV-сцепленного create · client release.** *(Re-scoped 2026-06-04.)* list → `listAllPartSpecs`: `AdminPage.tsx:731/754`, `PartTemplateDetailsPage.tsx:48` (нужен `templateId`-фильтр — есть в Stage D). brandLinks → part-spec brandLinks: `AdminPage.tsx:779/787/800/807`, `EngineBrandDetailsPage.tsx:234/272/278/304`. **create, сцепленный с brand-links:** `EngineBrandDetailsPage.tsx:333` (`createAndAddPart`) — отложен из Stage F: legacy `parts.create` создаёт `entities`+`directory_parts`+EAV, а `createDirectoryPart` — только `directory_parts`; затем id используется через `parts.partBrandLinks` (EAV, нужна `entities`-строка). Свопнуть вместе с brand-link-редакторами на part-spec brandLinks, тогда EAV-`entities` не нужна. **Пред-условие forecast-репойнт — СНЯТО (2026-06-04, ложная тревога; см. ниже «Re-scope Stage G»).** Verify: `/verify` Admin part-options + brand-CRUD, EngineBrand-карточка (create+add+links), parts-by-template.

  **Реализация (2026-06-04, ветка `feat/parts-phase3-stage-g-brand-links`, разбита на 2 PR):**
  - **PR-1 (поведенческие свопы):** клиентский helper read-modify-write `listPartSpecBrandLinks/upsertPartSpecBrandLink/deletePartSpecBrandLink` в `partsPagination.ts` (part-spec пишется целиком через `nomenclaturePartSpecUpdate` — per-link эндпойнта нет; dedup match by linkId→else engineBrandId зеркалит backend `upsertPartBrandLink`). Свопы: `AdminPage` (list `loadPartsOptions/loadBrandParts`→`listAllPartSpecs`, brand-links `updateBrandParts`→helper), `EngineBrandDetailsPage` (brand-links + `createAndAddPart`→`nomenclatureDirectoryPartCreate` с reuse дубликата по контракту `duplicate part exists:<uuid>`), `PartTemplateDetailsPage` (`parts.list({templateId})`→`nomenclaturePartSpecsList({templateId})`). Удалён мёртвый forecast-экспорт.
  - **PR-2 (pre-H cleanup) ✅ ГОТОВ** (ветка `chore/parts-phase3-pre-h-cleanup`): `<PartDetailsPage` рендерится **только embedded** (лишь в `NomenclatureDetailsPage`; App.tsx его не монтирует) → non-embedded ветка целиком мёртвая. `loadBrandLinks`→`listPartSpecBrandLinks` (живёт в embedded-гидрации, но `BrandLinksEditor` `!embedded` → результат не показывается); brand-link write-ops (1383/1393, скрытый редактор)→`upsert/deletePartSpecBrandLink`; мёртвые non-embedded `parts.updateAttribute`(saveAttributeCore, embedded short-circuit'ит в metadata на 1602)/`parts.createAttributeDef`(add-field `!embedded`)→typed-заглушки с deprecation-комментом. Удалена мёртвая legacy-машинерия `listAllParts`/`fetchPartsPage`(последний `parts.list`)/`makeListAllPartsCacheKey`/`normalizeListAllPartsArgs`/`partsListCache`/`invalidateListAllPartsCache` из `partsPagination.ts` + её 3 call-site в `PartDetailsPage`. **Grep-гейт Stage H чист** (только комментарии). Вынесено отдельно: очистка в деликатном 2900-строчном файле, не поведенческий своп.
- **Stage H — blanket 410 на parts-data `/parts/*` · backend-only, ФИНАЛ.** В `routes/parts.ts` заменить хендлеры `GET/POST /`, `GET/PUT/DELETE /:id`, `POST /attribute-defs`, `PUT /:id/attributes/:code`, `GET/PUT/DELETE /:id/brand-links*`, `GET /:id/files`, `POST /templates/:id/create-part` на `res.status(410).json({ ok:false, error:'… используйте /warehouse/nomenclature/:id/part-spec' })`. **`/parts/templates/*` оставить живым** (Решение C). Удалить мёртвые сервис-функции + dual-write мост (Stage C). **Гейт перед 410:** grep-подтверждение, что не осталось `window.matrica.parts.{create,get,delete,updateAttribute,createAttributeDef,list,partBrandLinks}`-вызовов; финальный backfill-reconcile dry-run; `pg_dump` бэкап. Тест 410 (по образцу sync). Обратимость: revert route-файла восстанавливает хендлеры (сервисы в git-истории); данные уже в directory.

| Stage | Тип | Релиз |
|---|---|---|
| B metadata + backfill | backend-only | да |
| C dual-write мост | backend-only | да |
| D новые эндпойнты | backend-only | да |
| E своп карточки | client | да |
| F своп create/get (чисто-свопаемые) | client | да |
| G своп list/brand-links + EngineBrand-create (forecast-репойнт снят) | client | да |
| H blanket 410 | backend-only, последний | да |

## Re-scope Stage F/G (2026-06-04, после разведки call-sites)

Разведка живых `window.matrica.parts.{create,get,delete}` на свежем `main` (после Stage E, v1.39.0) уточнила границу F↔G. Изменения относительно исходного плана:

1. **`parts.delete` — 0 живых вызовов.** Единственный — `PartDetailsPage.tsx:1784` `handleDelete`, в non-embedded ветке (карточка детали рендерится только embedded; `App.tsx:1875` `openPart→openNomenclature`). → **`deleteDirectoryPart` строить не нужно**; Stage H просто 410-ит `DELETE /parts/:id`.
2. **`PartDetailsPage` create/get/delete — мёртвый код.** `get:813` (non-embedded ветка `load()`, embedded ветка `:800` читает metadata-блоб), `create:1124/2249` (`copyToNew`), `delete:1784`. Недостижимы. → убрать/конвертировать в Stage F (иначе grep-гейт Stage H их поймает), но это не поведенческий своп.
3. **create-своп сцеплен с brand-links → EngineBrand-create в Stage G.** `createDirectoryPart` создаёт только `directory_parts` (без EAV-`entities`); `EngineBrandDetailsPage.tsx:333` `createAndAddPart` затем зовёт `parts.partBrandLinks` (EAV, нужна `entities`-строка). Двигать вместе с brand-link-редакторами (которые тоже в Stage G) на part-spec brandLinks.
4. **SupplyRequest get-своп: unit через `nomenclatureList`.** spec-get (`getWarehouseNomenclaturePartSpec`) отдаёт `name`, но не `unit`; соседняя ветка `refKind='nomenclature'` (`SupplyRequestDetailsPage.tsx:498`) уже берёт `unitName` из `nomenclatureList({id})`. part id == nomenclature id → тот же путь для `refKind='part'`.
5. **StockDocument create — поведение-сохраняющий своп.** `StockDocumentDetailsPage.tsx:622` после create зовёт `refreshRefs()` и ищет строку в списке **номенклатуры**; `createDirectoryPart` не создаёт nomenclature-строку → fallback вернёт `partId` как сегодня (мирор EAV→nomenclature снят в Phase 2 Stage F, поэтому и legacy `parts.create` сейчас не создаёт nomenclature). Своп не вносит регресс. Orphan-склонность этого флоу — **pre-existing**, отдельный follow-up (по-хорошему направить через `createNomenclatureLineFromPreset`, чтобы создавалась настоящая nomenclature-строка; вне scope механического свопа).

Итог: Stage F сузился до 4 create-сайтов (createWarehouseNomenclatureFromDirectory / Contract / Stock / RepairChecklist×3) + 2 get-сайтов (SupplyRequest) + чистка мёртвых `PartDetailsPage`-вызовов. EngineBrand-create и всё brand-links/list — Stage G.

## Re-scope Stage G (2026-06-04, forecast-precondition снят)

Разведка перед реализацией Stage G сняла «пред-условие forecast-репойнт» как ложную тревогу:

1. **`listAllPartEngineBrandLinksForForecast` — мёртвый экспорт.** Единственные ссылки — само определение (`partsService.ts`) + скомпилированный `dist`. Ни одного вызова в `backend-api/src` / `shared/src` / `electron-app` / `web-admin`. Удалён в PR-1.
2. **Прогноз не читает `part_engine_brand` EAV.** `warehouseForecastService.ts` берёт связи деталь↔марка из `erpEngineAssemblyBomBrandLinks` (BOM↔марка junction-таблица), которую миграция Phase 3 не трогает, и **не импортирует `partsService` вовсе**. Депрекация EAV part-brand на Stage H прогноз не ломает.
3. **Следствие:** Stage G не нуждается в forecast-репойнте. Связи `part_engine_brand` после Stage G читаются только внутри `partsService` (legacy `/parts/*`, 410-ятся на Stage H) — мёртвый хвост, подлежит удалению в Stage H cleanup вместе с dual-write мостом.

## Re-scope Stage H (2026-06-04, после разведки перед 410)

Разведка перед blanket-410 вскрыла, что Stage H **нельзя делать одним backend-only шагом** — grep-гейт Phase 3 проверял только electron-паттерн `window.matrica.parts.*` и пропустил двух потребителей legacy `/parts/*`:

1. **web-admin зовёт `/parts/*` напрямую** через `apiJson` (`web-admin/src/api/parts.ts`: `listParts`/`createPart`/`listBrandLinks`), вызовы живые в `RepairChecklistPanel.tsx` (list+create defect/completeness) и `ContractDetailsPage.tsx` (list → contract-progress по `metadata.contractId`/`statusFlags`). web-admin сервится с прода (не auto-update, без задержки раскатки). → **Stage H-pre: мигрировать web-admin на directory** (ветка `feat/web-admin-parts-to-directory`): `api/parts.ts` переписан на `GET /warehouse/part-specs` + `POST /warehouse/directory-parts` с нормализацией ответа к старой форме (`{ok, parts:[{id,name,article,brandLinks,contractId,statusFlags}]}` / `{ok, part:{id}}`, reuse дубля по контракту `duplicate part exists:<uuid>`), call-sites не тронуты; `listBrandLinks` удалён (0 вызовов). typecheck web-admin зелёный. **`/verify` web-admin (браузер) НЕ прогонялся** — те же эндпойнты уже проверены electron Stage F/G; риск низкий (тонкий shape-адаптер), но прогнать в браузере до 410 — желательно.
2. **Сервис-функции `partsService` НЕ мёртвые** — их зовут операционные скрипты (`seedDevFixtures` ← verifier!, `importEngineBrandPartMatrix`, `importEnginesFromCompletenessCsv`, `mergeDuplicatePart`, `applyCompletenessClarifications`, `fixPartsAssemblyAndName`, `migratePartBrandJunction`, `restoreEngineChecklistParts`). Снос сервис-функций + dual-write моста (Stage C) **отложен в Phase 3.6** (требует сперва миграции скриптов с legacy parts EAV на directory). Dual-write пока **нужен** — держит `directory_parts` в синхроне со script-создаваемыми деталями. Реально мёртвые (0 вызовов после 410): `getPart`/`createPartAttributeDef`/`createPartFromTemplate` — но exported, «unused» не вспыхивает; уберём в 3.6.

**Ревизованная последовательность Stage H:**
- **H-pre (этот PR):** миграция web-admin → release → deploy (web-admin чист сразу после деплоя, server-served).
- **H (следующий PR, backend-only):** blanket-410 на parts-data `/parts/*` в `routes/parts.ts` (хендлеры → `res.status(410)`), `/parts/templates/*` оставить, `partsService` НЕ трогать (скрипты), 410-тест по образцу `sync.ts`. Гейт: подтвердить, что и electron (`window.matrica.parts.*`), и web-admin (`apiJson('/parts')`) чисты.
- **Phase 3.6 (follow-on):** миграция операционных скриптов с legacy parts EAV → directory, затем снос dead service-fn + dual-write моста.

## Критические файлы
- `backend-api/src/services/warehouseService.ts` — part-spec эндпойнты `:1840-1958` (расширить под `metadata`, unified write, list-фильтры `templateId/engineBrandId`).
- `backend-api/src/services/partsService.ts` — dual-write мост в `createPart/updatePartAttribute/createPartAttributeDef`; позже удаление.
- `backend-api/src/routes/parts.ts` — финальный 410 (образец `routes/sync.ts:5-11`).
- `backend-api/src/database/schema.ts` — `directoryParts` (метадата уже есть; DDL не нужен).
- `backend-api/src/scripts/backfillDirectoryParts.ts` — образец нового metadata-backfill.
- `electron-app/.../pages/NomenclatureDetailsPage.tsx` (unified save `:463-525`), `PartDetailsPage.tsx` (записи карточки), `utils/partsPagination.ts` (`listAllPartSpecs` + `templateName`).
- `shared/src/domain/part.ts` — новый `PartMetadata` рядом с `PartSpec`.

## Риски / контроль
1. ✅ **Forecast brand-reader — СНЯТ (2026-06-04).** Ложная тревога: `listAllPartEngineBrandLinksForForecast` — мёртвый экспорт (удалён); прогноз читает `erpEngineAssemblyBomBrandLinks` (BOM↔марка), не `part_engine_brand` EAV. См. «Re-scope Stage G». Репойнт не требуется.
2. ✅ **Custom-attr per-part vs global — СНЯТ (2026-06-03).** B.2 dry-run прогнан на проде (read-only, SSH-тоннель к prod-PG): `withCustom:0 · globalCustomDefs:{count:0}` — на проде ноль кастом-атрибутов деталей, конфликта per-part vs global нет, Решение B риска не несёт. (Заодно: `parts:159 · withDirectoryRow:159 · missingDirectoryRow:[]` → `backfill-directory-parts` не нужен; `toUpdate:83` к metadata-backfill.)
3. **`/parts/templates/*` остаётся** (Phase 3.5) — `directory_parts.templateId` всё ещё на `part_template`-сущности.
4. **`duplicate part exists: <uuid>`-контракт** — directory-create обязан эмитить тот же формат (`createWarehouseNomenclatureFromDirectory.ts:157`).
5. **Orphan-гигиена** — directory-create обязан парно делать `directory_parts` insert + `nomenclatureUpsert` (или гонять `backfill-orphan-part-nomenclature`).
6. **Старые клиенты после Stage H** — 410 = видимая ошибка; dual-write (C) держать до H, затем follow-up убирает EAV-write.

## Верификация (на стадию)
- Backend: `corepack pnpm -F @matricarmz/backend-api typecheck && test`; roundtrip-тесты part-spec+metadata; 410-тест на Stage H.
- Клиент: `corepack pnpm -F electron-app typecheck` + eslint затронутых файлов.
- E2E: `/verify` (skill `verifier-electron`, CDP deep-link) на Stage E/F/G — карточка детали грузится/сохраняется через directory-путь, brand-CRUD, create-входы.
- Backfill: dry-run на prod-restore dev-БД (PG17 :5433 `matricarmz_dev`) → `--apply`; на проде — `pg_dump` бэкап → `db:migrate` (если DDL) → backfill `--apply`, row-counts в теле PR.
- Прод после каждого релиза: `curl -fsk https://127.0.0.1/health` + `/updates/status` = новая версия.

## Не входит в Phase 3
- Миграция part-шаблонов (`/parts/templates/*`) → отдельная «Phase 3.5».
- Удаление auto-mirror EAV→directory в `upsertWarehouseNomenclature` (`:1497`) — cleanup-follow-up после Stage F.
