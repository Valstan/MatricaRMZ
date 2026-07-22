# V2 shell — настоящий сплит «2 рядом» (две карточки одновременно)

## Context

Владельцу нужен настоящий сплит: две карточки смонтированы РЯДОМ одновременно, каждая
живая и редактируемая (не вкладки-переключение из Фазы 3, а обе видны сразу). База —
`openCards` из Фазы 3 (PR #128, ждёт мержа — GitHub был недоступен). Ветка `feat/ui-shell-v2-split`
временно на базе phase3; после мержа #128 — rebase на main.

Разведка (`renderTabContent`): 16 из 17 карточек монтируются по одному id (сами грузят
данные); **только `engine`** требует готовый объект `EngineDetails` (не self-load) → для второй
панели его нужно грузить отдельно. Доп-пропсы: `employee` → `me`, `product`/`service` →
`ownerType`/`typeCode`/`title`, `request` → user-context. Dirty-close регистрируют: engine,
request, work_order, contract, counterparty, employee, product, service, engine_brand, tool,
tool_property (6 видов — нет).

## Подход (низкий риск: primary не трогаем)

- **Primary-панель** (левая) — как сейчас: App-скаляры + `renderTabContent(workspaceTab)`,
  единый `cardCloseActionsRef` под ключом `primary`. Ноль изменений в рабочем пути.
- **Secondary-панель** (правая) — НОВЫЙ параметризованный `renderCardPane(kind, entityId)`:
  switch по видам, монтирует detail-страницу по произвольному id. `engine` — грузит
  `secondaryEngineDetails` отдельным IPC; остальные — по id. Свой `secondaryCloseRef`.
- Сплит-раскладка внутри 3-й колонки: два под-пейна с резайз-сплиттером; у secondary шапка
  с заголовком + ✕. Кнопка «⑃ разделить» на вкладках Фазы 3 закрепляет карточку как secondary.
- `workspaceMode: 'split2'` в V2Prefs (уже есть) — включён, пока есть secondary.

## Риск (флаг): общесистемная машина сохранения

Backstop dirty-close (app-close / beforeunload) сейчас смотрит одну карточку. Со сплитом
их две. Интеграция:
- Закрытие/замена secondary → dirty-guard по `secondaryCloseRef` (та же модалка, target=secondary).
- App-close / beforeunload → проверять ОБЕ панели; при двух грязных — модалка «Сохранить все /
  Отклонить все» (рефактор `renderCardCloseModal`+`finalizeCardClose` на список грязных панелей).
- Смена primary (клик по списку/вкладке) — как сейчас (guard primary), secondary остаётся.

Это единственное место, трогающее app-wide safety. Всё остальное аддитивно.

## Файлы

- `App.tsx`: state `v2SecondaryCard`/`secondaryEngineDetails`/`secondaryCloseRef`;
  `openSecondary`/`closeSecondary`/`registerSecondaryCardCloseActions`/`renderCardPane`;
  расширить beforeunload+closeCardSession(appClose); рефактор close-модалки на N панелей.
- `shellV2/V2Shell.tsx`: сплит-раскладка workspace (два под-пейна + сплиттер), проброс
  secondary + onSplit/onCloseSecondary; «⑃» на вкладках.
- `shellV2/shellV2.css`: стили под-пейнов.

## Верификация (CDP)

- Открыть карточку A (primary) → «⑃ разделить» карточку B → обе видны рядом, обе редактируемы.
- Правка в B → ✕ secondary → dirty-guard (Сохранить/Не сохранять) по B, primary не тронут.
- Правка в A и B → app-close путь (эмуляция) → «Сохранить все/Отклонить все».
- Сменить primary из списка при живом secondary → secondary остаётся.
- Регрессии: v2-cards (Фаза 3), v2-shell (1+2), v1 engine-tabs — зелёные.

## Ограничение (осознанное)

Начинаем с 2 панелей (primary+secondary). 3-я панель / свободный MDI — не в этом заходе.
