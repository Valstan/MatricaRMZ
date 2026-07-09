# V2 UI Shell («Резиновый») — альтернативный 3-колоночный интерфейс с переключателем v1/v2

> После одобрения план копируется в `docs/plans/ui-shell-v2.md` (правило проекта — планы видны с других машин).

## Context

Владелец хочет второй вариант интерфейса клиента с переключателем «старый/новый» (вдруг новый кому-то не понравится). V2 = 3 вертикальные колонки: **(1) панель кнопок** (оператор сам компонует/перетаскивает/закрепляет), **(2) колонка списков** (открывается при нажатии кнопки-списка; скрыта, если списка нет), **(3) рабочая область карточек** (самая большая; несколько открытых карточек). Колонки резиновые (ресайз), сворачиваемые в иконку-полоску, переставляемые местами; панель кнопок можно «прикалывать» поверх контента (оверлей внутри окна — решено с владельцем; настоящее always-on-top Electron-окно отклонено как дорогое, в бэклог). Мультикарточность — вкладки открытых карточек (до 3) + режим «2 рядом» (сплит), НЕ свободный MDI (решено с владельцем).

**Объём этого захода: Фазы 1+2** (каркас + настраиваемая панель кнопок). Фазы 3–4 — следующими нитками.

Текущая архитектура (разведано): `App.tsx` (4672 строки) — один `tab`-стейт, страницы лениво через `import.meta.glob`, карточки = detail-табы (`CARD_DETAIL_TABS` App.tsx:480, `CARD_PARENT_TAB` :459), одна карточка за раз через ~25 скалярных `selectedXId` (:561-593), dirty-close через ЕДИНСТВЕННЫЙ `cardCloseActionsRef` (:676, 725-856). Меню — `layout/Tabs.tsx` (группы→табы, `TabsLayoutPrefs`, permission-gating через `availableTabs`). Персист per-user prefs — `window.matrica.settings.uiGet/uiSet` → main `ipc/register/settings.ts:141-177` (KV-блоб по userId, образец `UiTabsLayout`). DnD/сплиттер-библиотек НЕТ; стили — plain CSS (`global.css`) + CSS-переменные (light/dark/warm).

## Ключевые решения

- **V2 — соседний shell, не форк.** App.tsx продолжает владеть стейтом/данными/правами/оверлеями; условный рендер тела: `{shell==='v1' ? <существующий JSX без изменений> : <V2Shell/>}`. Страницы/карточки — те же lazy-компоненты в обоих shell'ах.
- **Переключатель:** `uiShellVersion: 'v1'|'v2'` в существующем per-user `ui:prefs` блобе. Дефолт `'v1'` — ни у кого ничего не меняется. Кнопка переключения в v1 (меню Tabs) и в v2 (подвал панели кнопок), переключение вживую без рестарта.
- **Библиотеки:** `react-resizable-panels` (ресайз/коллапс/onLayout-персист, ~12 kB) + `@dnd-kit/core`+`@dnd-kit/sortable` (сортировка кнопок, headless, дружит с plain-CSS). Больше ничего.
- **«Поверх окон»:** пин панели кнопок как оверлей ВНУТРИ окна программы (z-order поверх колонок). Настоящее Electron always-on-top окно — в бэклог PENDING_FOLLOWUPS.
- **exactOptionalPropertyTypes:** дефолты V2Prefs — явными спредами, никаких `field: undefined`.

## Модель состояния (shared/src/domain/uiShellV2.ts — новый)

```ts
export type UiShellVersion = 'v1' | 'v2';
export interface OpenCard { instanceId: string; kind: TabId; entityId: string; originTab: TabId; title?: string }
export interface V2ColumnState { sizePct: number; collapsed: boolean }
export interface V2Prefs {
  columnOrder: ('buttons'|'lists'|'workspace')[];
  columns: Record<'buttons'|'lists'|'workspace', V2ColumnState>;
  buttonLayout: { order: string[]; pinned: string[]; hidden: string[] };  // ids = TabId
  buttonPanelPinned: boolean;          // оверлей-«поверх»
  workspaceMode: 'single'|'tabs'|'split2';
}
```

Рантайм-стейт (renderer, контекст `V2ShellState`): `activeListTab: TabId|null` (null → колонка 2 скрыта), `openCards: OpenCard[]` (в Фазах 1–2 длина ≤1), `focusedCardId`.

**Dirty-close (задел под Фазу 3, безопасно для v1):** `cardCloseActionsRef` → `Map<instanceId, CardCloseActions>`; v1-путь всегда пишет под ключом `'v1-single'` (поведение байт-в-байт). Карточки НЕ правятся: `CardInstanceContext` подставляет instanceId, сигнатура `registerCardCloseActions` сохраняется.

~25 `selectedXId` остаются для v1. V2 их не использует: `openCards[].entityId` идёт напрямую пропом в detail-страницу. Хелперы `openEngine(id)` и т.п. получают ветку: `if (v2) v2.openCard(kind, id, originTab) else <как было>` — deep links и уведомления работают в v2 автоматически.

## Новые файлы

Все в `electron-app/src/renderer/src/ui/shellV2/`:

