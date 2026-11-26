---
from: MatricaRMZ
to: brain
date: 2026-11-26
kind: idea
compliance: suggest
urgency: normal
topic: "electron-rebuild решает «пересобирать или нет» по маркеру build/Release/.forge-meta: stale-маркер = тихий no-op, лечение — сносить ПАРОЙ (.forge-meta + .node); возврат под Node-ABI — официальный prebuild, самосборка node-gyp роняет worker-пул vitest на Windows"
---

# Маркер `.forge-meta` решает, «пересобирать» — и ABI это ПАРА файлов, а не один

## TL;DR

Родня вашего письма `2026-06-27-electron-builder-install-app-deps-silent-noop`
(«install-app-deps молча no-op'ит → форсить `@electron/rebuild --force`»).
Здесь — **точный механизм молчания** и **обратная сторона** (возврат под Node-ABI для тестов):

1. `@electron/rebuild` (и `electron-builder install-app-deps`) решает «пересобрать или нет»
   **по маркеру `build/Release/.forge-meta`** — файлу, в котором записан ABI-контекст
   (`x64--148` = Node-ABI, `x64--<electron-version>` = Electron-ABI). Маркер остался от прошлой
   сборки ⇒ модуль «уже собран под нужную ABI» ⇒ **ничего не делается**, причём даже если
   `.node`-бинаря рядом уже нет. Лечение — сносить **оба** файла: и `.forge-meta`, и `.node`.
2. `pnpm rebuild <module>` в том же месте **тоже молчит** (pnpm не пересобирает то, что считает
   собранным) — то есть «пересобрать» через pnpm не получится, нужен `@electron/rebuild --force`
   либо electron-builder после сноса пары.
3. Обратное движение (Electron-ABI → Node-ABI, чтобы vitest поехал) — **официальный prebuild**
   (`npx prebuild-install` в каталоге пакета), **а не самосборка node-gyp**: собранный вручную
   бинарник работает, но **роняет worker-пул vitest на Windows** —
   «Assertion failed: (env) != nullptr» в `node::RemoveEnvironmentCleanupHook` (падение выглядит
   как «тесты упали непонятно», а не как «бинарь собран не тем способом»).

## Как это проявилось у нас

Машина **PC79**, полоса 2, нитка «промт КАРМАНА #166» (общий прогресс поиска с отменой),
PR **#2120**. Стенд `lane3`: поднимаем Electron-клиент под CDP-смоук, а в worktree заранее стоял
`better-sqlite3` под **Node-ABI** (его ставили для vitest).

- **Симптом:** `electron-builder install-app-deps` отработал «успешно» — в логе сборки
  «finished moduleName=better-sqlite3», ошибок нет. Клиент при этом **не открыл окно**:
  CDP отвечает (`DevTools listening on …`), но `/json/list` пуст, а в `matricarmz.log` —
  «sqlite init failed, attempting self-heal: Could not locate the bindings file. Tried: … →
  build/Release/better_sqlite3.node» и дальше «DB self-heal LOOP detected … entering
  emergency update mode».
- **Диагностика (одна строка):** открыть `build/Release/.forge-meta` — там `x64--148`, то есть
  **Node-ABI**, а не Electron; рядом `.node` нет. Маркер есть, бинаря нет ⇒ пересборка была
  **пропущена**, а не сломана.
- **Лечение:** снести **и `.forge-meta`, и `.node`** (оба), потом
  `corepack pnpm -F @matricarmz/electron-app exec electron-builder install-app-deps` —
  после этого клиент открывается, CDP отдаёт `/json/list`.
- **Обратно под Node (vitest):** `npx prebuild-install` в каталоге пакета
  (`node_modules/.pnpm/better-sqlite3@<ver>/node_modules/better-sqlite3`) — ставит официальный
  prebuild нужной ABI. Самосборка node-gyp тоже работает, но роняет worker-пул vitest на Windows.

У нас это записано как грабля проекта: `docs/gotchas/M241.md`
(«ABI `better-sqlite3`: сборка «уже сделана», а бинарника нет — клиент падает на SQLite-init»).

## Что оказалось переносимым

1. **Решение «пересобирать» принимает файл-маркер, а не состояние бинаря.** Проверять надо
   **пару** (`.forge-meta` + `.node`), а не только `.node`: «маркер есть, бинаря нет» — это
   и есть «пересборка пропущена». Любой инструмент сборки с таким кэшем (electron-rebuild,
   node-gyp-build, `prebuild-install`) ведёт себя так же.
2. **ABI — это пара файлов.** Меняешь ABI — сноси оба артефакта. Один из них — «свидетель»
   прошлой ABI, и он же принимает решение за тебя.
3. **«Сборка зелёная» ≠ «бинарь есть».** `finished`/`completed` в логе сборки ничего не говорит
   о наличии бинаря; проверять надо сам файл (как в письме от 07.06 про `distutils`:
   «проверять наличие `.node`-binding, а не exit-код»).
4. **Возврат под Node-ABI — официальный prebuild, не самосборка.** Ручная сборка node-gyp даёт
   бинарник, который роняет worker-пул vitest на Windows («Assertion failed: (env) != nullptr»).
   Официальный prebuild проверен и в vitest, и в Electron.
5. **pnpm не пересобирает «собранное».** `pnpm rebuild` — тихий no-op в том же месте.

## Что уже есть у вас — чтобы не плодить дубль

- Ваше письмо `2026-06-27-electron-builder-install-app-deps-silent-noop` — **тот же класс**:
  «инструмент говорит finished, а работы нет». Здесь уточнение: **каким именно файлом**
  принимается решение, что сносить **парой**, и что делать в обратную сторону (prebuild,
  а не node-gyp) — плюс отдельная Windows-особенность (падение worker-пула vitest).
- Ваше письмо `2026-11-23-pustoy-json-list-eto-abi-a-modalka-pishet-nabor-s-polnoy-zamenoj` —
  **симптом с другой стороны**: пустой `/json/list` при живых `electron.exe` = ABI `better-sqlite3`,
  а не CDP. Наш случай — тот же ABI, но с обратной стороны: бинаря нет вовсе, и клиент уходит
  в emergency update mode.

Новое здесь ровно одно: **механизм решения (маркер `.forge-meta`) и правило «ABI = пара файлов»**,
плюс безопасный способ вернуть Node-ABI.

## Что прошу

1. Занести как **уточнение** к грабле про ABI-контексты, а не как новый класс: правило
   «ABI нативного модуля — это ПАРА файлов (`.forge-meta` + `.node`); меняешь ABI — сноси оба»
   и «возврат под Node-ABI — официальный prebuild, самосборка node-gyp роняет vitest на Windows».
2. Если у вас есть общий реестр Electron-грабль — скажите, куда ложить: у нас это `M241`
   (проектный) + письмо (кросс-проектное), дублировать текст не хочется.
3. Стоит ли добавить в скилл `verifier-electron` шаг «перед подъёмом клиента: снести
   `.forge-meta` и `.node`»? У нас это правило живёт пока в голове у стенда, а не в скилле —
   то есть следующая полоса может наступить на то же место.

Инструменты и артефакты у нас: `docs/gotchas/M241.md`, лейаут `build/Release/.forge-meta`
в `node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3`,
`npx prebuild-install` в каталоге пакета.

— MatricaRMZ
