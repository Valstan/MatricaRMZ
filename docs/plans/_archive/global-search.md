# E — Глобальный многоуровневый поиск (Ctrl+K)

**Статус:** в работе (ветка `feat/global-search`). Утверждён владельцем 2026-06-19 (полный объём L1+L2+L3).

## Context

Owner-batch 2026-06-19 пункт **E** — крупная фича, помечена «MVP сначала, показать дизайн до стройки». Сейчас в приложении нет единой точки «найти что угодно»: у каждой страницы свой локальный поиск, а чтобы открыть деталь/двигатель/контракт надо знать раздел и дойти до него. Цель — единый overlay по Ctrl+K (command palette), который ищет по всем сущностям сразу с нарастающей глубиной и по выбору открывает карточку.

Владелец выбрал **полный объём сразу**: L1 (фильтр видимой страницы) + L2 (справочники в памяти) + L3 (новый unified серверный поиск по всем сущностям), авто-глубина + ручной переключатель уровня.

## Что переиспользуем (не пишем заново)

- **Матчинг/ранжирование:** `shared/src/domain/tieredSearch.ts` + `electron-app/.../ui/utils/search.ts` — `prepareRecordSearch(records, getId, getLabel)` (Stage-1 нормализация, мемо на массиве) и `filterPreparedRecords(search, query)` (Stage-2 скоринг per keystroke, RU↔EN раскладка, typo-fallback). Backend ILIKE: `keyboardLayoutVariants()`, `filterRowsTiered()`.
- **Навигация результат→карточка:** `resolveDeepLinkRoute(link)` (`electron-app/.../ui/utils/deepLinkRouting.ts`) маршрутизирует **все** нужные типы (`engine`, `request`, `part`, `tool`, `tool_property`, `contract`, `employee`, `product`, `service`, `counterparty`, `nomenclature`, `stock_document`, `engine_brand`, `report_preset`, `tab`). `navigateDeepLink` в `App.tsx` исполняет переход. Извлечён `navigateToRoute(route)` — общий и для чата, и для палитры.
- **Клавиатура/overlay:** `useSuggestionDropdown` (стрелки/Enter/Esc, scroll-into-view, portal-rect); portal-паттерн `GlobalInputAssist.tsx` (`createPortal(..., document.body)`, fixed, z-index tier). Глобальный Ctrl+K — новый.
- **Серверный поиск номенклатуры:** `nomenclatureSearchCondition()` (`services/warehouseService.ts`) — ILIKE по `code/sku/name/barcode` + раскладка.
- **Гейтинг:** `requireAuth` + `requirePermission(PermissionCode.X)` (`auth/middleware.ts`, `auth/permissions.ts`).

## Архитектура

Палитра — агрегатор провайдеров результатов, каждый с меткой уровня. Единый инпут, авто-глубина:

- **L1 (видимое, мгновенно):** строки, уже загруженные на активной странице, через React-context `GlobalSearchScopeContext`: `useRegisterSearchScope(rows, getId, getLabel, kind)`. Не зарегистрировалась — L1 пустой (покрытие добирается L2/L3).
- **L2 (справочники в памяти, мгновенно):** при открытии палитры один раз грузим полные списки через существующие IPC `window.matrica.*.list()` (engines, engine_brands, employees, counterparties, contracts, work_orders, services, products, tools). Кэш в клиентском сторе, обновляется по пульсу `liveDataService`.
- **L3 (сервер, debounced):** при `q.length ≥ 2` через ~250 мс — abortable-вызов `GET /search?q=` (детали/номенклатура, документы, кросс-поиск). Мерж под группой «Сервер», дедуп против L2 по `(kind,id)`.

Авто-глубина: L1+L2 сразу, L3 подмешивается после debounce. Переключатель «Авто | Эта страница | Справочники | Сервер». Результаты группируются по типу, стрелки по плоскому списку, Enter открывает, Esc закрывает.

## Файлы

- **Shared:** `shared/src/domain/globalSearch.ts` (`GlobalSearchKind`, `GlobalSearchHit`, `GLOBAL_SEARCH_KINDS`); `shared/src/ipc/types.ts` (API `search.global`).
- **Backend:** `services/globalSearchService.ts` (per-kind провайдеры, пермишен-фильтр, дедуп, раскладка), `routes/search.ts` (`GET /search` под `requireAuth`), `tests/globalSearch.test.ts`.
- **IPC:** `preload/index.ts`, `main/index.ts`, `renderer/types/matrica.d.ts`.
- **Frontend:** `ui/components/GlobalSearchOverlay.tsx`, `ui/services/globalSearchSources.ts`, `ui/context/globalSearchScope.tsx`, `App.tsx` (Ctrl+K, overlay, `navigateToRoute`, точка входа).

## Этапы

1. **Shared + рефактор навигации** — `globalSearch.ts`, извлечение `navigateToRoute`. ← текущий
2. **Backend unified `/search`** — сервис + роут + тесты + пермишен-фильтр.
3. **IPC plumbing** — preload/main/d.ts/ipc-types.
4. **Frontend overlay** — палитра, L2/L3, Ctrl+K, точка входа.
5. **L1 scope-context** на нескольких страницах.
6. **Verify + полировка** — гейты + CDP-smoke + скриншоты.

## Verification

- `corepack pnpm -r typecheck` + `lint`.
- `corepack pnpm -F @matricarmz/backend-api test` (вкл. `globalSearch.test.ts`); `exactOptionalPropertyTypes` — optional через conditional-spread.
- CDP e2e-smoke (`verify`): Ctrl+K → запрос (`TEST-PART`, `TEST-001`) → группы → Enter → открылась карточка. Скриншоты.
- Перф: L2 один раз на открытие (кэш + пульс), L3 debounced+abortable, per-kind LIMIT + score-фильтр.
