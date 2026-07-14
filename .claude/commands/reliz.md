---
description: Выпусти новый релиз согласно инструкции в CLAUDE.md (раздел Release process)
---

Выпуск нового релиза MatricaRMZ. Действуй строго по разделу **Release process** в `CLAUDE.md`.

**Автономный режим (мандат владельца 2026-07-15, постулат 33 brain: вызов командного скила = полный мандат на весь сценарий).** Пройди весь путь — от команды до **закрытой сессии** — **без единого вопроса владельцу**, кроме гейта #025 (ниже). Каждая пауза на подтверждении = остывший cache = переотправка контекста; поэтому подтверждений нет, есть финальный отчёт.

**Версия генерируется автоматически (CalVer от даты сборки) — номер НЕ выбирается вручную.** Не спрашивай patch/minor/major.

## Единственный сохранённый гейт — #025 (деструктив на проде)

Стоп + явное подтверждение владельца в том же ходе **только** если релиз везёт **деструктивную** миграцию/backfill, меняющий прод-данные без revert-пути: `DROP` / `DELETE` / `TRUNCATE` / lossy `UPDATE`. **Аддитивные** миграции (`CREATE` / `ADD COLUMN` / индексы) гейтом **не** считаются — катятся авто. Красный гейт или упавший шаг → стоп + диагностика (не «лечи» `--no-verify`).

## Шаги (выполняй подряд, отчёт после, без промежуточных вопросов)

1. `node scripts/bump-version.mjs` — штампит CalVer от текущей даты в `VERSION` + все `package.json`. Запомни итоговую версию из вывода (`X.Y.Z`).
2. Добавь запись в начало `RELEASE_WELCOME_HISTORY` в `shared/src/domain/releaseWelcome.ts` — `releaseLabel` = `X.Y.Z`. **Текст «что нового» составь сам** из коммитов с последнего тега: человекочитаемо, на русском, смысл для пользователей завода (не номера, не commit-хэши). **Обязательно новый `epigraph`** — оригинальная цитата-эпиграф (юмор/афоризм про завод/машиностроение/бухгалтерию), не повторять прежние. Если владелец дал текст в команде — используй его.
3. **Session-closeout доки в ЭТОТ ЖЕ релизный PR** (fusion — отдельного handoff-PR не будет):
   - `docs/SESSION_HANDOFF.md` — свежая нитка или IDLE (по факту после релиза).
   - `docs/PENDING_FOLLOWUPS.md` — удалить закрытое релизом.
   - строка в `docs/COMPLETED.md` (нитка/релиз).
   - `docs/zavod/PROGRAM_EFFECTS.md` — если релиз везёт функциональность (зачем → что улучшило).
   - письмо `mailbox/to-brain/` — если находка прошла фильтр #009 (значимость + переносимость + неочевидность).
4. Локальная проверка: `corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build` + `corepack pnpm -r typecheck`. Красное → стоп, не коммить.
5. PR-flow (ADR-0002, прямой push в `main` запрещён): ветка `release/vX.Y.Z` → коммит(ы) `release: vX.Y.Z — <описание>` (код + closeout-доки одной веткой) → push → `gh pr create`. **НЕ показывать diff, НЕ ждать OK** — авто-мерж на зелёных гейтах (постулат 30): `gh pr checks` до зелёного → `gh pr merge --squash --delete-branch`. Красный гейт → стоп + диагностика.
6. После merge: `git checkout main && git pull --ff-only`, тег на свежем `main` + пуш **только тега**: `git tag vX.Y.Z && git push origin vX.Y.Z`.
7. Дождись сборки installer'а сам: `gh run watch <id>` (найди run по тегу через `gh run list`). Не «напоминай владельцу подождать».

## Прод-деплой — авто (без «явного да», кроме #025)

Выполняй подряд по разделу Release process в CLAUDE.md (шаги 4-10). Помни: на проде собираются **только** серверные пакеты (`shared`/`backend-api`/`web-admin`), клиент `.exe` приходит готовым артефактом из GitHub Actions.

8. `git pull --ff-only && corepack pnpm install && corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build` (renderer-only релиз без смены lockfile — install/build можно пропустить, только swap артефактов).
9. Миграции: если релиз везёт `backend-api/drizzle/*.sql` — `corepack pnpm -F @matricarmz/backend-api db:migrate` (между build и restart) + backfill-скрипты. ⚠️ **Деструктивная миграция/backfill → гейт #025** (стоп, спросить). Аддитивная → авто.
10. **До рестарта** — артефакты в `/opt/matricarmz/updates/` (blockmap **отдельным** вызовом, GOTCHAS M18):
    - `gh release download vX.Y.Z --pattern "*.exe" --pattern "latest.yml" -D /opt/matricarmz/updates --clobber`
    - `gh release download vX.Y.Z --pattern "*.blockmap" -D /opt/matricarmz/updates --clobber`
    - проверить, что легли все 3 (`.exe`, `.exe.blockmap`, `latest.yml`).
11. **До рестарта** — `corepack pnpm release:ledger-publish X.Y.Z`.
12. Рестарт: `sudo systemctl restart matricarmz-backend-primary.service matricarmz-backend-secondary.service`.
13. Health-check: `curl -fsk https://127.0.0.1/health` (новый CalVer) + `curl -fsSk https://127.0.0.1/updates/status` (`latest.version` = новый CalVer) + blockmap 200.

## Закрытие сессии (fusion — не вызывать /close_session отдельно)

14. После успешного health-check: `git checkout main && git pull --ff-only`, **один** прогон sync-гейта (`scripts/git_sync_check.ps1 -Gate`; `exit 1` → починить → ещё один прогон, не циклом). Closeout-доки уже в релизном PR (шаг 3) — отдельный handoff-PR **НЕ** создавать.
15. Финальный отчёт — на русском, по факту: версия/тег, ссылка на GitHub release, список вошедших изменений (это тот «changelog», что раньше был вопросом), прод-статус (health/updates/blockmap), **сессия закрыта**.

Если что-то падает — стоп, диагностика, не обходы. #025-деструктив — единственная точка, где ждём владельца.
