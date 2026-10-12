---
description: Выпусти новый релиз согласно инструкции в AGENTS.md (раздел Release process)
---

Выпуск нового релиза MatricaRMZ. Действуй строго по разделу **Release process** в `AGENTS.md`.

**Автономный режим (мандат владельца 2026-07-15, постулат 33 brain: вызов командного скила = полный мандат на весь сценарий).** Пройди весь путь — от команды до **закрытой сессии** — **без единого вопроса владельцу**, кроме гейта #025 (ниже). Каждая пауза на подтверждении = остывший cache = переотправка контекста; поэтому подтверждений нет, есть финальный отчёт.

**Версия считается автоматически (следующий порядковый номер выпуска: `3.27.0` → `3.28.0`) — номер НЕ выбирается вручную.** Не спрашивай patch/minor/major. Смена поколения программы (`--major`, `3.x` → `4.1.0`) — решение владельца, сам не бери.

## Единственный сохранённый гейт — #025 (деструктив на проде)

Стоп + явное подтверждение владельца в том же ходе **только** если релиз везёт **деструктивную** миграцию/backfill, меняющий прод-данные без revert-пути: `DROP` / `DELETE` / `TRUNCATE` / lossy `UPDATE`. **Аддитивные** миграции (`CREATE` / `ADD COLUMN` / индексы) гейтом **не** считаются — катятся авто. Красный гейт или упавший шаг → стоп + диагностика (не «лечи» `--no-verify`).

## Шаги (выполняй подряд, отчёт после, без промежуточных вопросов)

1. `node scripts/bump-version.mjs` — штампит следующий номер выпуска в `VERSION` + все `package.json`. Запомни итоговую версию из вывода (`X.Y.Z`).
2. Добавь запись в начало `RELEASE_WELCOME_HISTORY` в `shared/src/domain/releaseWelcome.ts` — `releaseLabel` = `X.Y.Z`, `releaseDate` = дата выката `YYYY-MM-DD` (**без неё запись выпадет из окна «Что нового»** — порядковый номер, в отличие от прежнего CalVer, даты не несёт). **Текст «что нового» составь сам** из коммитов с последнего тега: человекочитаемо, на русском, смысл для пользователей завода (не номера, не commit-хэши). **Обязательно новый `epigraph`** — оригинальная цитата-эпиграф (юмор/афоризм про завод/машиностроение/бухгалтерию), не повторять прежние. Если владелец дал текст в команде — используй его.
3. **Session-closeout доки в ЭТОТ ЖЕ релизный PR** (fusion — отдельного handoff-PR не будет):
   - `docs/SESSION_HANDOFF.md` — свежая нитка или IDLE (по факту после релиза).
   - `docs/PENDING_FOLLOWUPS.md` — удалить закрытое релизом.
   - строка в `docs/COMPLETED.md` (нитка/релиз).
   - `docs/zavod/PROGRAM_EFFECTS.md` — если релиз везёт функциональность (зачем → что улучшило).
   - письмо `mailbox/to-brain/` — если находка прошла фильтр #009 (значимость + переносимость + неочевидность).
