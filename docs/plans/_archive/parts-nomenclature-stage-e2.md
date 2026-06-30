# Stage E.2 — слияние `PartDetailsPage` в `NomenclatureDetailsPage` + редирект

Подплан Stage E (Phase 2, parts → nomenclature, Вариант А). Master-план:
[`parts-nomenclature-phase2-variant-a.md`](parts-nomenclature-phase2-variant-a.md) §Stage E.2.

## Context

Phase 2 (parts → nomenclature, Вариант А) сводит «деталь» к позиции номенклатуры. Stages B/C/D готовы (v1.35.0),
**E.1 раскатан (v1.36.0)** — в карточку номенклатуры добавлена аддитивная подпанель «Спецификация детали»
(размеры / шаблон / применяемость), пишущая в `directory_parts` через part-spec endpoint.

**Проблема, которую решает E.2:** у оператора всё ещё ДВЕ карточки одной сущности — legacy `PartDetailsPage`
и `NomenclatureDetailsPage`. Это порождает транзитный риск (правки спецификации в одной не видны в другой) и
дублирует путь оператора. Простой редирект `openPart → openNomenclature` невозможен: в карточке номенклатуры
НЕТ полей, которые есть только в legacy-карточке и которые пользователь решил **сохранить полностью**
(2026-06-01): описание, «где используется», вложения, поставщик/дата/контракт/статусы, произвольные EAV-поля.
Поэтому E.2 = перенести эти блоки в карточку номенклатуры, затем редирект и деприкейт `PartDetailsPage`.
Итог: один редактор, транзитный риск двух редакторов закрыт.

**Ключевой факт-энейблер:** `directory_parts.id == nomenclature id` (1:1, см.
`backend-api/src/services/warehouseService.ts:1943,2023`). Значит в `NomenclatureDetailsPage` `props.id` — это
И есть part id, по которому работает legacy EAV-IPC `window.matrica.parts.get/updateAttribute`.
**Бэкенд менять не нужно** — переносимые поля уже доступны по тому же id. Переносимые блоки хранятся в part-EAV
и НЕ пересекаются с полями E.1 (dimensions/template/brandLinks живут в `directory_parts`) — конфликта полей нет.

## Подход (РЕВИЗИЯ 2026-06-02): EMBED `PartDetailsPage` в режиме `embedded`, не извлечение секций

> **Изменение относительно первоначального плана «извлечь 4 компонента».** При чтении кода выяснилось, что
> `PartDetailsPage` уже экспонирует полный save-handle (`CardCloseActions.saveAndClose` → `saveAllAndClose`,
> `cardCloseTypes.ts`) и уже принимает `partId/canEdit/canViewFiles/canUploadFiles` + open-handlers. Извлечение
> 4 самодостаточных компонентов = ~1200 строк нового кода, дублирующего боевую логику загрузки/очередей/
> сохранения, с риском расхождения. Вместо этого добавляем `PartDetailsPage` **режим `embedded`**: карточка
> номенклатуры монтирует `<PartDetailsPage embedded partId={props.id} … />` под `isPartClass`. Это переиспользует
> весь протестированный код, без дублирования. Меньше кода, ниже риск регрессии, естественно DRY.

**Что делает `embedded`-режим в `PartDetailsPage`:**
- рендерит тело БЕЗ `EntityCardShell` / `CardActionBar` (только сетку секций; save/close/delete/print/copy — у родителя);
- скрывает блоки, которыми владеет карточка номенклатуры + подпанель E.1: поля `name`/`article`/`Шаблон детали`
  (фильтр `mainFields`), секции «Совместимость» (brandLinks), «Размеры детали» (dimensions), «Карточка» (метаданные);
- оставляет: описание/дата/поставщик/контракт/статусы (остаток `mainFields`), «Где используется», 3 панели вложений,
  «Дополнительные поля» (произвольные EAV);
- в `saveCore` исключает кандидаты `name`/`article`/`PART_TEMPLATE_ID_ATTR_CODE`/`PART_DIMENSIONS_ATTR_CODE`
  (их пишет nomenclatureUpsert + partSpecUpdate) → нет двойной записи;
