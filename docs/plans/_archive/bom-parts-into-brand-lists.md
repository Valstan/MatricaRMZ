# План: детали BOM-спецификаций → списки деталей марок двигателей

> Источник: MUST-директива brain `mailboxes/MatricaRMZ/from-brain/2026-06-02-bom-parts-into-engine-brand-lists.md`. Цель — чтобы при разборке двигателя после дефектовки **каждую** деталь из BOM можно было оприходовать («в ремонт» / «готова к сборке») и она была **видна как деталь марки** (трекинг, карточка марки).

## Статус: ▶️ В РАБОТЕ (Phase 3 завершён, разблокировано 2026-06-06)

- **Интерпретация уточнена владельцем (2026-06-06): вариант A** — «деталь не видна как деталь марки». Разборка и так приходует все BOM-детали (поток BOM-driven, не гейтится), но деталь не заведена как полноценная «деталь марки»: нет в `EngineBrandDetailsPage`, нет трекинга. Нужно: для каждой BOM-детали обеспечить part-представление, привязанное к марке.
- **Объём (выбор владельца): разовый backfill + постоянная гарантия в коде** (хук на запись BOM-строки).

## Модель данных — ПРОВЕРЕНО ПО КОДУ (2026-06-06, важная корректировка)

**Списки деталей марки читаются из LEGACY EAV, не из directory-модели:**

- `EngineBrandDetailsPage.listPartsByBrand` → `listParts()` (`partsService.ts:1182`) перечисляет `entities` part-типа и навешивает `brandLinks` из `listPartBrandLinksInternal` — это **legacy `part_engine_brand` (EAV)**. Это source of truth для «что в списке деталей марки».
- **Dual-write зеркало** `mirrorPartBrandLinksToDirectory` (`partsService.ts:1684`): при мутации legacy-связи синхронит `directory_parts.brand_links_json`. Ключ зеркала — `directory_parts.id = partId`, т.е. **part-`entities` и `directory_parts` делят один id** (Phase 3 id-alignment).
- `createPart` (`partsService.ts:2102`) создаёт part-`entities` **И** same-id `directory_parts` (строки 2147/2158), пишет sync-changes, дедупит по имени → при дубле вернёт `duplicate part exists: <id>`.
- `upsertPartBrandLink` (`partsService.ts:1771`) пишет legacy `part_engine_brand` + зеркалит в directory. **Требует непустой `assemblyUnitNumber`** (строка 1787) и `partId` как существующую part-`entities`.

**Связь BOM ↔ деталь марки:** BOM-строки ключуются `component_nomenclature_id` (`erp_nomenclature`); деталь марки — part-`entities`/`directory_parts`. Мост: `erp_nomenclature.directory_ref_id → directory_parts.id` (= partId). При разборке приход идёт по `nomenclatureId`, поэтому чтобы приходуемая деталь «была» деталью марки — номенклатуру надо привязать к part (`directory_ref_id`).

| Сущность | Таблица | Файл |
|---|---|---|
| BOM header / строки / ↔марка | `erp_engine_assembly_bom` / `_lines` / `_brand_links` | `schema.ts:1126/1175/1148` |
| Деталь (legacy) | `entities` type part + `part_engine_brand` (EAV) | `partsService.ts` |
| Деталь (directory, same id) | `directory_parts` (+ `brand_links_json` зеркало) | `schema.ts:804` |
| Номенклатура ↔ деталь | `erp_nomenclature.directory_ref_id` | `schema.ts:1030` |
| Диалог разборки (BOM-driven) | `EngineDismantlePreviewDialog.tsx` — приход по `nomenclatureId`, НЕ гейтится списком марки | `components/` |
| BOM-write (хук-гарантия сюда) | `warehouseBomService.ts` (insert строк :672) | `services/` |

## Размер разрыва — ПРОД (read-only, 2026-06-06)

- Активных BOM: **5**; BOM↔марка связей: **21**; BOM-строк: 102.
- Различных BOM-номенклатур в активных BOM: **27**; пар (марка × номенклатура): **225**.
- **Все 27 имеют `directory_ref_id IS NULL`** → нет part-представления → нет ни в одном списке марки (`already_linked = 0`).
- Совпадений по имени с существующей `directory_parts`: **3 из 27** (переиспользовать через дедуп `createPart`).

## Реализация

