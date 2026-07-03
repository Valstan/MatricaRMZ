# Рекламация MVP + вкладки карточки двигателя + повторный заезд

> После утверждения план сохраняется в `docs/plans/reclamation-mvp-2026-07.md` (правило проекта) первым шагом реализации.

## Context

Задание владельца из /zavod 2026-07-02 (идеи `zavod/011`, `zavod/012`; спека — `PENDING_FOLLOWUPS.md`). Три части: (1) рекламационный учёт на существующем двигателе (EAV, без DDL), (2) карточка двигателя «полотенце» → 4 вкладки, (3) осознанный обход запрета дублей номера для повторного заезда. Полный RMA-каркас — позже; MVP не должен ему противоречить. Прогноз/зарплата/акты/статусы — не трогаем.

## Новые EAV-атрибуты (регистрация через ensureAttributeDefs, sync — штатный AttributeValues)

Рекламация: `reclamation_flag` (bool), `reclamation_accepted_date`, `reclamation_customer_reason` (text), `reclamation_verdict` (`our_fault|customer_fault|not_confirmed`), `reclamation_verdict_date`, `reclamation_repair_status` (`accepted|cause_found|repaired|closed_no_repair`), `reclamation_shipped_date`, `reclamation_comment` (multiline text).
Повторный заезд: `repeat_arrival_flag` (bool), `number_collision_flag` (bool), `previous_arrival_id` (UUID-строка, как `contract_id`).
Коды enum — стабильные строки; русские лейблы — только в shared domain.

## Фаза 0 (PR 1): вкладки EngineDetailsPage — чистая реорганизация, без новых фич

- Локальный tab strip внутри `EngineDetailsPage.tsx` (глобальный `layout/Tabs.tsx` — app-chrome, не переиспользуем). **Ключевое решение: все вкладки остаются смонтированными, скрытие через `hidden`/`display:none`** → save-on-close (`sessionHadChanges`/`initialSnapshot`/`registerCardCloseActions`:598–622/`saveAllAndClose`:471–541), черновики и печать (`printEngineReport` читает state, не DOM) работают без изменений.
- Шапка + CardActionBar + баннер дублей — НАД вкладками (видны всегда).
- Вкладки: **Основное** (main fields 1095–1158 + движение деталей 1160–1186) · **Детали и акты** (RepairChecklistPanel 1205–1233) · **Фото и документы** (1235–1250) · **Рекламация** (пустышка с кнопкой «Принять по рекламации» — наполняется в Ф1).
- Preselect вкладки через проп (напр. `initialTab`) — для перехода «рекламация» из Ф2.
- Маркеры на ярлыках: `dirtyByTab` (сеттеры полей уже тегируют `sessionHadChanges` — добавить ключ вкладки); «заполнена рекламация» = любой `reclamation_*` непуст.
- Файлы: `EngineDetailsPage.tsx` (+ возможно маленький `EngineCardTabs.tsx`).
- Риск: mount-эффекты скрытых панелей (галерея, measure-on-mount в checklist) — если что, точечно lazy-mount-once.

## Фаза 1 (PR 2): рекламация — вкладка + синяя точка + фильтр

- Регистрация 8 атрибутов: desired-список в `EngineDetailsPage.tsx:694–740` (через `fieldOrder.ts ensureAttributeDefs`).
- Shared domain: новый `shared/src/domain/reclamation.ts` — типы/enum+лейблы, `isReclamation(attrs)`, сводка заполненности; vitest-тесты.
- Вкладка «Рекламация»: кнопка «Принять по рекламации» (ставит `reclamation_flag=true` + дату приёмки в pending-attrs, сохранение штатным батчем `saveAllAndClose`); поля: даты (UnifiedDateInput), 2 textarea, 2 select. Read-only через `disabled={!canEditEngines}`.
- Список: `listEngines` (electron `engineService.ts:202–403`) — добавить `reclamation_flag` в объявленный набор + в `EngineListItem` (`shared/src/ipc/types.ts`, conditional spread — exactOptionalPropertyTypes). `EnginesPage.tsx`: синяя точка `#2563eb` через существующий `bindingDot()` в `renderBindingCell()` (после зелёных), сортировка — additively в `bindingRank()`, фильтр-toggle «рекламационные» в `EnginesPageUiState` + useMemo:297–309.

