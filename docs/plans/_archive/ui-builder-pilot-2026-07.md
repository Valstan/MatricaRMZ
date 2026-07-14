# Пилот UI-конструктора — план реализации

## Context

Владелец выбрал старт пилота конструктора экранов (уровень 1, без нейронки) по плану `docs/plans/ui-builder-modules.md`. Решения владельца (2026-07-14): **авторы — любой оператор**, **первый кейс — дашборд-навигатор**, **хранение — общезаводское** (спеки видны всем через sync, с правами). Это расширяет исходный набросок: вместо per-user local KV — EAV+sync и section-права.

Цель: оператор собирает экран из блоков (заголовок/текст/кнопка-переход/список), сохраняет в секцию доступа, экран доезжает sync'ом до всех клиентов и открывается вкладкой; просмотр/редактирование гейтится существующей моделью section access.

После одобрения план копируется в `docs/plans/ui-builder-pilot-2026-07.md` (конвенция репо), исходный `ui-builder-modules.md` помечается ссылкой.

## Ключевые решения

1. **Хранение — EAV entity type `ui_screen`** (без DDL, едет существующим sync). Атрибуты: `name`, `spec_json` (строка), `section_id` (AccessSection), `created_by` (login), `updated_at`. Seed через `ensureEntityType('ui_screen', 'Экраны оператора')` в `electron-app/src/main/database/seed.ts`.
   - ⚠️ **Не через `admin.entities.*`** — тот bridge гейтится `masterdata.edit` (`main/ipc/register/admin.ts:147-163`), у операторов его нет. Делаем свой IPC-домен `uiScreens:*` (main вызывает `entityService.setEntityAttribute` напрямую + свой section-чек).
   - `ledgerAuthzGuard`: у `ui_screen` нет записи в `LEDGER_SECTION_BY_ENTITY_TYPE` → fail-open, для пилота приемлемо (данные не чувствительные; отметить комментом).
2. **Права: экран принадлежит одной AccessSection**, выбирается при сохранении из секций, где автор — editor. Просмотр = `canViewSection`, правка = `canEditSection` (`shared/src/domain/sectionAccess.ts:212-235`, superadmin bypass). Чек в IPC-хендлерах (переиспользовать membership-хелпер из `main/ipc/sectionGate.ts`) + фильтр списка в renderer. **Новую секцию "ui_screens" НЕ заводим** (дорогая рябь по каталогу/бэкфиллам); вкладка «Мои экраны» вне секций (прецедент — `changes`/`drafts`); редактор доступен тем, у кого editor хотя бы в одной секции.
3. **Спек-схема** — `shared/src/domain/uiSpec.ts` c `version: 1`, tolerant parse (двойное EAV-кодирование — паттерн `parseSectionMembership`):
   - Блоки: `heading | text | button{label,intent} | list{widget,limit?}`.
   - Интенты (allowlist): `navigate_tab{tabId}` (валидация по MenuTabId), `open_report{presetId?}`.
   - Исполнение интентов — через runtime-объект из App.tsx (`setTab`/v2 `setV2ActiveListTab`/`openSecondaryCard`); `navigate_tab` уважает `sectionGatedTabs` зрителя — недоступная кнопка рендерится disabled с тултипом.
4. **List-виджеты: ровно 2, read-only** — `recent_engines` (`engine:list`) и `my_work_orders` (`workOrders:list`). Каналы уже section-гейтятся (`sectionGate.ts` PREFIX_RULES) → при отказе виджет показывает «нет доступа к данным», не падает. Строки открывают карточки существующими openers.
5. **Вкладки: closed-union паттерн как у карточек.** Два новых TabId в `ui/layout/Tabs.tsx`: `user_screens` (меню) + `user_screen` (detail, `PARENT_TAB` → `user_screens`); в App.tsx — `selectedUserScreenId` (как `selectedEngineId`), два case в `renderTabContent`. V2: `user_screens` в `V2_LIST_TABS` (`shellV2/v2ButtonCatalog.ts`), открытие экрана через `openSecondaryCard`. Никаких динамических TabId.
6. **Редактор: только вертикальный список блоков.** dnd-kit sortable (образец `shellV2/ButtonPanel.tsx`), палитра из 4 блоков, панель свойств выбранного блока, живой превью тем же SpecRenderer (интенты в превью — no-op + toast), сохранение (имя + выбор секции), rename, delete.

