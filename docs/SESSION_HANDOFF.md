# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE (нитка: план `client-stability-and-ai-2026-10.md`, B7 готов локально, ветка `feat/stage-same-day-priority-b7`)
**Updated:** 2026-10-13 (opencode session, машина `PC79`)
**Branch:** feat/stage-same-day-priority-b7 (B7; влить в main отдельным PR)
**Last released version:** **v3.76.0** на проде (+ android-v3.76.0).

## Текущая нитка

B7 готов локально (план `docs/plans/client-stability-and-ai-2026-10.md`):
авто-приоритет этапов в одни сутки. Порядок от владельца 13.10.2026
(приход → входной контроль → разборка/дефектовка → ремонт деталей → укладка →
сборка → обкатка → выходной контроль → отгрузка → приемка) = sortOrder реестра.
Чинены три сортировки, шедшие по голым мс внутри дня: лента истории
(`repairHistoryFromOperations`), единая лента карточки (`buildEngineHistoryFeed`
→ `sortFeedItems`) и `sortStagesByDate`. Неэтапные записи — по-прежнему по моменту.
Тесты: +4 в shared (лента, фид, сортировка). Гейты локально: shared 1380,
electron-app 1648, backend-api 1140, typecheck electron-app чисто.
Открытое дальше: B8 (звезда), C9 (автозапуск), D10 (ИИ-узел) + известные задачи
(пилот узла PC79; M102; DeepSeek 402; SSH ≤ 26.11; Yandex-blockmap 3.75.0).

## Следующий шаг

Влить PR B7 (после merge: `git checkout main && git pull`). Затем B8.

## Следующий шаг

По слову владельца. Известно открытое (не этой сессии): пилот opencode-узла на PC79;
M102 dry-run/apply (окно владельца); DeepSeek 402; ротация SSH PC79 ≤ 26.11;
Yandex-зеркало 3.75.0 без blockmap (PENDING 🟡 2026-10-13: exe+yml залиты с прода,
API отдаёт 500/503 — добить позже; на парк не влияет).

## Текущая нитка → ЗАВЕРШЕНА (релиз v3.74.0)

План `docs/plans/favorites-work-stages-defaults-2026-10.md` выполнен полностью:
- **PR-1** (звёздочки + левая колонка) / **PR-2** (`03be8a11`, фильтр «Все этапы» + дата) — в `main` до начала сессии.
- **PR-3** (#1311) — диалог без отсечений (пикер полный список); влит с другого компа.
- **PR-4** (#1312) — сторож карточки этапа (все поля под work_sheets.edit); влит 13.10 с `Computer` (всё зелёное, CLEAN).
- **PR-5** (#1313) — закрыт 13.10 без мержа: дубликат уже влитого `signature_defaults` (таблица 0108, сервис, REST, синк, реплика, UI); ветка подменяла таблицу и ломала импорты.
- **PR-6** (`grantWorkSheetsEditTrio`) — права `work_sheets.edit` выданы троим (`valstan`, `sapegin`, `fatyhova`); на `main` в `4d5fadf7`.

Наша локальная сессия (`feat/pr-*`) содержала дублирующие таблицы (`0108_default_label_defaults` против `0108_signature_defaults`) — удалены; `SESSION_HANDOFF.md` обновлён.

## Следующий шаг (по слову владельца)

План выполнен, релиз v3.74.0 на проде (`4d5fadf7`). Открытое (из актуального PENDING):
- Пилот `opencode-nodes` на PC79 (план `docs/plans/opencode-nodes-2026-10.md`, ручной ход владельца; PR-1 + PR-2 `opencode` влит).
- M102 dry-run/apply — ждал окна владельца (в предыдущем `SESSION_HANDOFF`).
- DeepSeek 402 (пополнить), ротация SSH PC79 ≤ 26.11 (календарь PENDING).
- `docs/OPERATIONS.md` — проверить после синхронизации (`Computer` → `PC79`).

**Наша задача сейчас — не начать новый PR, а синхронизировать состояние:** проверить, что `docs/PENDING_FOLLOWUPS.md` не содержит завершённого (наша сессия не добавляла открытого), `docs/COMPLETED.md` отражает v3.74.0, локальные ветки удалены.

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