4. Локальная проверка: `corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build` + `corepack pnpm -r typecheck`. Красное → стоп, не коммить.
5. PR-flow (ADR-0002, прямой push в `main` запрещён): ветка `release/vX.Y.Z` → коммит(ы) `release: vX.Y.Z — <описание>` (код + closeout-доки одной веткой) → push → `gh pr create`. **НЕ показывать diff, НЕ ждать OK** — авто-мерж на зелёных гейтах (постулат 30): `gh pr checks` до зелёного → `gh pr merge --squash --delete-branch`. Красный гейт → стоп + диагностика.
6. После merge: `git checkout main && git pull --ff-only`, тег на свежем `main` + пуш **только тега**: `git tag vX.Y.Z && git push origin vX.Y.Z`. **Плюс тег планшета там же:** `git tag android-vX.Y.Z && git push origin android-vX.Y.Z` — префиксы разведены, `v*` собирает только Electron-инсталлятор, APK собирает `android-v*`.
7. Дождись сборки сам: `gh run watch <id>` (найди run'ы по тегам через `gh run list`) — и installer, и APK планшета. Не «напоминай владельцу подождать».
7a. **APK планшета — на прод руками, качать ЛОКАЛЬНО** (иначе планшеты не обновятся: Диспетчер скажет `up-to-date`). `gh release download android-vX.Y.Z --pattern "*.apk"` в темп локально → `scp` на прод как `/opt/matricarmz/updates/android/MatricaRMZ-X.Y.Z.apk` (**номер в имени обязателен** — сервер читает версию из имени файла). С прода `gh release download` таймаутит по TLS. Рестарт и `latest.yml` для Android не нужны. Детали — AGENTS.md §Release process шаг 8a.

## Прод-деплой — авто (без «явного да», кроме #025)

Выполняй подряд по разделу Release process в AGENTS.md (шаги 4–11). Канон: **прод ничего не собирает и ничего не ставит** — серверные `dist` приезжают готовым CI-артефактом `backend-dist`, клиент `.exe` — готовым артефактом из GitHub Actions. Ручная сборка на боксе запрещена (2026-10-12: `tsc` убит OOM-киллом, exit 137, на 1.5 ГБ RAM — см. `docs/machines/Computer.md`).

8. На проде: `git pull --ff-only` (подтянуть релизный коммит и миграции).
9. Миграции: если релиз везёт `backend-api/drizzle/*.sql` — `corepack pnpm -F @matricarmz/backend-api db:migrate` (+ backfill-скрипты релиза, dry-run затем `--apply`, row counts в отчёт). Аддитивная (`CREATE`/`ADD COLUMN`/индексы) — до деплоя, старому коду она безвредна. ⚠️ **Деструктивная миграция/backfill → гейт #025** (стоп, спросить).
10. Деплой штатным скриптом (он сам: проверяет артефакт во временном каталоге, кладёт откат-копию в `.deploy-backup/<стамп>/`, раскладывает `dist` + миграции + `web-admin/dist`, рестартит primary → health → secondary):
    `bash scripts/prod-ops/deploy-backend.sh`
    Откат при нужде: `bash scripts/prod-ops/deploy-backend.sh rollback [<стамп>]`.
11. **До рестарта скриптом** — артефакты обновлений. Качать **локально** (с прода к GitHub CDN — TLS-таймауты), класть на прод через `scp` (каталог принадлежит сервисному пользователю). Blockmap — **отдельным** вызовом (GOTCHAS M18):
    - `gh release download vX.Y.Z --pattern "*.exe" --pattern "latest.yml" -D <tmp> --clobber` (локально)
    - `gh release download vX.Y.Z --pattern "*.blockmap" -D <tmp> --clobber` (локально, отдельно)
    - `scp <tmp>/MatricaRMZ-Setup-X.Y.Z.exe <tmp>/latest.yml <tmp>/*.blockmap matricarmz:/opt/matricarmz/updates/`
    - проверить, что легли все 3 (`.exe`, `.exe.blockmap`, `latest.yml`).
    - дождаться согласия `latest.json` с `.exe` на диске (GOTCHAS M40 — иначе poisoned manifest): сверять размер из файла с `size` в `latest.json`, не на глаз.
12. `corepack pnpm release:ledger-publish X.Y.Z` (на проде — нужен доступ к БД; сам `latest.json` не переписывает, это дело рескана).
13. Приёмка по каждому порту раздельно, не через nginx (GOTCHAS M100 — общий `/health` зелёный, пока жив хоть один инстанс):
    `http://127.0.0.1:3001/health` и `http://127.0.0.1:3002/health` (новый номер; primary биндится ~50 с, окно ≥90 с) + `https://127.0.0.1/updates/status` (`latest.version` = новый номер, `lastError: null`) + `/updates/file/<exe>.blockmap` → `200`. APK планшета — шагом 7a (проверка: `/dispatcher/update-plan?platform=android` ведёт на новый номер).

## Закрытие сессии (fusion — не вызывать /close_session отдельно)

14. После успешного health-check: `git checkout main && git pull --ff-only`, **один** прогон sync-гейта (`scripts/git_sync_check.ps1 -Gate`; `exit 1` → починить → ещё один прогон, не циклом). Closeout-доки уже в релизном PR (шаг 3) — отдельный handoff-PR **НЕ** создавать.
15. Финальный отчёт — на русском, по факту: версия/тег, ссылка на GitHub release, список вошедших изменений (это тот «changelog», что раньше был вопросом), прод-статус (health/updates/blockmap), **сессия закрыта**.

Если что-то падает — стоп, диагностика, не обходы. #025-деструктив — единственная точка, где ждём владельца.