## Фаза 2 (PR 3): повторный заезд — трёхвариантный выбор + обход гейтов + исключение из склейки

- **UI**: `EngineDuplicateHint` (EngineDetailsPage.tsx:42–101) при exact-match на создании — три действия: (а) «Рекламация» → открыть существующую карточку с `initialTab='reclamation'`; (б) «Повторный заезд» → остаёмся в новой карточке, pending `repeat_arrival_flag=true` + `previous_arrival_id=<свежайший match>`, сохранение с bypass; (в) «Коллизия номера» → `number_collision_flag=true`, bypass.
- **Обход запрета дублей (оба слоя, flag+intent — случайный дубль по-прежнему блокируется):**
  - клиентский offline-гейт `setEngineAttribute` (electron engineService.ts:582–586): опциональный `allowDuplicateNumber` в IPC setAttr + проверка, что у сущности/в батче есть один из флагов;
  - серверный гейт `adminMasterdataService.ts:1046–1054`: перед throw читать флаги сущности. **Sync-порядок:** флаги писать ДО `engine_number` в батче; серверный гейт должен видеть флаг, даже если он приходит тем же push'ем — проверить порядок применения, при необходимости упорядочить коды в клиентской очереди. Покрыть backend-тестом «флаг после номера».
- **Исключение из склейки** (`engineDedupeService.ts`): хелпер `isDedupeExempt(attrs)` (repeat_arrival_flag || number_collision_flag); применить в трёх местах: `runEngineDedupePass` (215–401, выкинуть из групп до выбора survivor), `analyzeEngineDuplicates` (476–635, не показывать/аннотировать), `mergeEngineGroup` (646–763, throw при exempt-id — защита от ручного мержа). Backend-тесты: pass пропускает флагованный, mergeGroup отклоняет, обычные дубли мержатся.
- **Все заезды + панель «прежние заезды»:** движки ищутся client-side → обе карточки видны в списке сами; пометка «архивный заезд» на старой — shared-хелпер `shared/src/domain/repeatArrival.ts classifyArrivals(list)` + vitest, использовать в listEngines/рендере. Панель в карточке (Основное): переиспользовать IPC `findDuplicateCandidates` + ссылка по `previous_arrival_id` (резолвить через `merged_into`-tombstone one-hop).

## Верификация (гейты — по каждой фазе)

1. `corepack pnpm -F @matricarmz/shared build` + `-r typecheck` + `lint`; `-F @matricarmz/backend-api test`; shared vitest (reclamation, repeatArrival).
2. CDP e2e-смоук (verifier-electron, машина rmz4val: PG 5432/`matricarmz_probe`, backend 3001, CDP 9222):
   - Ф0: открыть карточку → правка на «Основное» → переключение вкладок → закрытие сохраняет; печать = как до рефакторинга; переход из поиска.
   - Ф1: «Принять по рекламации» → синяя точка в списке → фильтр → заполнить вердикт → закрыть/переоткрыть — сохранилось.
   - Ф2: ввод существующего номера → баннер с 3 действиями → путь (б): вторая карточка, обе в списке, старая «архивный заезд»; ручной «Поиск дублей» пару не предлагает; случайный дубль без выбора — блокируется (регрессия).
   - Ролевой срез: оператор без `engines.edit` видит вкладки read-only.
3. Прогноз сборки / зарплатные отчёты не затрагиваются (новые атрибуты нигде больше не читаются).

## Ключевые файлы

- `electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx`, `EnginesPage.tsx`
- `electron-app/src/main/services/engineService.ts`
- `backend-api/src/services/engineDedupeService.ts`, `adminMasterdataService.ts`
- `shared/src/domain/reclamation.ts` (new), `shared/src/domain/repeatArrival.ts` (new), `shared/src/ipc/types.ts`
