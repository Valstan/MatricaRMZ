# OpenCode-узлы в MatricaRMZ — локальный план реализации (PR-1–PR-2)

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

## PR-2 — заменён: харнесс переписан в клиент на Electron (PR-3)

Границы владельца (12.10, после PR-2): ни слова о харнессе в программе кроме
раздела суперадмина; всё тихо и автоматически; жить в папке программы
(`userData/@matricarmz` — уже в исключениях Касперского); самообновление
в составе Матрицы.

Старый `scripts/client-ops/opencode-harness.ps1` (вкладка окна обслуживания,
видимая любому оператору) **удалён**, его публичные следы откачены
(matrica-ops, архив, `ClientOpsTab`, README). Вместо него —
`electron-app/src/main/services/opencodeHarnessService.ts`, стартующий
молча при запуске клиента (main/index.ts, рядом с watchdog heal):

- бинарь `userData/opencode/opencode.exe` (релиз GitHub API + размер/SHA256,
  распаковка штатным `tar.exe`, без powershell);
- конфиг оператора (не затираем, без `model`);
- serve дочерним процессом (`detached`, `windowsHide`, переживает клиент;
  singleton — проба `/global/health`, pid-файл, `taskkill` по порту);
- запись узла в локальный реестр (дедуп по url);
- самообновление: проверка latest не чаще раза в сутки → замена + рестарт.
- `opencodeNodes:harnessStatus/harnessStop` (тот же superadmin-гейт),
  блок статуса в разделе + кнопка «Остановить».

Почему не задача планировщика: schtasks без админа logon-задачу не даёт
(замер rmz4val 2026-08, см. watchdogHandshakeService) — а дочерний процесс
клиента не требует ни прав, ни окон.

## Единственный ручной шаг (не автоматизируется без админа)

**Правило брандмауэра** (входящий TCP 3080, иначе узел виден только локально).
Разовая команда администратора на машине узла (точный путь подставляет раздел):

```
netsh advfirewall firewall add rule name="MatricaRMZ - OpenCode serve (входящий, LAN)" dir=in action=allow protocol=TCP localport=3080 remoteip=localsubnet program="<userData>\opencode\opencode.exe" profile=domain,private
```

Касперскому — **ничего**: бинарь внутри `@matricarmz`, исключение уже есть.
Устанавливать вручную — **ничего**: клиент ставит и обновляет сам.
Провайдеров логинит владелец под учёткой оператора (`opencode auth login`).
Пилот: любая машина парка после обновления клиента + правило выше.

## Не делаем (решения)

- MatricaRMZ на VPS-боксы не ставим; serve там — руками/позже, не этим планом.
- Реестр узлов в git не кладём (адреса LAN в публичном репо).
- Авторизацию serve не вводим (решение владельца; вопрос про лёгкий token
  задан Мозгу в ack).
- Вкладку установщика в окне обслуживания не делаем (видна операторам —
  против границ); установкой занимается сам клиент.
- Правило брандмауэра кодом не создаём (нужен админ — только ручная команда).
