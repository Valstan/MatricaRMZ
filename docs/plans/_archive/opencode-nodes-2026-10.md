# OpenCode-узлы в MatricaRMZ — локальный план реализации (PR-1–PR-2)

> **Закрыт 19.10.2026**: модуль вырезан из программы решением владельца — раздел, процессы
> узла и вся раскладка снесены ([`../batch-pain-print-and-filters-2026-10.md`](../batch-pain-print-and-filters-2026-10.md) §P2).
> План оставлен как запись о том, как это строилось и почему свернулось.

> Мандат brain: `mailboxes/MatricaRMZ/from-brain/2026-10-12-opencode-silent-deploy-plan.md`
> (канал GitHub; полный дизайн у Мозга: `docs/plans/opencode-silent-deploy.md`).
> Ответ-ack: `mailbox/to-brain/2026-10-12-opencode-mandate-accepted.md`.
> Три адаптации под наш контур — в ack-письме (§Три адаптации).

## PR-1 — раздел «OpenCode-узлы» (этот PR, ветка `feat/opencode-nodes-section`)

Суперадмин-only раздел (зеркало `access_sections`): таблица узлов
`opencode serve` (имя, адрес `http://IP:3080`, live/dead по HTTP-пробе),
реестр — локальный нетрекаемый `userData/opencode-nodes.json`.

Файлы:

- `shared/src/domain/uiSections.ts` — `opencode_nodes`: TabId, menuTabSet,
  MENU_TAB_LABELS (`OpenCode-узлы`), DEFAULT_GROUP_TABS.control (после `admin`).
- `shared/src/domain/opencodeNodes.ts` (new, pure) — типы `OpencodeNode`
  (`{name, url}`), `normalizeOpencodeNodes` (trim, схема http по умолчанию,
  порт 3080, дедуп по url, cap 50), `isOpencodeNodesWriteError`.
  + `opencodeNodes.test.ts`.
- `shared/src/ipc/types.ts` — `MatricaApi.opencodeNodes`: `list`, `save`,
  `probe` (все статусы разом).
- `electron-app/src/main/services/opencodeNodesStore.ts` (new, по образцу
  `loginMruService.ts`) — read/save `userData/opencode-nodes.json`
  best-effort + `probeOpencodeNode` через `fetchWithRetry` (`net.fetch`,
  attempts 1, timeout 5000): live = любой HTTP-ответ (включая 404),
  dead = сеть/таймаут. Без auth, без секретов в файле.
- `electron-app/src/main/ipc/register/opencodeNodes.ts` (new) — три хэндлера;
  гейт: только `superadmin` (`ctx.currentViewer()`), иначе `{ok:false}`;
  `save` в view/backup-режиме — `viewModeWriteError()`. Wire в `registerIpc.ts`.
- `electron-app/src/preload/index.ts` — мост `opencodeNodes`.
- `electron-app/src/renderer/src/ui/pages/OpenCodeNodesPage.tsx` (new, по
  образцу `WarehouseLocationsAdminPage.tsx`) — таблица (№, имя, адрес,
  статус, задержка), «Проверить», добавить/удалить, «Открыть» (shell.openExternal),
  строка-предупреждение про free-модели (§6 мандата) + подсказка пути к файлу.
- `App.tsx` — import, MENU_LABELS, availableTabs (superadmin, рядом с
  `access_sections`), render-блок. `Tabs.tsx` — TAB_VISUALS.
  `uiSearchRegistry.ts` — строка поиска (зеркало `access_sections`;
  глобальный поиск UI-записей не фильтруется по табам, страница и IPC
  гейтятся сами).
- В ACCESS_SECTION_CATALOG НЕ добавляем (как `access_sections` — вне разделов,
  только суперадмин). В PREFIX_RULES sectionGate НЕ добавляем — гейт
  ролью внутри хэндлеров строже и точнее.

Гейты: `typecheck` (shared+electron), `lint`, `vitest` touched-пакеты,
CDP e2e-smoke (локальный PG 17.5 теперь есть — гнать живо; UI-правка).

## PR-2 — silent-install (следующий, ветка `feat/opencode-silent-install`)

Новый `scripts/client-ops/opencode-harness.ps1` (`-AsLibrary`, `New-OpencodePanel`,
`-Quiet/-Verify`, по README §«Как добавить третью утилиту»): проверка наличия,
загрузка релиза + SHA256 (winget нет на PC79), конфиг
`%USERPROFILE%\.config\opencode\opencode.jsonc` (без `model`), Task Scheduler на
`opencode serve --port 3080`, запись узла в локальный `opencode-nodes.json`
этой машины. + `FILES` в `build-kaspersky-zip.mjs`, вкладка в `matrica-ops.ps1`,
сторож в `clientOpsBundle.guard.test.ts`. Пилот на PC79.

## Не делаем (решения)

- MatricaRMZ на VPS-боксы не ставим; serve там — руками/позже, не этим планом.
- Реестр узлов в git не кладём (адреса LAN в публичном репо).
- Авторизацию serve не вводим (решение владельца; вопрос про лёгкий token
  задан Мозгу в ack — если даст указатель, опция в PR-2).
