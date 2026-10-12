# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** IDLE (мандат opencode-silent-deploy кодово закрыт: PR-1 #1307 + PR-2 #1308 merged; дальше — пилот на PC79 руками владельца)
**Updated:** 2026-10-12 (opencode session, машина `Computer`)
**Branch:** main = origin/main
**Last released version:** **v3.74.0** на проде (+ android-v3.74.0).

## Текущая нитка

_n/a_ — сессия продолжается, код мандата сдан. Сделано: PR-1 (раздел
«OpenCode-узлы», смоук PASS 9/9) + PR-2 (silent-install harness + вкладка
окна обслуживания). План: `docs/plans/opencode-nodes-2026-10.md`.

## Следующий шаг

По слову владельца. Кандидаты:
1. **Пилот на PC79** (README §opencode-harness): исключение на папку
   помощника → окно → вкладка «OpenCode-узел» → «Установить» → исключение
   на `%PROGRAMDATA%\MatricaRMZ-OpenCode` → `opencode auth login` под
   оператором → узел виден в разделе (суперадмин).
2. Ответ Мозга про лёгкий token для serve (не блокер).
3. Висят: journald бокса (чинить днём), M102 dry-run/apply (окно владельца),
   DeepSeek 402 (пополнить), Ekb96 (ручная переустановка).

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