### Stage 1 — backfill-скрипт (dry-run по умолчанию → `--apply`), идемпотентный
Образец: `importEngineBrandPartMatrix.ts`. Для каждой из 27 BOM-номенклатур, по каждой марке активного BOM, её содержащего:
1. **find-or-create part:** `createPart({ actor, attributes: { name: nom.name } })`; при `duplicate part exists: <id>` — переиспользовать id (идемпотентность + 3 совпадения).
2. **bind:** `update erp_nomenclature set directory_ref_id = partId where id = nomId` (если ещё NULL).
3. **link:** для каждой марки — найти существующую `part_engine_brand`-связь по (partId, engineBrandId); если нет — `upsertPartBrandLink({ actor, partId, engineBrandId, assemblyUnitNumber: <placeholder>, quantity: qty_per_unit })`. Зеркалится в directory автоматически.
- Флаги: `--apply` (иначе dry-run, exit 1 при наличии разрыва — CI-friendly), `--include-drafts` (off по умолч.), `--json`, `--samples N`.
- **Открытое решение — `assemblyUnitNumber`:** в BOM нет узла сборки, а поле обязательно. Дефолт: плейсхолдер (`'—'` или `component_type`). Уточнить при ревью dry-run.
- Edge: пропускать строки с удалённой целевой номенклатурой (логировать skipped); заводить в КАЖДУЮ привязанную марку (адресность); diff по distinct (variant_group игнорировать).

### Stage 2 — постоянная гарантия (хук в `warehouseBomService.ts`)
После insert BOM-строки (и при назначении марки BOM): для `component_nomenclature_id` обеспечить part-представление + brand-link для марок BOM (та же логика, что Stage 1, вынести в helper `ensureBomComponentBrandPart`). Best-effort/логируемый, чтобы не ронять запись BOM.

### Stage 3 — верификация + отчёт
- `/verify`: разобрать двигатель тестовой марки → BOM-деталь видна в карточке марки + приходуется «в ремонт»/«готова к сборке».
- Письмо brain `mailbox/to-brain/2026-06-06-bom-parts-into-engine-brand-lists-done.md` (kind=feedback): затронутые марки, кол-во деталей, разово+гарантия, подтверждение прихода.

## Dry-run preview (прод, read-only SQL, 2026-06-06) — НАХОДКА ДЛЯ РЕВЬЮ

27 деталей. Размах по маркам от 1 до 21. **5 обобщённых односложных имён без спецификации:** «Головка» (21 марка), «Кольцо» (21), «Картер» (12), «Рубашка цилиндров» (12), «Гильза» (1). **Все 3 name-match — обобщённые** («Головка»/«Картер»/«Гильза»). Остальные 22 — специфичные (напр. «Поршень К 3305-05-24-04 149,56-149,60 В-84 В-59 УМС»).

⚠️ **Решение владельца до `--apply`:** заводить/переиспользовать обобщённые («Головка» в 21 марку) рискует слить несвязанное и противоречит «адресности» директивы. Варианты: (a) backfill всех 27 как есть; (b) только 22 специфичных, 5 обобщённых — отдельно (переименовать в BOM / исключить); (c) другой критерий.

## Прогресс
- [x] Разведка + уточнение интерпретации (A) + объём (backfill+гарантия)
- [x] Модель проверена по коду, разрыв измерен на проде, план зафиксирован
- [x] Stage 1 — backfill-скрипт (`backfillBomPartsIntoBrandLists.ts`), typecheck зелёный
- [x] Решение владельца по обобщённым именам: **все 27 как есть** (apply создал 27 новых, слияния не было)
- [x] **Stage 1 на ПРОДЕ (PR #212, 2026-06-06):** dry-run → `--apply` = partsCreated 27, binds 27, links 225, errors 0. Верификация: gap `no_part_at_all 225→0`, `already_linked 0→225`. Бэкап `~/backup-bom-parts-pre-apply-2026-06-06.dump`.
- [x] **Stage 2 — хук-гарантия:** логика вынесена в `services/bomBrandPartSync.ensureNomenclatureBrandPart` (общая со скриптом), врезана best-effort в `upsertWarehouseAssemblyBom` перед `return ok`. Косметика dry-run-счётчиков исправлена. Typecheck + 27 тестов (вкл. 7 `warehouseBomUpsert.integration`) + lint зелёные.
- [x] **Stage 2 на ПРОДЕ (PR #213, 2026-06-06):** pull+build+restart обоих сервисов (серверный код, без version bump); health 1.43.0, оба active.
- [x] **Stage 3 — /verify:** HTTP-поверхность `POST /warehouse/assembly-bom` на локальном backend — новая BOM-деталь → bind `directory_ref_id` + part + legacy `part_engine_brand` + зеркало; idempotent (повтор не плодит дублей). PASS.
- [x] **Письмо brain** отправлено: `mailbox/to-brain/2026-06-06-bom-parts-into-engine-brand-lists-done.md` (kind=feedback).

## Статус: ✅ ЗАВЕРШЕНО (2026-06-06) — backfill + гарантия на проде, директива brain закрыта.

## Follow-up (low-prio)
- 3 одноимённых детали глобально («Картер»/«Гильза»/«Головка») — apply создал новые, не слил. В рамках «все 27». При желании — дедуп/переименование.