| Файл | Назначение |
|---|---|
| `V2Shell.tsx` | Корень: `PanelGroup` из 3 панелей по `columnOrder`, ресайз/коллапс-в-иконку, debounce-персист → `uiSet` |
| `V2ShellState.tsx` | Контекст+reducer: openCards/focus/activeListTab; `openCard/closeCard/focusCard` |
| `ButtonPanel.tsx` | Колонка 1: кнопки из `availableTabs` (permission-gating как у Tabs), Фаза 2 — dnd-kit sortable + pin/hide + пин-оверлей |
| `ListsColumn.tsx` | Колонка 2: хостит активную list-страницу (тот же lazy-map); скрыта при `activeListTab === null` |
| `CardWorkspace.tsx` | Колонка 3: в Фазах 1–2 одна карточка; каркас под вкладки |
| `CardHost.tsx` | Обёртка карточки: `CardInstanceContext.Provider` + `key={instanceId}` + error boundary |
| `v2Prefs.ts` | load/save/merge/defaults V2Prefs через `settings.uiGet/uiSet` |
| `v2ButtonCatalog.ts` | TabId → {label, icon, group} из тех же метаданных, что у Tabs.tsx (`GROUP_VISUALS`/`TAB_VISUALS` — извлечь в shared-модуль renderer'а при необходимости) |
| `shellV2.css` | Все v2-стили отдельным файлом; `global.css` не трогаем |

Новый shared: `shared/src/domain/uiShellV2.ts`.

## Правки существующих файлов

| Файл | Что |
|---|---|
| `ui/App.tsx` | (a) загрузка `uiShellVersion`; (b) обернуть существующее тело в `{shell==='v1' ? … : <V2Shell/>}` — ОБОРАЧИВАНИЕ, не вынос (минимальный дифф); (c) ветка v2 в `open*`-хелперах; (d) `cardCloseActionsRef` → Map + шим `'v1-single'`; (e) прокинуть `availableTabs`/page-map в V2Shell. Оверлеи (GlobalSearchOverlay, чаты, welcome) остаются над обоими shell'ами |
| `ui/cardCloseTypes.ts` | Типы реестра + `CardInstanceContext` |
| `ui/layout/Tabs.tsx` | Пункт «Попробовать новый интерфейс» |
| `main/ipc/register/settings.ts` | Принять/провалидировать V2Prefs в per-user блобе (копия паттерна UiTabsLayout :141-177) |
| `electron-app/package.json` | + `react-resizable-panels`, `@dnd-kit/core`, `@dnd-kit/sortable` |

## Фазы

**Фаза 1 — каркас (этот заход).** Переключатель + персист; V2Shell с 3 колонками (ресайз, коллапс-в-полоску, ширины персистятся); статичная ButtonPanel по группам Tabs с гейтингом прав; ListsColumn со list-страницами; одна карточка в workspace с существующим dirty-close (фиксированный instanceId); кнопки переключения в обе стороны.

**Фаза 2 — настраиваемая панель кнопок (этот же заход).** dnd-kit sortable (перетаскивание кнопок вверх/вниз), pin/unpin (закреплённые сверху), hide, персист `buttonLayout`; свёрнутая иконко-полоска с тултипами; `buttonPanelPinned` оверлей-режим («поверх»).

**Фаза 3 (следующая нитка).** Мультикарточность: `openCards` до 3, вкладки, сплит 2 рядом, per-card dirty-close Map, «открыть тот же объект дважды → фокус на существующей». Аудит singleton-допущений detail-страниц (grep `keydown` в pages/, draft-ключи, GlobalSearchOverlay).

**Фаза 4 (потом).** Перестановка колонок drag'ом заголовков (`columnOrder`), session restore открытых карточек, полировка тем light/dark/warm, перф (memo CardHost).

## Риски

- Хирургия App.tsx → минимизируется оборачиванием (дифф к v1-логике ≈ 0) и шимом close-ref.
- Списки в колонке 2 остаются смонтированы при открытой карточке (в v1 размонтировались) — следить за поллингом (`pollWhenVisible` уже есть в репо), паузить при коллапсе колонки.
- Две карточки одного вида (Фаза 3) — `key={instanceId}`, аудит draft/localStorage-ключей.

## Верификация (verifier-electron, CDP)

1. Гейты: build shared+ledger → `pnpm -r typecheck` + lint → backend tests.
2. CDP-смоук v2: переключиться в v2 → кнопка «Двигатели» → колонка списков открылась → открыть TEST-001 → карточка в колонке 3 → грязная правка → попытка переключения → dirty-prompt → ресайз/коллапс колонок → рестарт клиента → ширины/раскладка персистнулись.
3. Фаза 2: перетащить кнопку (pointer events через CDP), pin, рестарт → порядок сохранён; второй пользователь не затронут.
4. Регрессия v1: существующий v1-смоук без изменений (переключатель на дефолте `'v1'`).

## PR-план

Ветка `feat/ui-shell-v2-phase1-2`, PR по гейтам, squash-merge. Релиз — отдельным осознанным шагом (`/reliz`), не в этой нитке автоматически.