- экспонирует saver родителю новым опциональным prop `onRegisterSaver` (стабильная обёртка над `saveAllAndClose`
  через ref — без stale-closure), который оркестратор Save карточки номенклатуры вызывает фазой 3.

**Stage F:** `PartDetailsPage` НЕ удаляется (он — провайдер embedded-полей); удаляется только standalone-маршрут
(`tab==='part'`, `selectedPartId`, тело `openPart`). Файл можно переименовать (`PartEavCard`) при желании.

(Первоначальный «извлечь 4 секции» — отвергнут как более затратный/рискованный; см. ниже исходные секции как
справочный список того, ЧТО переносится, но реализуется через embedded-gating, а не отдельными файлами.)

### Новые файлы

1. **`electron-app/src/renderer/src/ui/utils/partEav.ts`** — чистые хелперы, вынесенные из `PartDetailsPage`,
   чтобы обе страницы делили одну копию: `toInputDate`/`fromInputDate`/`normalizeDimensionsValue`
   (`PartDetailsPage.tsx:83-125`), `normalizeCoreFieldValue`, `getTextLookupConfig`/`getLinkTargetTypeCode`
   (1046-1104, рефакторить чтобы принимали `entityTypes` параметром, не из state), `buildPartCoreFieldDefs()`
   (массив `desired`, 951-983). НЕ трогать `ensureAttributeDefs`/`persistFieldOrder`/`orderFieldsByDefs`
   (уже в `utils/fieldOrder.ts`) и shared-константы `STATUS_CODES`/`statusDateCode`/`PART_*_ATTR_CODE`.
2. **`PartEavFieldsSection.tsx`** — описание (`description`), дата (`purchase_date`), поставщик
   (`supplier_id` link + `supplier` text), контракт (`contract_id`), статусы (`STATUS_CODES` + `statusDateCode`).
   Props `{ partId; canEdit; onOpenCustomer?; onOpenContract?; onOpenByCode?; registerSaver }`. Сам грузит через
   `parts.get(partId)`, гонит `ensureAttributeDefs` (под `canEdit`), экспонирует `saveCore()` (diff +
   `parts.updateAttribute`, как 1677-1729). **⚠ Исключить name/article/dimensions/part_template_id/brandLinks**
   — они принадлежат базовой строке номенклатуры + подпанели E.1 (см. Риски: двойная запись).
3. **`PartAttachmentsSection.tsx`** — три `<AttachmentsPanel>` (`ui/components/AttachmentsPanel.tsx`,
   props `{title,value,canView,canUpload,scope,onChange}`), коды `drawings`/`tech_docs`/`attachments`,
   `scope={{ownerType:'part',ownerId:partId,category}}`. Props `{ partId; canView; canUpload }`. **Вложения
   коммитятся сразу на onChange** (текущее поведение) → НЕ участвуют в оркестрованном Save.
4. **`PartUsageSection.tsx`** — read-only «Где используется», логика `loadUsage` (786-920) самодостаточно.
   Props `{ partId; onOpenContract?; onOpenEngineBrand?; onOpenByCode? }`. Без участия в Save.
5. **`PartCustomFieldsSection.tsx`** — редактор произвольных EAV-полей (create-attribute-def, drag-reorder,
   text-lookup/link, `extraAttrs` DraggableFieldList 2598, очереди field/fieldorder/attribute + `createAttributeDef`).
   Props `{ partId; canEdit; canCreateParts; onOpenByCode?; registerSaver }`.

## Изменяемые файлы

- **`NomenclatureDetailsPage.tsx`** — расширить локальный props-тип (стр. 47): добавить `canViewFiles?`,
  `canUploadFiles?`, `canCreateParts?`, `onOpenCustomer?`, `onOpenContract?`, `onOpenEngineBrand?`,
  `onOpenByCode?` (опциональные → дефолт сохраняет поведение). Добавить `eavSaversRef` + `registerEavSaver`.
  Заменить Save-хендлер (447-505) на оркестратор (ниже). Смонтировать 4 секции после подпанели E.1 (после 979),
  всё под `isPartClass`. `load()` Promise.all (118-192) НЕ трогать — секции грузятся сами.
