# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE (мандат brain opencode-silent-deploy: PR-1 готов, смоук PASS, PR открывается)
**Updated:** 2026-10-12 (opencode session, машина `Computer`)
**Branch:** feat/opencode-nodes-section (main = origin/main, релиз 3.74.0 на проде)
**Last released version:** **v3.74.0** на проде (+ android-v3.74.0).

## Текущая нитка

Мандат brain `2026-10-12-opencode-silent-deploy-plan` (mandate, GitHub-канал;
локальный план: `docs/plans/opencode-nodes-2026-10.md`; ack:
`mailbox/to-brain/2026-10-12-opencode-mandate-accepted.md`).

PR-1 (эта ветка): раздел «OpenCode-узлы» (суперадмин-only, зеркало
`access_sections`) — реестр `userData/opencode-nodes.json` + HTTP-проба
live/dead + страница. Код готов, гейты зелёные (typecheck -r, lint,
shared 1370 / electron 1590 тестов, CDP-смоук `cdp-opencode-nodes.mjs` —
PASS 9/9 живьём: вход суперадмином, меню, рендер, добавление, «мёртв»,
уборка). Стек погашен. Дальше: коммит → push → PR → CI → merge.

## Следующий шаг

1. PR-1: push → `gh pr create` → дождаться CI → squash-merge → pull main.
2. PR-2 (новая ветка): silent-install `scripts/client-ops/opencode-harness.ps1`
   + пилот на PC79 (см. локальный план §PR-2).

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
