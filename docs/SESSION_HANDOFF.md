# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE (нитка: новые этапы линейки — входной контроль ОТК + ремонт деталей, ветка `feat/repair-stage-new-codes`)
**Updated:** 2026-10-14 (opencode session, машина `PC79`)
**Branch:** feat/repair-stage-new-codes (влить в main отдельным PR)
**Last released version:** **v3.76.0** на проде (+ android-v3.76.0).

## Текущая нитка

Новые этапы линейки (слово владельца 14.10.2026): `incoming_otk` («Входной
контроль ОТК», ранг 15, автомат акта комплектности) и `parts_repair` («Ремонт
деталей», ранг 30, только вручную). Состав: реестр shared + миграция 0109 +
авто-метка в `checklists:engine:save` (дата осмотра из акта, mark-if-absent) +
`kitting→incoming_otk` в `stages:backfill` + замороженная карта PR3 дополнена.
Гейты локально: shared 1381, electron-app 1650, backend-api 1140, typecheck ×2,
lint ×3 — чисто; 0109 проверена накатом на стенд-БД; живой CDP-смоук
(`cdp-stage-new-codes.mjs`) — SMOKE PASS (шаблоны с сервера, строка из акта
той же датой, уборка). Грабли M153 (when журнала) — в GOTCHAS.
Открытое дальше: B8 → C9 → D10 + известные задачи (пилот узла PC79; M102;
DeepSeek 402; SSH ≤ 26.11; Yandex-blockmap 3.75.0).

## Следующий шаг

Влить PR новых этапов. На релизе с этим PR: `db:migrate` (0109) +
`stages:backfill` dry-run/apply (покрывает историю). Затем B8.

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
