# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE (мандат brain opencode-silent-deploy: PR-1 merged, PR-2 в работе)
**Updated:** 2026-10-12 (opencode session, машина `Computer`)
**Branch:** feat/opencode-silent-install (main = origin/main)
**Last released version:** **v3.74.0** на проде (+ android-v3.74.0).

## Текущая нитка

PR-1 merged (#1307, `34a1cc43`): раздел «OpenCode-узлы» на проде кода (не релиз).

PR-2 (эта ветка): silent-install `scripts/client-ops/opencode-harness.ps1`
(релиз GitHub + SHA256, задача планировщика от имени оператора, брандмауэр
LocalSubnet, запись в реестр узлов) + вкладка «OpenCode-узел» в окне
обслуживания + архив + типы. Флаги serve сверены с веб-доками 12.10
(`--port/--hostname`, `/global/health`). Код готов, гейты зелёные
(typecheck -r, typecheck:test, lint, shared 1370 / electron 1590, сторож 6/6,
парсер PS 5.1 обоих .ps1 чист, `-Verify` живьём: «не стоит», exit 0, сборщик
архива: 8 файлов). Дальше: коммит → push → PR → CI → merge → пилот на PC79
(руками владельца: исключение → окно → вкладка → «Установить»).

## Следующий шаг

1. PR-2: push → `gh pr create` → CI → squash-merge → pull main.
2. Пилот на PC79 — ход владельца (см. README §opencode-harness).
3. Ответ Мозга про лёгкий token для serve (не блокер; ack уже у него).

## Контекст

- Бэкенд стенда поднят (sh_130d0eae…, `matricarmz_dev`, `/health` — проверить).
- Три адаптации мандата (deploy-контур наш, реестр вне git, раздел только
  суперадмину) — в ack-письме; вопрос Мозгу про лёгкий token serve — там же.
- Stash пуст. Чужие локальные ветки (`fix/android-ci-debug-apk-non-tag`,
  `release/v3.8.0`, `release/v3.9.0`) не трогал.

## Что не сработало

- **Письма Мозга нет в локальном клоне сразу после пуша.** Первая проверка
  показала «писем нет», файл `2026-10-12-opencode-silent-deploy-plan.md`
  появился в GitHub-канале минутами позже. Урок: при «Мозг говорит отправил,
  а у меня нет» — перечитать GitHub-канал напрямую, не спорить.
- **После `install-app-deps` electron-тесты краснеют ABI-конфликтом (148 vs 137).**
  Чинят НЕ `pnpm rebuild`/`pnpm install` (молчат и ничего не делают), а прямой
  `node-gyp rebuild` в каталоге пакета (MSVC теперь есть): оба
  better-sqlite3*. Проверено: `mc-node-abi-ok`, сьют 1590 зелёный.
- **`python3`/`pnpm exec pnpm` в PowerShell этой машины отсутствуют.**
  `python` есть; бинари — `.\node_modules\.bin\*.CMD` с workdir пакета.
  Записано в профиль Computer.
- **Seed на снапшоте без env падает `28P01` (auth).** `dev:seed-fixtures`
  требует PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD в env вызова;
  с ними `valstan`/`valstan-dev` встал суперадмином стенда.

## Открытые вопросы для пользователя

- Ротация SSH PC79 ≤ 2026-11-26 (календарь PENDING).
- M102 dry-run/apply — ждёт окна владельца.
- Ответ Мозга про лёгкий token для serve (не блокер PR-1).
