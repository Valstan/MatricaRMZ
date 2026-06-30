---
description: Выпусти новый релиз согласно инструкции в CLAUDE.md (раздел Release process)
---

Выпуск нового релиза MatricaRMZ. Действуй строго по разделу **Release process** в `CLAUDE.md`.

**Версия генерируется автоматически (CalVer от даты сборки) — номер НЕ выбирается вручную.** Не спрашивай patch/minor/major.

Перед стартом:

1. Покажи список коммитов с предыдущего релизного тега (`git log $(git tag --sort=-v:refname | head -1)..HEAD --oneline`) и попроси подтвердить, что всё это идёт в релиз.
2. Спроси текст для `RELEASE_WELCOME_HISTORY` (что показать пользователям в окне «Что нового»). Если пользователь скажет «составь сам» — собери из коммитов в человекочитаемом виде на русском. Это смысл изменений, а не номер.

После подтверждения changelog выполни шаги релиза:

1. `node scripts/bump-version.mjs` — штампит CalVer от текущей даты в `VERSION` + все `package.json`. Запомни итоговую версию из вывода (`X.Y.Z`).
2. Добавь запись в начало `RELEASE_WELCOME_HISTORY` в `shared/src/domain/releaseWelcome.ts` — `releaseLabel` = сгенерированный CalVer (`X.Y.Z`), текст — человеческий.
3. Сборка локальной проверки: `corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build` + `corepack pnpm -r typecheck` — убедись, что TypeScript проходит. Если красное — стоп, не коммить.
4. Релиз через PR-flow (ADR-0002, прямой push в `main` запрещён): ветка `release/vX.Y.Z` → коммит `release: vX.Y.Z — <короткое описание>` → push ветки → `gh pr create` → показать diff пользователю → после OK `gh pr merge --squash --delete-branch`.
5. После merge: `git checkout main && git pull --ff-only`, затем тег на свежем `main` и пуш **только тега**: `git tag vX.Y.Z && git push origin vX.Y.Z` (GitHub Action соберёт installer).

После пуша тега:

6. Напомни пользователю, что GitHub Action соберёт `.exe` — дождись завершения workflow.
7. Прод-деплой (только с явного «да» пользователя; команды — по разделу Release process в CLAUDE.md, шаги 4-10):
   - `git pull --ff-only && corepack pnpm install && corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build`
   - если релиз везёт миграции — `corepack pnpm -F @matricarmz/backend-api db:migrate` (между build и restart) + backfill-скрипты
   - **до рестарта** скачать все 3 артефакта (`.exe` + `latest.yml` + `*.blockmap`) в `/opt/matricarmz/updates/` (`gh release download vX.Y.Z --pattern "*.exe" --pattern "latest.yml" --pattern "*.blockmap" -D /opt/matricarmz/updates --clobber`)
   - **до рестарта** `corepack pnpm release:ledger-publish X.Y.Z`
   - рестарт: `sudo systemctl restart matricarmz-backend-primary.service matricarmz-backend-secondary.service`
8. Health-check после рестарта: `curl -fsk https://127.0.0.1/health` (новый CalVer) и `curl -fsSk https://127.0.0.1/updates/status` (`latest.version` = новый CalVer).

Все шаги, меняющие прод, выполняются только с явного «да» пользователя. Локальные шаги (bump, changelog, коммит, тег, пуш) — после подтверждения changelog можно выполнять подряд, отчитываясь коротко после каждого.

Если что-то падает — стоп, диагностика, не «лечи» --no-verify или подобными обходами.

Финальное сообщение — на русском, по факту: что сделано, какой тег, ссылка на GitHub release, что осталось вручную.
