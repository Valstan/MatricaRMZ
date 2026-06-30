# Phase 3.7 — единая конвенция деталей + снос dual-write моста

> Завершение директивы brain `parts-chain-audit` (mandate), этапы B/C на сошедшейся модели. Предшественники: [`parts-chain-audit.md`](parts-chain-audit.md) (карта keyspaces, разрывы G1–G5), [`parts-chain-audit-dedup.md`](parts-chain-audit-dedup.md) (G2 ✅, G1-код ✅, G3 ✅), [`parts-nomenclature-phase3.md`](parts-nomenclature-phase3.md) (Stage A–H ✅), [`parts-phase-3.6-dead-fn-removal.md`](parts-phase-3.6-dead-fn-removal.md) (Tier 1 ✅).
>
> **Решения владельца (2026-06-07):** (1) G1 — **унифицировать** 27 деталей к id-тождеству (миграция прод-данных); (2) dual-write — **мигрировать 7 скриптов + снести мост**.

## Grounded state (снимок прода 2026-06-07, post-dedup)

- `directory_parts` активных: **129** = 102 на id-тождестве (`directory_parts.id == erp_nomenclature.id`) + **27 на двойной конвенции** (мост только через `erp_nomenclature.directory_ref_id`) + 0 без номенклатуры.
- **G1 = 27** (дедуп не тронул). Функционально безопасны: трансляция `partId→nomenclatureId` задеплоена в `workOrderClosingService` (код-половина). Двойная конвенция — техдолг.
- **G4:** `directory.brand_links_json` непустое у **72** деталей; EAV-список на момент аудита = 87. Точный gap домерить при исполнении WS3.
- `partsService.ts`: Tier 1 уже снесён; остались **Tier 2** (`listParts`/`createPart`/`updatePartAttribute`/`deletePart`/`upsertPartBrandLink`/`deletePartBrandLink`/`listPartBrandLinks`) + templates (keep) + dual-write мост (`mirrorPartFieldsToDirectory`/`mirrorPartBrandLinksToDirectory`).

## Линчпин-инсайт