- **`App.tsx`** — `openPart` (1873-1876) делегирует в `openNomenclature(id,{from:opts?.from ?? 'parts'})`
  (покрывает PartsPage:3564, deep-link part:1963, openByCode.part:1939, PartTemplateDetailsPage:3697).
  `openNomenclature` (1909-1912) принимает `opts?:{from?:TabId}`. Добавить `nomenclatureOriginTab` (~535,
  по образцу `serviceOriginTab`). Render-сайт `<NomenclatureDetailsPage>` (3843-3853): передать новые props
  (`caps.canViewFiles/canUploadFiles/canCreateParts`, `openCounterparty/openContract/openEngineBrand/openByCode`),
  close → `setTabState(nomenclatureOriginTab ?? 'nomenclature')`. Ветку `tab==='part'` + `selectedPartId` оставить
  на 1 релиз (safety net), удалить в Stage F. **⚠ не копировать дубль-строку `setServiceOriginTab(null)` (3836-3837 баг).**
- **`PartDetailsPage.tsx`** — баннер DEPRECATED; импортировать хелперы из `partEav.ts` и рендерить те же 4 секции
  (минимум — общие хелперы, чтобы не было дублирования). Полное удаление файла + ветки `'part'` — Stage F.
- **`shared/src/domain/part.ts`** — вероятно БЕЗ изменений (типы/константы уже экспортированы).

## Save-оркестрация (один «Сохранить» коммитит всё, ошибка фазы не теряет другие)

Карточка держит `eavSaversRef = useRef<Array<()=>Promise<{ok;error?}>>>([])`; `PartEavFieldsSection` и
`PartCustomFieldsSection` регистрируют свои `saveCore` через `registerEavSaver` (effect + cleanup-дерегистрация).
`PartAttachmentsSection` (мгновенный save) и `PartUsageSection` (read-only) не регистрируются. Новый хендлер:
1. `nomenclatureUpsert(...)` — базовая строка; ошибка → status + abort.
2. если `isPartClass`: `nomenclaturePartSpecUpdate(...)` — directory_parts; ошибка → abort (сообщение 493-496).
3. если `isPartClass`: по очереди `await saver()`; первый `{ok:false}` → `Ошибка (поля детали): …` + abort
   (как break+surface 1712-1717).
4. `setStatus('Сохранено')` → `await load()`.
EAV и directory_parts — непересекающиеся хранилища (переносимые блоки не имеют directory-двойника), порядок между
ними важен только для surfacing ошибок.

## Редирект + 3 orphan'а (приоритет — целостность данных)

Редирект — в одном месте (делегация `openPart`, см. выше). **3 orphan `directory_parts` без `erp_nomenclature`**
→ `openNomenclature` дал бы «Позиция не найдена» (`NomenclatureDetailsPage.tsx:133-135`). Решение —
**backfill недостающих строк номенклатуры как pre-release прод-шаг** (не код-fallback, чтобы не прятать
рассинхрон). Порядок (после `pg_dump` + явный OK):
1. `SELECT dp.id,dp.name,dp.code FROM directory_parts dp LEFT JOIN erp_nomenclature n ON n.id=dp.id WHERE n.id IS NULL;`
2. Для каждой проверить источники `loadUsage` (brand-links/stock/movements/contracts/services/work-orders) → active vs junk.
3. Junk → удалить/инактивировать с явным OK. Active → backfill `erp_nomenclature` по id (переиспользовать Stage B
   `warehouse:backfill-directory-parts` / nomenclature-sync, или однократный идемпотентный insert by id).
4. Re-run dry-run → `orphans=0` ДО выката редиректа. Релиз-гейтинг, документируется в теле PR как B.3.

## Close-tab origin (по образцу `serviceOriginTab`)

