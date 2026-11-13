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
   - **Сводка затора — 5 строк в тело PR** (мост завод-контура, см. AGENTS §Два режима): сколько эффектов за релиз, какие модули, подвинуло ли это **главный затор** из `docs/zavod/FACTORY_MODEL.md` §3 (сегодня — начало сборки: ручной подбор из обезличенного фонда). Не двигало — написать прямо: это факт для планирования, а не провал релиза.
   - письмо `mailbox/to-brain/` — если находка прошла фильтр #009 (значимость + переносимость + неочевидность).
4. Локальная проверка: `corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build` + `corepack pnpm -r typecheck`. Красное → стоп, не коммить.
5. PR-flow (ADR-0002, прямой push в `main` запрещён): ветка `release/vX.Y.Z` → коммит(ы) `release: vX.Y.Z — <описание>` (код + closeout-доки одной веткой) → push → `gh pr create`. **НЕ показывать diff, НЕ ждать OK** — авто-мерж на зелёных гейтах (постулат 30): `gh pr checks` до зелёного → `gh pr merge --squash --delete-branch`. Красный гейт → стоп + диагностика.
6. После merge: `git checkout main && git pull --ff-only`, тег на свежем `main` + пуш **только тега**: `git tag vX.Y.Z && git push origin vX.Y.Z`. **Плюс тег планшета там же:** `git tag android-vX.Y.Z && git push origin android-vX.Y.Z` — префиксы разведены, `v*` собирает только Electron-инсталлятор, APK собирает `android-v*`.
7. Дождись сборки сам: `gh run watch <id>` (найди run'ы по тегам через `gh run list`) — и installer, и APK планшета. Не «напоминай владельцу подождать».
7a. **APK планшета — на прод, качать можно и нужно ПРЯМО на прод** (иначе планшеты не обновятся: Диспетчер скажет `up-to-date`). **Проверено вживую 13.11.2026: с бокса GitHub CDN отдаёт нормально** (206, 0.76 с на 1 КБ) — правило «с прода `gh release download` таймаутит по TLS» устарело, локальный круг «скачать у себя → `scp`» больше не нужен. Качай на бокс: `curl -sSL --retry 5 -o /home/valstan/upload/app-release.apk https://github.com/Valstan/MatricaRMZ/releases/download/android-vX.Y.Z/app-release.apk` → `mv` в `/opt/matricarmz/updates/android/MatricaRMZ-X.Y.Z.apk` (**номер в имени обязателен** — сервер читает версию из имени файла). Рестарт и `latest.yml` для Android не нужны. **Сразу после переноса — чистка старых APK: `bash scripts/prod-ops/cleanup-old-apks.sh`** (оставляет только свежайший; удаление APK на проде разрешено **всегда и без подтверждения** — решение владельца 10.11.2026, чтобы не спрашивать каждый раз; `--dry-run` — сначала посмотреть). Детали — AGENTS.md §Release process шаг 8a.

## Прод-деплой — авто (без «явного да», кроме #025)

Выполняй подряд по разделу Release process в AGENTS.md (шаги 4–11). Канон: **прод ничего не собирает и ничего не ставит** — серверные `dist` приезжают готовым CI-артефактом `backend-dist`, клиент `.exe` — готовым артефактом из GitHub Actions. Ручная сборка на боксе запрещена (2026-10-12: `tsc` убит OOM-киллом, exit 137, на 1.5 ГБ RAM — см. `docs/machines/Computer.md`).

8. На проде: `git pull --ff-only` (подтянуть релизный коммит и миграции).
9. Миграции: если релиз везёт `backend-api/drizzle/*.sql` — `corepack pnpm -F @matricarmz/backend-api db:migrate` (+ backfill-скрипты релиза, dry-run затем `--apply`, row counts в отчёт). Аддитивная (`CREATE`/`ADD COLUMN`/индексы) — до деплоя, старому коду она безвредна. ⚠️ **Деструктивная миграция/backfill → гейт #025** (стоп, спросить).
10. Деплой штатным скриптом (он сам: проверяет артефакт во временном каталоге, кладёт откат-копию в `.deploy-backup/<стамп>/`, раскладывает `dist` + миграции + `web-admin/dist`, рестартит primary → health → secondary):
    `bash scripts/prod-ops/deploy-backend.sh`
    Откат при нужде: `bash scripts/prod-ops/deploy-backend.sh rollback [<стамп>]`.
11. **До рестарта скриптом** — артефакты обновлений. Скачать **на прод** (`curl` в staging → `mv` на место): локальный круг «скачать у себя → `scp`» больше не обязателен — с бокса GitHub CDN отдаёт нормально (проверено вживую 13.11.2026: 206, 0.76 с), а агентский канал режет файл. ⚠️ **Гейт по хэшу, а не по длине (грабля M206):** перед переносом сверь `sha512` файла с манифестом — `openssl dgst -sha512 -binary MatricaRMZ-Setup-X.Y.Z.exe | base64 -w0` против `grep '^sha512:' latest.yml`. Разошлись — файл сносим и качаем **заново, без докачки**: `curl -C -` поверх обрыва склеивает два блоба (длина совпадает, содержимое мусорное). Причина — две сборки на один тег: вторая перезаписала ассеты, CDN отдаёт смесь. Blockmap — **отдельным** вызовом (GOTCHAS M18):
    - `gh release download vX.Y.Z --pattern "*.exe" --pattern "latest.yml" -D <tmp> --clobber` (на прод, в staging)
    - `gh release download vX.Y.Z --pattern "*.blockmap" -D <tmp> --clobber` (локально, отдельно)
    - **Заливать в каталог ВНЕ обновлений**, потом переносить `mv` в пределах одной ФС: `scp <tmp>/MatricaRMZ-Setup-X.Y.Z.exe <tmp>/latest.yml <tmp>/*.blockmap matricarmz:/home/valstan/upload/`, затем на проде `cd /opt/matricarmz/updates && mv /home/valstan/upload/MatricaRMZ-Setup-X.Y.Z.exe . && mv /home/valstan/upload/MatricaRMZ-Setup-X.Y.Z.exe.blockmap . && mv /home/valstan/upload/latest.yml .`. Почему не прямо в каталог: path-юнит `matricarmz-updates-prune` чистит каталог обновлений, а выбирает оставляемый `.exe` **по времени файла, а не по версии** (M194 + M196) — свежий релиз с более старым mtime удаляется, старый остаётся, манифест указывает на несуществующий файл.
    - **освежить mtime** перенесённых файлов (`touch MatricaRMZ-Setup-X.Y.Z.exe MatricaRMZ-Setup-X.Y.Z.exe.blockmap`) и **проверить** `ls -lt /opt/matricarmz/updates/` — первым должен лежать `.exe` текущего релиза.
    - проверить, что легли все 3 (`.exe`, `.exe.blockmap`, `latest.yml`).
    - дождаться согласия `latest.json` с `.exe` на диске (GOTCHAS M40 — иначе poisoned manifest): сверять размер из файла с `size` в `latest.json`, не на глаз.
12. ~~`corepack pnpm release:ledger-publish X.Y.Z`~~ — **шаг снят решением владельца от 28.10.2026** (см. AGENTS.md §Release и `docs/COMPLETED.md`): токен `MATRICA_LEDGER_RELEASE_TOKEN` был admin-JWT с TTL 720 ч, протух, и публикация падала с `401 token_invalid` после каждого выката, никем не замеченная (последняя запись в `release_registry` — 3.90.0 от 25.10). Реестр выпусков читает только веб-админка; клиент обновляется по серверному `latest.json` и GitHub Releases. **Ведение истории релизов у нас идёт GitHub Releases + `shared/src/domain/releaseWelcome.ts` (текст релиза) + `docs/COMPLETED.md` (лента).** Если журнал понадобится снова — ему нужен отдельный долгоживущий ключ и своя дата в `PENDING_FOLLOWUPS`.
13. Приёмка по каждому порту раздельно, не через nginx (GOTCHAS M100 — общий `/health` зелёный, пока жив хоть один инстанс):
    `http://127.0.0.1:3001/health` и `http://127.0.0.1:3002/health` (новый номер; primary биндится ~50 с, окно ≥90 с) + `https://127.0.0.1/updates/status` (`latest.version` = новый номер, `lastError: null`) + `/updates/file/<exe>.blockmap` → `200`. APK планшета — шагом 7a (проверка: `/dispatcher/update-plan?platform=android` ведёт на новый номер).

## Закрытие сессии (fusion — не вызывать /close_session отдельно)

14. После успешного health-check: `git checkout main && git pull --ff-only`, **один** прогон sync-гейта (`scripts/git_sync_check.ps1 -Gate`; `exit 1` → починить → ещё один прогон, не циклом). Closeout-доки уже в релизном PR (шаг 3) — отдельный handoff-PR **НЕ** создавать.
15. Финальный отчёт — на русском, по факту: версия/тег, ссылка на GitHub release, список вошедших изменений (это тот «changelog», что раньше был вопросом), прод-статус (health/updates/blockmap), **сессия закрыта**.

Если что-то падает — стоп, диагностика, не обходы. #025-деструктив — единственная точка, где ждём владельца.