## PR-разбивка

### PR1 — `feat/ui-builder-spec-renderer`: типы + рендерер + intent-реестр (без persistence)
Создать:
- `shared/src/domain/uiSpec.ts` — типы, `sanitizeUiSpec` (tolerant, дропает неизвестные kind/intent), allowlists; тесты `uiSpec.test.ts` (double-encoded строка, unknown-kind).
- `electron-app/src/renderer/src/ui/uiBuilder/SpecRenderer.tsx` — чистый `({spec, runtime}) => JSX`; `runtime = { runIntent, canRunIntent, listData }`.
- `electron-app/src/renderer/src/ui/uiBuilder/intentRuntime.ts` — сборка runtime из колбэков App + `sectionGatedTabs`; ветвление v1/v2 shell.
- `electron-app/src/renderer/src/ui/uiBuilder/widgets.tsx` — 2 виджета поверх `window.matrica`, denial-tolerant.
Изменить: `shared/src/index.ts` (export).

### PR2 — `feat/ui-builder-editor`: persistence + редактор
Создать:
- `electron-app/src/main/ipc/register/uiScreens.ts` — `uiScreens:list/get/save/delete` (list фильтруется по membership на main-стороне; save/delete требуют editor целевой секции; delete — soft). Через `ensureEntityType` + `setEntityAttribute` (`syncStatus:'pending'` → syncService раздаёт).
- `electron-app/src/renderer/src/ui/pages/ScreenEditorPage.tsx` — палитра, dnd-kit canvas, панель свойств, превью, save/rename/delete.
Изменить: `preload/index.ts` (bridge `uiScreens`), `shared/src/ipc/types.ts`, регистрация IPC, `seed.ts` (`ensureEntityType('ui_screen', …)`).

### PR3 — `feat/ui-builder-menu`: интеграция в меню + verify
Изменить:
- `ui/layout/Tabs.tsx` — TabIds, PARENT_TAB, место в `DEFAULT_GROUP_TABS`, `TAB_VISUALS`, labels.
- `ui/App.tsx` — lazy-страницы, `selectedUserScreenId`, cases в `renderTabContent`, wiring intent runtime.
- `shellV2/v2ButtonCatalog.ts` — `user_screens` в `V2_LIST_TABS`.
Создать: `ui/pages/UserScreensPage.tsx` — список экранов (по membership), открытие вкладкой, «создать» → редактор.
Приёмочный артефакт: собрать дашборд-навигатор (кнопки-переходы + оба виджета), сохранить в секцию.

## Риски / грабли
- **`masterdata.edit`-гейт** — главный капкан; записи только через свой `uiScreens:*`.
- **EAV double-encoding** `spec_json` после sync-круга — tolerant parse обязателен (≤2 прохода decode).
- **Fan-out**: атрибуты `ui_screen` синкаются на все клиенты независимо от секции (field-level scoping в sync нет) — enforcement только UI+IPC; данные не чувствительные, зафиксировать в шапке `uiSpec.ts`.
- **v1/v2 shell** — разные семантики навигации, runtime ветвится.
- **exactOptionalPropertyTypes** — conditional spread для `limit?`/`presetId?`.
- Кэш membership (15s TTL в sectionGate) — список экранов может отставать от отзыва прав на секунды; ок.

## Верификация
- Каждый PR: build `shared`+`ledger` → `corepack pnpm -r typecheck` + `lint` → `corepack pnpm -F @matricarmz/backend-api test` + тесты shared.
- PR3 — CDP-смоук (verifier-electron; backend :3001, CDP :9222, PG `matricarmz_probe`): логин оператором с editor-секцией → «Мои экраны» → создать экран (заголовок + кнопка на `engines` + виджет) → сохранить в секцию → переоткрыть из списка вкладкой → кнопка-переход открывает список двигателей (v2) → пользователь БЕЗ секции не видит экран в списке, кнопка на закрытый таб — disabled. Смоук `_smoke-ui-builder.mjs` (gitignored), идемпотентный (ensureShell, уникальные имена per-run).
- Гейты зелёные → авто-мерж по PR-flow; релиз — отдельным решением владельца (`/reliz`).
