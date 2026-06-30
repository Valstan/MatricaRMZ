# verifier-electron — локальный handle для /verify в Electron-приложении

Версия плана: 2026-05-25
Преемник blocker'а: невозможность прогнать `/verify` для UI-этапов нитки `checklist-unify` (3b, 3c, 5), потому что dev-инфраструктуры из голого checkout'а нет — `electron-app/.env.example` указывает на прод-VPS, локального backend нет, `.claude/skills/verifier-electron/` отсутствует.

## Context

### Проблема, которую решаем

После Этапа 3b checklist-unify попытка `/verify` вернула **BLOCKED** именно из-за инфраструктуры, не из-за кода:

- Backend не поднимается из голого checkout'а: нет `.env`, нет PostgreSQL базы, нет seed-данных.
- Auth требует учётку сотрудника — в репо тестового логина нет.
- Карточка двигателя бесполезна без хотя бы одной марки + 1-2 brand-linked parts (иначе панель пустая, проверять нечего).
- Прогон против прода — destructive (создаёт боевые `operations(stage='engine_inventory')` до релиза v1.23.0).

Следствие: каждый UI-этап (3b, 3c, 5) blocked, фрагментирует prогрессе нитки.

### Что НЕ входит в MVP (явно отложено)

- **Driving** — клики, ввод, save+reload через playwright-electron / автоматизированная computer-use навигация. Откладывается до Этапа 2 (если понадобится).
- **Voice/headless mode** — Electron всегда запускается с видимым окном. На Windows xvfb не работает, и MVP не пытается это решить.
- **Docker-окружение / portable setup** — выбран native PostgreSQL на Windows host. Если потребуется portable — отдельная нитка.
- **CI integration** — verifier-electron работает только локально. Гонять его в GitHub Actions = отдельный масштаб (контейнер с PG, headless Electron).
- **Hot-reload через изменения в shared/** — пользователь сам перезапускает stack при правке `shared/src/...`.

## Цели MVP

1. **Однокомандный setup** локального backend + БД + seed: после клона repo и установленного нативного PostgreSQL, ровно один скрипт делает всё.
2. **Однокомандный launch** backend + electron-app: запустить, дождаться `/health`, открыть окно Electron.
3. **Auth fixture**: в seed создаётся admin-пользователь `verify` / `verify123` (или конфигурируемо).
4. **Минимальный domain fixture**: 1 engine_brand «TEST-BRAND», 1 part с brand-link на эту марку (qty=2), 1 engine «TEST-001» этой марки. Этого достаточно чтобы карточка движка показала непустую панель `engine_inventory` с одной brand-linked строкой.
5. **`SKILL.md` в `.claude/skills/verifier-electron/`** — после `ls .claude/skills/` skill verify подхватит её, и cold-start найдёт точные команды.
6. **Screenshot** — после запуска Claude через computer-use снимает скрин главного окна как evidence; navigation до карточки двигателя — manual (через computer-use клики, описано в SKILL.md).

После MVP `/verify` для Этапа 3b даст: запуск → login → меню Производство → Двигатели → TEST-001 → screenshot панели `engine_inventory` → пункты «строка из брэнд-линка», «identity-поля защёлкнуты», «present-чекбокс — actual=qty». Save+reload — manual (один клик, проверяется визуально), automated в Этапе 2.

## Этапы

### Этап 1 — Setup-скрипты + seed (MVP)

Файлы:

- `.claude/skills/verifier-electron/SKILL.md` — описание + пошаговый протокол использования (используется skill `verify` при cold-start).
- `.claude/skills/verifier-electron/scripts/setup-env.ps1` — генерирует `backend-api/.env.dev` и `electron-app/.env.dev` (`PG*`, `MATRICA_API_URL=http://127.0.0.1:3001`, `MATRICA_JWT_SECRET`, `MATRICA_LEDGER_DATA_KEY` — последний через `node -e "console.log(crypto.randomBytes(32).toString('base64'))"` если не задан). Идемпотентен.
- `.claude/skills/verifier-electron/scripts/setup-db.ps1` — `psql` создаёт role `matricarmz` и database `matricarmz_dev` (idempotent через `DO $$ ... IF NOT EXISTS`).
- `.claude/skills/verifier-electron/scripts/migrate-and-seed.ps1` — `pnpm -F backend-api db:migrate` → `pnpm -F backend-api perm:seed` → новый `pnpm -F backend-api dev:seed-fixtures` (создаёт verify/verify123, TEST-BRAND, TEST-PART с brandLink, TEST-001).
- `backend-api/src/scripts/seedDevFixtures.ts` (новый) — единый seed для verifier'а: один admin, одна марка, одна деталь с brand-link, один двигатель этой марки. Идемпотентно (если найдено по login/brand_name — обновляет).
- `backend-api/package.json` — добавить script `"dev:seed-fixtures": "tsx src/scripts/seedDevFixtures.ts"`.

Verify Этапа 1: на чистом checkout'е (без `.env.dev`, без БД) последовательность `setup-env.ps1` → `setup-db.ps1` → `migrate-and-seed.ps1` отрабатывает без ручных правок и `select * from operations` показывает ожидаемый seed.

### Этап 2 — Launch-скрипты + handle для /verify

Файлы:

- `.claude/skills/verifier-electron/scripts/start-backend.ps1` — запускает `pnpm -F backend-api dev` через `dotenv -e backend-api/.env.dev`, ждёт `curl 127.0.0.1:3001/health` (timeout 30s), пишет PID в `.verifier-electron/backend.pid`.
- `.claude/skills/verifier-electron/scripts/start-electron.ps1` — запускает `pnpm -F electron-app dev` с `.env.dev`, ждёт пока окно появится (через PID-чек процесса `electron.exe`). PID в `.verifier-electron/electron.pid`.
- `.claude/skills/verifier-electron/scripts/stop.ps1` — kill обоих по PID-файлам, idempotent.
- `.gitignore` — добавить `.verifier-electron/`, `*.env.dev`.
- `.claude/skills/verifier-electron/SKILL.md` дописать раздел «Driving»: пошаговый clicks через `mcp__computer-use__*` (login → menu → engines list → TEST-001 → screenshot панели).

Verify Этапа 2: `/verify` для Этапа 3b checklist-unify даёт PASS с screenshot'ом панели + observations про identity-lock, present-чекбокс, brand-row.

### Этап 3 — Опциональные расширения (не для MVP)

Зафиксировано на будущее, открывается по необходимости:

- **Playwright-electron**: автоматизированное driving (login auto-submit, programmatic navigation, save+reload assertions).
- **Dump production schema** через `pg_dump --schema-only` чтобы локальная БД 1:1 соответствовала проду (если миграции дрейфуют).
- **Snapshot-based fixtures**: вместо seed-скрипта — restore SQL-дампа с готовым набором (быстрее, но менее прозрачно).
- **`docker-compose.dev.yml`**: portable вариант для пользователей без native PG.

## Риски

- **Hot-reload Electron в фоне:** electron-vite dev запускает Vite + Electron + watcher. Когда я запускаю это из PowerShell в background, mainprocess логи теряются. Решение: пишем логи в файл `.verifier-electron/electron.log` через `Start-Process -RedirectStandardOutput`. Если окно не появляется за 30 секунд — fail с указанием на лог.
- **better-sqlite3 NODE_MODULE_VERSION mismatch** (из SESSION_HANDOFF): первый запуск может потребовать `pnpm --filter @matricarmz/electron-app rebuild better-sqlite3`. Setup-скрипт делает это автоматически.
- **Drizzle migrations против пустой БД:** если миграция падает, БД остаётся в полу-применённом состоянии. Решение: `setup-db.ps1` поддерживает `--reset` флаг — drop database, recreate, re-migrate.
- **Конфликт с прод-конфигом:** если у пользователя в `electron-app/.env` уже есть `MATRICA_API_URL=https://...vps.myjino.ru`, dev `.env.dev` должен иметь приоритет (через `dotenv -e .env.dev`). Иначе клиент полезет в прод. Проверить precedence через тест.
- **Mixed shell:** SKILL.md упоминает PowerShell-скрипты, но `Bash` тоже доступен в окружении Claude. Скрипты пишутся как `.ps1` (Windows-first), при необходимости — параллельные `.sh` в Этапе 3.

## Объём

2 PR. Этап 1 — самостоятельный (можно merge'ить независимо). Этап 2 поверх Этапа 1.

После обоих этапов возвращаемся к feat/checklist-unify-stage-3b (уже запушена) → `/verify` через verifier-electron → если PASS, открываем PR → merge → Этап 3c (печатные формы).

## Этап 0 — Подтверждение (до старта Этапа 1)

- [ ] Версия нативного PostgreSQL на Windows: 14+ (минимум, что поддерживает Drizzle migrations прод) или 16 (как на проде, ноль drift'а)? Прод — PG 16.
- [ ] Пароль для admin-учётки `verify`: фикс `verify123` в скрипте, либо генерируемый из `MATRICA_VERIFY_PASSWORD` env? Если фикс — это в SKILL.md, не security risk (только локально, .env.dev в gitignore).
- [ ] Имя БД: `matricarmz_dev` ОК, или собственное (например, чтобы соседствовать с уже существующей `matricarmz` для других проектов)?
- [ ] Готов ли пользователь, что setup-db.ps1 потребует `psql` в `PATH` и пользователя `postgres` с известным паролем (через `PGPASSWORD` env или `.pgpass`)?