`bomBrandPartSync.ts::ensureNomenclatureBrandPart` — **живой** хук в `upsertWarehouseAssemblyBom` (директива bom-parts #213), НЕ скрипт. Он:
1. `createPart({name})` → новый `directory_parts` со **свежим id** (≠ nomenclature.id) + entity part;
2. `bind`: `erp_nomenclature.directory_ref_id = partId` (хирургический update + ledger);
3. `upsertPartBrandLink` → пишет `part_engine_brand` EAV + зеркалит в `directory.brand_links_json`.

⇒ Этот хук **одновременно** (а) пишет parts/part_engine_brand EAV (блокирует снос моста) и (б) **порождает** двойную конвенцию G1 (новый id + directory_ref_id bind). Directory-native переписывание (id-тождество + brand-links прямо в `brand_links_json`, без EAV) закрывает **оба** разрыва у источника.

## Живые (не-скрипт) потребители EAV после Stage H 410

- **Писатель:** `bomBrandPartSync.ts` (createPart + upsertPartBrandLink) — единственный живой write-путь parts/part_engine_brand EAV.
- **Читатели brand-links:** UI читает `directory.brand_links_json` (warehouse-эндпойнты, `listAllPartSpecs`) — уже directory. `bomBrandPartSync` читает `listPartBrandLinks` (EAV) для idempotent-проверки.
- **Скрипты (7, обработаны в WS2 ✅ 2026-06-07):** мигрированы — `seedDevFixtures` (← verifier!), `importEngineBrandPartMatrix`, `importEnginesFromCompletenessCsv`; удалены (мёртвые) — `applyCompletenessClarifications`, `fixPartsAssemblyAndName`, `restoreEngineChecklistParts`, `mergeDuplicatePart`. **Ещё 3 Tier-2 caller'а** вне этого списка (`backfillBomPartsIntoBrandLists`/`migratePartBrandJunction`/`retireUnusedParts`) → WS2.1.

## Целевая архитектура

- Brand-links детали марки: **единственный источник** = `directory.brand_links_json` (id детали = `erp_nomenclature.id`, id-тождество везде).
- Писатели: UI (warehouse, уже directory), `bomBrandPartSync` (мигрировать), скрипты (мигрировать).
- `entities type=part`, `entities type=part_engine_brand`, parts EAV-атрибуты → **мёртвые** (G5: задокументировать, снос — отдельная низкоприоритетная нитка).

## Workstreams (порядок + гейты)

> Прод-мутации — рефлекс #025/G29: затрагиваемый набор подтверждать в том же ходе, `pg_dump` до `--apply`, row-counts в теле PR. Делать на сошедшейся модели.

### WS1 — directory-native brand-link helper + rewire `bomBrandPartSync` (код)
- **Sync-вопрос РАЗРЕШЁН (2026-06-07, read-only разведка):** `directory_parts`/`part_engine_brand` — **server-only** (нет в `electron-app/drizzle` client SQLite). Клиенты читают part-specs/brand-links по **live-HTTP-API** (`erpService.ts:865` → `/warehouse/part-specs`; preload `nomenclaturePartSpec*` → IPC → HTTP), не из синканного SQLite. ⇒ запись через `upsertWarehouseNomenclaturePartSpec` сразу видна клиентам, **ledger-подпись для brand-links не нужна** (legacy ledger-append был для EAV `part_engine_brand` — бросаемый keyspace). UI пишет brand-links этим путём с v1.40 Stage G — на проде работает (эмпирика).
- Переписать `ensureNomenclatureBrandPart` на `getWarehouseNomenclaturePartSpec` (читать текущий spec/brandLinks по `id=nomId`) + `upsertWarehouseNomenclaturePartSpec` (merge brandLinks, **id = nomenclature.id** — id-тождество). **Убрать** `createPart` (новый id), `bindNomenclatureToPart` (`directory_ref_id`), `listPartBrandLinks`/`upsertPartBrandLink` (EAV). Steady-state — directory SELECT.
- Результат: новые детали из BOM — id-тождество (G1 не плодится); живой путь больше не пишет parts/part_engine_brand EAV.
- Нюанс перехода: BOM-номенклатура, у которой `directory_ref_id` уже указывает на один из 27 ref-only — до WS4 писать brand-links по id-тождеству (id=nomId); старая ref-строка осиротеет и подберётся унификацией WS4. Добавить guard/лог.
- Гейт: typecheck/lint + backend test + CDP /verify (BOM upsert → компонент в списке деталей марки, brand-link persisted в directory).

### WS2 — миграция 7 скриптов EAV→directory-native (код) — ✅ 2026-06-07
- Свопнуть `createPart`/`updatePartAttribute`/`upsertPartBrandLink`/… на directory-записи (helper/warehouse-сервис). `seedDevFixtures` — сохранить контракт verifier-фикстур (TEST-BRAND/TEST-PART/brand-link/TEST-001).
- Гейт: typecheck/lint + backend test + verifier поднимается (seedDevFixtures).
- **Исход (решения владельца 2026-06-07):** мигрированы на directory-native (`createDirectoryPart` + `get/upsertWarehouseNomenclaturePartSpec`) — `seedDevFixtures`, `importEngineBrandPartMatrix`, `importEnginesFromCompletenessCsv`. Удалены как мёртвые разовые (нет npm-скрипта, 0 ссылок, применены на проде в фев-2026) — `applyCompletenessClarifications`, `fixPartsAssemblyAndName`, `restoreEngineChecklistParts`. Удалён `mergeDuplicatePart` (+ npm `warehouse:merge-duplicate-part`): дедуп EAV part-keyspace, задача из dedup-плана выполнена, keyspace отмирает (G5); directory-дедуп закрывается WS4 + dedup-by-name в `createDirectoryPart`.
- **Проверено runtime:** `dev:seed-fixtures` идемпотентен, EAV `part`/`part_engine_brand` НЕ растёт, `TEST-PART.brand_links_json` = TEST-BRAND qty 2 UN-001. typecheck+lint+222 теста зелёные.
- **⚠️ Пробел плана (найден 2026-06-07):** Tier-2 EAV-fn зовут ещё **3** скрипта вне списка «7» — `backfillBomPartsIntoBrandLists` (`listPartBrandLinks`, read; WS1-era backfill), `migratePartBrandJunction` (`upsertPartBrandLink`; разовая junction-миграция фев-2026), `retireUnusedParts` (`deletePart`+`listPartBrandLinks`; dedup-companion, 16 пустых групп). **WS5 не разблокируется**, пока эти 3 зовут Tier-2. Решить (delete vs migrate) до WS5 — см. WS2.1.

### WS2.1 — добить 3 оставшихся Tier-2 caller'а (код) — ✅ 2026-06-07
- `backfillBomPartsIntoBrandLists`, `migratePartBrandJunction`, `retireUnusedParts` — delete (мёртвые/job-done) или migrate listPartBrandLinks/upsertPartBrandLink/deletePart→directory. После — 0 внешних вызовов Tier-2 ⇒ WS5 разблокирован.
- Гейт: grep 0 внешних Tier-2 вызовов + typecheck/lint + backend test.
- **Исход:** все 3 **удалены** (+ npm `parts:migrate-brand-junction`, `warehouse:retire-unused-parts`, `warehouse:backfill-bom-parts-brand-lists[:dry-run]`). Все job-done на отмирающем keyspace: `migratePartBrandJunction` — разовая legacy→part_engine_brand миграция; `backfillBomPartsIntoBrandLists` — разовый bom-parts backfill (отработал; gap-логика на устаревшем `directory_ref_id`, хук WS1 теперь гарантирует на каждом upsert); `retireUnusedParts` — companion удалённого `mergeDuplicatePart` (dedup etap-B, 16 пустых групп). **grep подтвердил 0 внешних Tier-2 вызовов ⇒ WS5 разблокирован** (остаются только ссылки в `partsService.ts` + тестах).

### WS3 — G4 реконсиляция (прод-данные)
- Домерить EAV-only brand-links (есть в `part_engine_brand`, нет в `brand_links_json`). Backfill в directory (additive, обратимо). Цель: directory покрывает 100% до отмирания EAV.
- Гейт: dry-run → pg_dump → `--apply` (подтверждение), row-counts.
- **✅ Инструмент готов и локально провалидирован (2026-06-07):** `backend-api/src/scripts/backfillDirectoryBrandLinksFromEav.ts` (npm `warehouse:backfill-directory-brand-links` / `:apply`). Читает EAV `part_engine_brand` напрямую SQL (не через снесённые Tier-2 fn — данные на проде целы, WS5 убрал только код). Маппинг `part_id == directory_parts.id` (подтверждён). Аддитивно/идемпотентно: добавляет только отсутствующие связи (match по `engineBrandId`), существующие не трогает; dead-brand (soft-deleted марка) и unmapped part_id — пропуск+репорт. Локальная валидация на синтетике (dev): dry-run обнаружил gap → `--apply` записал `{engineBrandId,asm,qty}` в `brand_links_json` (свежий uuid) → re-dry-run идемпотентен (gaps=0).
- **✅ ПРОД-ПРОГОН ВЫПОЛНЕН (2026-06-07) — NO-OP, G4 уже закрыт.** dry-run на проде: `eav=705, already=603, dead-brand=32, unmapped=70, **gaps=0**`. Бэкафиллить нечего — directory покрывает 100% живых связей (Stage C dual-write мост закрыл разрыв до сноса в WS5). 70 unmapped — **все на soft-deleted part-сущностях** (мёртвые орфаны от дедупа), 32 dead-brand — soft-deleted марки. `--apply` не запускался (нет записей). G4 ✅.
- **Примечание по порядку:** WS5 выполнен до WS3, но EAV-**данные** целы (WS5 снёс только код) — backfill читает `part_engine_brand` напрямую, ничего не потеряно.

### WS4 — G1 унификация 27 деталей к id-тождеству (прод-данные)
- Слить 27 ref-only `directory_parts` к `id = nomenclature.id`: перенести spec/metadata/brand-links на id-тождественную запись, перепривязать ссылки (склад/BOM/контракты — домерить), ретайр старой directory-строки, занулить `directory_ref_id` (станет тождеством). Подписанные пути.
- Гейт: dry-run сверка набора → pg_dump → `--apply` (подтверждение), пост-проверка `g1_ref_only = 0`.
- **✅ Scope домерен на проде (read-only, 2026-06-07):** **27** ref-only (живая ref-строка); 4 имеют коллизию (id-тождественная строка уже есть → union brand-links). **Перепривязка НЕ нужна:** склад/BOM/контракты ключуются по `nomenclature_id`, ссылок на ref-id там **0**; единственная ссылка на ref-id — EAV `part_engine_brand.part_id` (225, отмирающий keyspace — абандонится). ⇒ WS4 = только перенос spec/brand-links на id-тождественную строку + retire ref-строки + занулить `directory_ref_id`. (Также 449 номенклатур с **dangling** `directory_ref_id` на retired/missing строки — отдельная косметика занулить, не data-loss.)
- **✅ Инструмент готов и локально провалидирован (2026-06-07):** `backend-api/src/scripts/unifyPartIdConvention.ts` (npm `warehouse:unify-part-id-convention` / `:apply`). Union brand-links по `engineBrandId`; непустые поля id-тождественной строки приоритетны, иначе из ref; metadata — id-тождественная приоритетна. Локальная валидация (dev, синтетика A=без-коллизии + B=коллизия): dry-run→apply → id-тождественные строки получили объединённые brand-links (A:1, B:2 union), ref-строки retired, `directory_ref_id` занулены, `g1_ref_only=0`.
- **✅ ПРОД-ПРОГОН ВЫПОЛНЕН (2026-06-07) под явным подтверждением владельца.** Бэкап `~/backup-ws4-g1-unify-pre-apply-2026-06-07-1501.dump` (`directory_parts`+`erp_nomenclature`). dry-run: 27 ref-only, 4 коллизии, +223 brand-links. `--apply`: `applied=27 retired=27 refs-nulled=27`, 0 ошибок. **Пост-проверка: `g1_ref_only=0`** ✅, re-dry-run идемпотентен (ref-only=0). Sample «Головка»: id-тождественная строка = 21 link, ref retired, `directory_ref_id` null. Оба сервиса active, /health 1.44.0. Сервисы не перезапускались (данные читаются по live-HTTP). Прод-checkout возвращён к чистому v1.44.0 (скрипты придут штатным релизным pull).
- **⏳ Остаток (косметика, не data-loss):** **449** номенклатур с **dangling** `directory_ref_id` (указывает на retired/missing directory-строку). Не G1 (живой ref-строки нет), отдельным шагом занулить `directory_ref_id` (поведенчески нейтрально — dangling-указатель и так не резолвится).

### WS5 — снос dual-write моста + Tier 2 fn (код) — ✅ 2026-06-07
- Удалить `mirrorPartFieldsToDirectory`/`mirrorPartBrandLinksToDirectory` + Tier 2 exported fn (`createPart`/`updatePartAttribute`/`deletePart`/`*BrandLink*`/`listParts`) — после WS1/WS2 у них 0 живых вызовов. Templates — оставить.
- Гейт: grep 0 вызовов + typecheck/lint + backend test.
- **Исход:** `partsService.ts` 2684 → 969 строк (−1716). Снесены exported Tier-2 fn (`listParts`/`listPartBrandLinks`/`upsertPartBrandLink`/`deletePartBrandLink`/`createPart`/`updatePartAttribute`/`deletePart`) + приватные мост-хелперы (`mirrorPartFieldsToDirectory`/`mirrorPartBrandLinksToDirectory`) + осиротевшие приватные (`findPartDuplicateId`/`findPartDuplicateOnUpdate`/`listPartBrandLinksInternal`/`toAttachmentPreviews`/`normalizeValueForCompare` + part_engine_brand-трио `get/ensure…EntityType/AttributeDefs`) + неиспользуемые импорты/тип/конст. **Оставлено:** все 5 template-fn + общие хелперы (часть `ensurePart*` транзитивно нужна `ensureExistingPartTemplateAssignments`). **`partFieldMirror.ts` НЕ тронут** — это pure-утилиты, живые потребители `backfillDirectoryParts`/`backfillDirectoryPartsMetadata` (не «мост»; «мост» был в самом partsService).
- **Проверено runtime:** templates CRUD через REST (`/parts/templates` list/create/get/delete) — ✅ после операции. typecheck+lint+222 теста зелёные.

### WS6 — G5 реестр мёртвых схем + C верификация
- **G5-реестр ✅ задокументирован 2026-06-07** в `PROJECT_STATE.md` (раздел «Последние важные изменения»). **⚠️ Спекулятивный список из этого плана оказался частично НЕВЕРНЫМ** (заземление grep'ом по live services+routes): `erp_part_cards`/`erp_reg_part_usage` — **живы** (смонтированный `/erp` router + `erpService` read/write); `erp_nomenclature_engine_brand` — **жив** (BOM/forecast/sync junction); `erp_engine_instances` — **жив** (регистр экземпляров + sync). **Реально мёртв только parts EAV:** `part_engine_brand` (в живом коде лишь комментарии) + parts EAV-атрибуты; `entities type=part` — заморожены (единственный остаточный read — `ensureExistingPartTemplateAssignments`). Депрекация `erp_*` (если нужна) — отдельный аудит, НЕ Phase 3.7.
- **✅ CDP сквозной ВЫПОЛНЕН (2026-06-07, verifier-electron, локально) — PASS.** Сценарий `.verifier-electron/cdp-ws6-lifecycle.mjs` (bridge `window.matrica.*` — тот же IPC, что UI): активная BOM марки из id-тождественных номенклатур (variant-scope, обход completeness; хук срабатывает на все строки = исходный bom-parts путь #213) → приход (purchase_receipt, posted) → прогноз BOM марки. **Результат:** id-тождество (HTTP+DB: `directory_parts.id == erp_nomenclature.id`, `directory_ref_id` NULL, ровно 1 directory-строка на деталь, **0** divergent-keyspace), WS1-хук завёл brand-link на id-тождестве (без G1-дублей), приход → движения все по одному `nomenclature_id`, **прогноз НЕ двоит** (`rowCount=2, distinctIds=2, eachPartOnce`), синканный клиентский список — деталь ровно одной записью.
  - **Архитектурные находки прогона** (зафиксированы): part-spec/assemblyBom/forecast/nomenclatureList/nomenclatureUpsert/directoryPart — live-HTTP (видны сразу); `documentCreate`/stock — клиентский SQLite outbox (offline-first, нужен предварительный `sync.run()`, иначе `no such table: warehouse_command_outbox`). Создание part-номенклатуры — тяжёлый путь (directoryKind+directoryRefId+group+unit+template); id-тождество заводит **хук** при сохранении BOM (erp_nomenclature — мастер, directory_parts — id-тождественное расширение). Поэтому сценарий проверяет **инвариант идентичности** через данные/IPC (что и есть суть #3), а не пиксельный full-UI drive разборки/ремонта (непропорционально дорого для verifier; механика движений одинаковая — все ключуются по `nomenclature_id`).
  - Dev-БД (`matricarmz_dev`) после прогона содержит тест-данные (active BOM `CDP-WS6-BOM-*`, brand-links на TEST-PART/COMP2, движения) — git-ignored, локально, пересоздаётся `setup-db.ps1 -Reset` + `migrate-and-seed.ps1`.

## Критерии приёмки (из директивы)
1. ✅ Карта-аудит (`parts-chain-audit.md`).
2. ✅ Одна физ. деталь = один nomenclature-id; нет параллельных keyspace (WS1 хук id-тождество + WS5 снёс Tier-2/мост код + WS4 прод `g1_ref_only=0`). Остаток 449 dangling-указателей — **занулён на проде 2026-06-07** (`UPDATE 449 → 0`, бэкап `~/backup-dangling-ref-null-pre-apply-2026-06-07.dump`).
3. ✅ Сквозной CDP без дублей (WS6, verifier-electron, PASS 2026-06-07): id-тождество (DB: 0 divergent), brand-link на id-тождестве без G1-дублей, движения по одному `nomenclature_id`, прогноз не двоит, синканный клиент — одна запись.
4. ✅ Исходный bom-parts гейт перепроверен (WS1 runtime /verify + WS6 CDP: BOM upsert → деталь марки → directory id-тождество, без EAV; идемпотентность + transition-guard).

**🏁 Phase 3.7 ПОЛНОСТЬЮ ЗАВЕРШЕНА (2026-06-07).** Все 4 критерия приёмки директивы `parts-chain-audit` выполнены.

## Затрагиваемые файлы
- `backend-api/src/services/bomBrandPartSync.ts` — rewire на directory-native (WS1).
- `backend-api/src/services/partsService.ts` — снос моста + Tier 2 (WS5 ✅, 2684→969).
- `backend-api/src/services/partFieldMirror.ts` — pure-утилиты, оставлены (живые backfill-скрипты), НЕ мост (WS5).
- `backend-api/src/scripts/{seedDevFixtures,importEngineBrandPartMatrix,importEnginesFromCompletenessCsv,applyCompletenessClarifications,fixPartsAssemblyAndName,restoreEngineChecklistParts,mergeDuplicatePart}.ts` — WS2.
- Новый: `backend-api/src/scripts/unifyPartIdConvention.ts` (WS4, dry-run/`--apply`); `backfillDirectoryBrandLinksFromEav.ts` (WS3, dry-run/`--apply`).
- `.claude/skills/verifier-electron/` — проверить, что seedDevFixtures-контракт цел (WS2).
