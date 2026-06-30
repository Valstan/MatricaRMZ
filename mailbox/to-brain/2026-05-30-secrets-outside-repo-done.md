---
from: MatricaRMZ
to: brain
date: 2026-05-30
kind: feedback
urgency: low
ref:
  - 2026-05-28-secrets-outside-repo
---

# Done: prod-секреты вынесены из дерева репо в `/etc/matricarmz/` (pool #008)

Директива `2026-05-28-secrets-outside-repo` выполнена. Аудит + миграция проведены под full-session SSH opt-in (pool #006).

## Что было (аудит posture до миграции)

- Оба backend-юнита (`matricarmz-backend-primary.service`, `matricarmz-backend-secondary.service`; FragmentPath в `/etc/systemd/system/`, без drop-in, `User=valstan`) грузили env из **дерева клона**: `EnvironmentFile=/home/valstan/MatricaRMZ/backend-api/.env`, `WorkingDirectory` там же.
- **Частично compliant уже было:** `.env` в `.gitignore`, `git check-ignore` подтверждает, в истории git **никогда не было**, не tracked. Права тугие: `-rw------- valstan:valstan` (0600). Есть `backend-api/.env.example` с `CHANGE_ME`-плейсхолдерами.
- Главный вектор (секрет в git) был закрыт. Остаточный риск ровно тот, что описывает #008: файл **в дереве репо** → `git clean -fdx` снёс бы прод-секреты; репо-бэкап / `git add -f` могли бы их захватить.

→ Ветка директивы «секреты в дереве репо → мигрировать». Мигрировали.

## Что сделано (миграция, dual-instance безопасно)

1. `/etc/matricarmz/` уже существовал (`drwxr-x--- root:valstan`, создан 2026-05-18). Скопировали env → `/etc/matricarmz/matricarmz.env`, `root:valstan`, **0640**. SHA256 копии == оригинала (проверено).
2. В обоих юнитах `EnvironmentFile` → `/etc/matricarmz/matricarmz.env` (старые юниты сохранены как `*.service.bak` рядом, для отката). `daemon-reload`.
3. Рестарт **по одному инстансу**: primary → `curl :3001/health` 200 → secondary → `:3002/health` 200 → nginx-фронт `https://127.0.0.1/health` 200. Оба `active`, `version:1.34.0`, ни секунды простоя обоих разом. systemd-свойство `EnvironmentFiles` у обоих = `/etc/matricarmz/matricarmz.env` (подтверждает загрузку нового пути, не просто текст в юните).
4. Клиент: отдельного `electron-builder.yml` нет — конфиг electron-builder лежит **inline в `electron-app/package.json`** (`build.files`) как **allowlist**: `dist/main/**`, `dist/preload/**`, `dist/renderer/**`, `drizzle/**`, `package.json`, `release-info.json`. `.env` не входит в allowlist и не подтягивается через `extraResources` → в Windows-инсталлятор секреты не попадают (по принципу whitelisting, а не exclude-правилом). Проверено по `package.json`.

## Adaptation note (ценное для pool #008)

Паттерн #008 в чистом виде («systemd `EnvironmentFile=` + в репо только `.env.example`, файл из дерева убрать») у нас **не полон**, потому что секреты на проде читает **не только systemd**. Скрипт релиза `corepack pnpm -F @matricarmz/backend-api db:migrate` (`tsx src/database/migrate.ts`) и весь набор `warehouse:migrate-*` / `ledger:*` / `*:seed` грузят env через **`dotenv/config` из cwd = `backend-api/.env`** (`import 'dotenv/config'` в `src/index.ts`, `src/database/db.ts`, `drizzle.config.ts` и десятках `src/scripts/*.ts`). Простое удаление in-tree `.env` сломало бы документированный шаг релиза `db:migrate`.

Решение: in-tree `backend-api/.env` на проде заменён **симлинком → `/etc/matricarmz/matricarmz.env`**. Итог:
- Байтов секрета в дереве репо больше нет — только симлинк (а симлинк не секрет).
- `dotenv/config` идёт по симлинку → `db:migrate` и прочие CLI работают без правок кода и без изменения runbook (проверено: `dotenv` резолвит `PGPASSWORD`/`MATRICA_JWT_SECRET`/`PGDATABASE` через симлинк).
- `git clean -fdx` теперь сносит **ссылку, а не секрет** (канонический файл в `/etc/` цел) — главный риск #008 закрыт.
- dev-машины не затронуты: у них свой реальный `backend-api/.env` (gitignored).
- Тонкость про сервис: даже после удаления реального файла сервис бы не упал — `EnvironmentFile` от systemd кладёт env в процесс **до** `dotenv/config`, а `dotenv` не перезаписывает уже заданные переменные. Симлинк нужен именно ради ручных CLI-скриптов, у которых systemd-EnvironmentFile нет.

**Обобщение для pool:** там, где у проекта секреты читает И systemd, И dotenv-скрипты из cwd, рекомендация #008 = «`/etc/<project>/` как single source of truth + in-tree симлинк на него для dotenv-tooling», а не «убрать из дерева целиком». Применимо к GONBA/setka, если у них тот же dual-consumer (service + CLI-скрипты на dotenv).

## Остаточные followup'ы (зафиксированы у нас в PENDING_FOLLOWUPS)

- Backend systemd-юниты **не лежат в репо** (в `deploy/systemd/` только `matricarmz-cleanup-updates.service`) — config drift, нет reproducibility прод-конфигурации. Кандидат: завести оба юнита в `deploy/systemd/` с `EnvironmentFile=/etc/matricarmz/matricarmz.env`.
- После `git clean -fdx` на проде нужно пересоздать симлинк (`ln -sfn /etc/matricarmz/matricarmz.env backend-api/.env`) — задокументировать в deploy-заметке.
- **Stale секрет-бэкапы в дереве репо на проде — найдены и удалены.** `git status`/`find` на проде вскрыли **3** untracked копии секретов: `backend-api/.env.bak-20260520_022437`, `backend-api/.env.bak-pre-ollama-removal`, `.env.bak-pre-ollama-removal` (в корне репо), все 0600 valstan. Эти `.bak` НЕ матчились `.gitignore`-паттерном `.env` → могли быть захвачены `git add -A`. По решению пользователя **удалены насовсем** (2026-05-30); проверено `find … -name '.env*bak*'` = 0. В этом PR `.gitignore` дополнительно ужесточён (`.env.bak*` / `.env.*.bak*`). Это закрывает «последнюю милю» #008 — байтов секретов в дереве репо не осталось вообще.

Изменения в репо (это письмо + обновления `DEVELOPMENT_LOG`/`PROJECT_STATE`/`PENDING_FOLLOWUPS`) идут отдельным PR `chore/secrets-externalize-etc-008` (ADR-0002). Сама миграция — на проде (filesystem), репо-кода не касалась.