`nomenclatureOriginTab` (~535) ← `openNomenclature(id,{from})`; `openPart` делегирует с `{from:'parts'}`; прочие
вызовы `openNomenclature` без `from` → дефолт `'nomenclature'`. Close: `setTabState(nomenclatureOriginTab ?? 'nomenclature')`.

## Риски

- **Двойная запись (HIGH):** name/article/dimensions/part_template_id/brandLinks в ДВУХ хранилищах. Кандидат-список
  `PartEavFieldsSection` ОБЯЗАН исключать их (только description/purchase_date/supplier_id/supplier/contract_id/status).
- **Orphan'ы (HIGH если пропустить):** backfill до редиректа.
- **Другие EAV-читатели (MED):** `AdminPage`, `PartTemplateDetailsPage` всё ещё читают part-EAV dimensions/template
  (Stage F) — не менять семантику записи этих кодов, только ДОБАВляем writers description/supplier/status/custom.
- **Частичный Save-fail (MED):** оркестратор abort'ит + surface'ит per-phase.
- **Dirty-guard на close (LOW):** `NomenclatureDetailsPage` не использует `registerCardCloseActions`/`requestClose`
  (в отличие от `PartDetailsPage`). E.2 не переносит prompt-on-close — отметить в PR (отдельная задача).
- **Dev-DB грабли:** dev = prod-restore (PG17 :5433 matricarmz_dev). Перед /verify: `db:migrate` + Stage B backfill;
  `nomenclatureUpsert` отвергает Save пока не очищено поле «Шаблон» (рассинхрон только в dev).

## Verification (/verify — verifier-electron + CDP deep-link)

Pre: `db:migrate` + backfill; засеять TEST-деталь с EAV description/supplier/status/custom + вложением.
Навигация — `window.matrica.app.navigateDeepLink({ nomenclatureId: id })` (round-trip, надёжнее списка).
1. Deep-link part id → лендинг на `NomenclatureDetailsPage` (не PartDetailsPage).
2. Под `isPartClass` рендерятся: описание, поставщик+дата, контракт, статусы, 3 панели вложений, usage, custom-поля.
3. Правка описания + статус-флаг + custom-поле; очистить «Шаблон» (dev) → «Сохранить» (НЕ «Сохранить в заметки»);
   «Сохранено» + round-trip на reload. Значения `<input>` читать из `.value`, не innerText.
4. Добавить custom-поле → `createAttributeDef` ок, поле появилось + значение сохранилось.
5. Загрузка в «Чертежи» → коммит сразу (без Save), персистится.
6. Force spec-error → Save surface'ит «Ошибка спецификации…», базовая правка не потеряна (рассуждение если трудно форснуть).
7. Открыть из вкладки «Детали» → close → возврат в `'parts'`; из «Номенклатуры» → close → `'nomenclature'`.
8. Caps off: вложения скрыты / panel null; create-cap off → «Добавить поле» скрыто.
9. БД: `orphans=0` после backfill, deep-link backfilled id → грузится, не «не найдена».

## Разбивка на коммиты (один релиз, ревьюабельные коммиты)

0. **План в репо:** этот файл + кросс-линк из master-плана.
1. **Извлечь хелперы:** `utils/partEav.ts`; рефактор `PartDetailsPage` на импорт. Без смены поведения.
2. **Извлечь секции:** 4 компонента; `PartDetailsPage` рендерит их. Без смены поведения part-карточки.
3. **Интеграция в номенклатуру:** props + `eavSaversRef`/`registerEavSaver` + Save-оркестратор; монтаж секций под
   `isPartClass`; App.tsx новые props. Проверяемо БЕЗ редиректа.
4. **Редирект + origin-tab:** делегация `openPart`; `openNomenclature` `from`; `nomenclatureOriginTab`;
   origin-aware close; DEPRECATED-баннер на `PartDetailsPage`.
- **Pre-release data-шаг (не коммит):** orphan-backfill на проде после `pg_dump` (см. выше), в теле PR.

Релиз: bump version + `RELEASE_WELCOME_HISTORY`; PR per Git flow; после merge — tag + выкат по §Release process;
отдельный `/verify`. PartDetailsPage удаляется в Stage F.
