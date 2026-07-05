# MatricaRMZ — Claude Code instructions

## Language
All final messages, summaries, explanations, and recommendations to the user must be in **Russian**.
Internal reasoning, code comments, commit messages, identifiers — in English (as used in the project).

## Конституция — приоритетное чтение

**Прежде всего — [`docs/CONSTITUTION.md`](docs/CONSTITUTION.md):** компактный слой **принципов** проекта (ценности, из которых выводятся решения и против которых проверяются задачи). Читать **первым**; процедуры/гейты ниже — точечно. Включает статью «Claude — активный советник с предохранителями» (предлагай лучший путь раз и коротко, поднимай флаг последствий *до* реализации, идеи — в бэклог, решение за владельцем, анти-спам — закон). _(Черновик на ратификации владельца — `2026-06-18-project-constitution-and-advisor-stance`.)_

## Источники правды для продолжения работы

Эти файлы хранят состояние разработки между сессиями / между компьютерами. Читать в начале каждой новой сессии (это делает `/start`).

**Раскол «открытое vs сделанное» ([план memory-reorg](docs/plans/_archive/memory-reorg-2026-06.md), образец Мозга):** рабочие файлы держат **только открытое**; завершённое уходит в тонкий done-индекс + git/PR. Это убирает «всплытие уже сделанного» и токены холодного старта.

- [`docs/SESSION_HANDOFF.md`](docs/SESSION_HANDOFF.md) — **sticky-note последней сессии**: текущая активная нитка, следующий шаг, ссылка на план. **Только активное** — без дампа завершённого. Заполняется `/close_session`, читается `/start`. Перезаписывается целиком — история через `git log -- docs/SESSION_HANDOFF.md`. **Читать всегда.**
- [`docs/CODEBASE_MAP.md`](docs/CODEBASE_MAP.md) — **карта монорепо**: где живёт X, когда сюда лезть. Куратируемый markdown ≤2 экрана, не автогенерируется. Читать **вместо** широкой разведки `docs/` или `Glob/Read` «на ощупь». «Карта прежде разведки» — [ADR-0003 brain_matrica](../brain_matrica/adr/0003-token-economy-principles.md). **Читать всегда.**
- [`docs/PENDING_FOLLOWUPS.md`](docs/PENDING_FOLLOWUPS.md) — **только открытые** задачи/техдолги/отложенные (🔴 / ⏳ / 🟡 / 🟢) + метки старения. Завершённое сюда **не кладём** (выпиливается при закрытии). **Читать только если задача про open issues.**
- [`docs/COMPLETED.md`](docs/COMPLETED.md) — **done-индекс (Tier-1):** 1 строка на завершённую нитку/релиз. Не дублирует git/PR — только навигация «это уже сделано?». **Читать по требованию**, `/start` его не читает.
- [`docs/GOTCHAS.md`](docs/GOTCHAS.md) — **проектные грабли по симптомам** (Tier-1 индекс + записи). **Грепать перед долгой отладкой**, `/start` не читает. Кросс-проектные — в `../brain_matrica/cross-project-ideas/GOTCHAS.md`.
- [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) — архитектурное состояние, правила, устаревшие решения. **Читать только если задача про архитектуру / прод / релизный контур.**
- [`docs/plans/`](docs/plans/) — **активные** многоэтапные планы. Завершённые → [`docs/plans/_archive/`](docs/plans/_archive/). **При plan mode создавай файл сразу здесь** (`docs/plans/<slug>.md`), не в `~/.claude/plans/` — иначе план не виден на других компах.
- [`docs/machines/<hostname>.md`](docs/machines/README.md) — **профиль окружения этого компа**: порты dev-стенда (PG/backend/vite/CDP), пути к инструментам, как поднимать скиллы (`verifier-electron`), машинные грабли. По файлу на hostname (правит только свой комп → нет межмашинных конфликтов). `/start` §0.5 читает свой по hostname; **пиши по мере изучения** «как тут запускается X». Без секретов. **Читать всегда** (свой). Конвенция — [`docs/machines/README.md`](docs/machines/README.md).

**Принцип token economy:** `SESSION_HANDOFF` + `CODEBASE_MAP` + `docs/machines/<hostname>.md` — обязательны на старте. `PENDING_FOLLOWUPS` / `COMPLETED` / `GOTCHAS` / `PROJECT_STATE` читаются **по требованию задачи**, не безусловно (ADR-0003). История релизов — `git log` + тело PR; тонкая навигация по ней — `COMPLETED.md`.

## Cross-project knowledge base

Кросс-проектный pool идей, tech-radar, реестр проектов и cross-project ADRs — в meta-репо [`brain_matrica`](https://github.com/Valstan/brain_matrica). Локально: `../brain_matrica/` (если все репо клонированы в одну родительскую папку, например `D:\GitHubReps\`). Fallback: `~/.claude/cross-project-ideas/` (legacy, помечено к удалению).

Перед предложением переносимой идеи (фишка из MatricaRMZ, которая может пригодиться в GONBA/setka, или наоборот) — глянь `<brain_matrica>/cross-project-ideas/INDEX.md`. Новые идеи добавляй **в brain_matrica отдельной сессией** (`cd ../brain_matrica && claude`), не из этого репо. При применении идеи у себя — отметь `✅ YYYY-MM-DD` в её таблице.

**Mailbox-протокол ([ADR-0001](../brain_matrica/adr/0001-brain-projects-mailboxes.md), асимметричный с 2026-05-23):** каждая сторона пишет только в свой репо.

- **brain → MatricaRMZ:** brain пишет в `../brain_matrica/mailboxes/MatricaRMZ/from-brain/*.md`. Мы только читаем (`git -C ../brain_matrica pull --ff-only`).
- **MatricaRMZ → brain:** мы пишем в [`mailbox/to-brain/`](mailbox/to-brain/) **этого** репо. brain читает через `git pull` MatricaRMZ.
- **Шеринг находок (pool #009):** значимые *переносимые* находки (скилл/фича/паттерн/решённая нетривиальная боль) сам отправляю в brain через `mailbox/to-brain/` — не только по явной просьбе. Фильтр (слать только если все три: значимость + переносимость + неочевидность) и шаг встроены в `/close_session`. По умолчанию — молчим.
- Запись/коммит в `../brain_matrica/` из проектной сессии **запрещён** (никаких `.last-seen`, никакой архивации, никакого `to-brain/` в чужом репо).
- `/start` §0 сканит входящие и докладывает в формате `[urgency COMPLIANCE] slug — topic`. Compliance: `MAY/SHOULD/MUST` (suggest/recommend/mandate, RFC 2119). Письма kind=directive/idea без поля compliance — читать как `MUST`/`SHOULD` соответственно.

## Git flow

**PR-only flow ([ADR-0002](../brain_matrica/adr/0002-pr-only-flow-no-direct-push.md)).** Прямой `git push origin main` запрещён. Любое изменение:

```bash
git checkout -b <type>/<slug>        # feat/ fix/ chore/ docs/ refactor/
# … работа, коммиты …
git push -u origin <type>/<slug>
gh pr create --title "..." --body "## Summary ... ## Test plan ..."
# показать diff пользователю → дождаться явного OK
gh pr merge --squash --delete-branch   # squash по умолчанию; merge commit — для длинных серий
git checkout main && git pull
```

- Slug — kebab-case, описательный (`feat/work-order-bom-tree-view`, `fix/payroll-signature-fio`).
- Релиз = merge PR → `git tag vX.Y.Z` на свежем `main` → `git push origin vX.Y.Z` (GitHub Actions триггерит installer build).
- **Force-push в `main` — запрещён**; в feature-ветку — разрешён (rebase / amend перед merge).
- **Hot-fix исключение:** прод упал → допустим direct push, но обязательный follow-up PR постфактум с описанием инцидента.
- Branch protection на GitHub для `main`: require PR, disallow force push, disallow deletion.

**GitHub — источник истины между машинами ([brain #010](../brain_matrica/cross-project-ideas/ideas/010-session-sync-safeguard.md), mandate).** Работа ведётся на разных компах; не оставляй сессию с несинхронизированной работой. Всё (код + доки) должно быть закоммичено и запушено через PR-flow до закрытия сессии. Гейт встроен в `/close_session` (§9.5, `scripts/git_sync_check.ps1 -Gate`); SessionStart-хук в `.claude/settings.json` предупреждает о несинхроне на входе (`-Warn`, не блокирующий). Ручной шаг владельца: отключить тумблер Cowork «Classify session states», иначе сессия может уйти в авто-архив с незапушенной работой.

## Autonomy (gate-replaced) — brain [#027](../brain_matrica/cross-project-ideas/ideas/027-gate-replaced-autonomy.md) (mandate)

Владелец почти всегда соглашается на «окей на дифф/мерж/деплой» → человеческое «окей» — слабый гейт (ритуал). Заменяем его **автоматическими гейтами**: автономия безопасна ⟺ гейты зелёные. Настроено в коммитимом [`.claude/settings.json`](.claude/settings.json) (`permissions.defaultMode: auto` + узкие `allow`/`deny` + `autoMode.soft_deny`).

**Ярусы по риску:**
- **Правки файлов, ветки, коммиты, PR, авто-мерж** — авто, без переспрашивания. **Подтверждение = зелёные гейты:** build `shared`+`ledger` → `corepack pnpm -r typecheck` + `lint` → `corepack pnpm -F @matricarmz/backend-api test` → **CDP e2e-smoke** (`verifier-electron`, skill `verify`) при UI-правках → CI зелёный. Прогонять перед мержем; красный гейт = стоп, чиню, не мержу.
- **Деплой на прод** — авто под smoke-гейтом (`/health` + `/updates/status` после рестарта) и лёгким откатом; деплои сериализованы (не внахлёст).
- **Работа всегда внутри PR-flow** (ADR-0002): авто-PR + авто-мерж, **не** прямой push в main (`deny` в settings).

**⚠️ Черту НЕ пересекать (brain [#025](../brain_matrica/cross-project-ideas/ideas/025-destructive-prod-confirm-same-turn.md) / GOTCHAS G29):** необратимые операции с **живыми прод-данными** — `DROP`/`DELETE`/`UPDATE`/`TRUNCATE` на прод-БД, `db:migrate`/Drizzle-миграции на проде, `systemctl stop` прод-сервисов, `rm` на прод-путях, `git reset --hard` на прод-checkout — **остаются под явным подтверждением в том же ходе**. Реализовано через `autoMode.soft_deny` (семантический гейт классификатора, очищается явным намерением — надёжнее prefix-матча для ssh-обёрнутых команд). Это ровно класс инцидента `client_settings` 76→39. Read-only прод-probe (`systemctl is-active`, `curl /health`, `git log`) — авто.

## Два режима проекта

1. **Dev-режим** (`/start`, по умолчанию) — разработка программы. Источники правды: SESSION_HANDOFF / CODEBASE_MAP / PENDING_FOLLOWUPS. `docs/zavod/` **не читает** по умолчанию; исключение — точечный взгляд в [`docs/zavod/FACTORY_MODEL.md`](docs/zavod/FACTORY_MODEL.md), если строимая фича касается описанного там производственного процесса.
2. **Завод-режим** (`/zavod`) — консультант по организации производства (бригады, процессы, отчётность ППО), НЕ программист. Источники: только `docs/zavod/` (FACTORY_MODEL, INDEX, PROGRAM_EFFECTS, inbox) + код точечно для заземления советов. Dev-гущу (handoff/pending/планы) не читает, код не правит.

Мост между режимами — [`docs/zavod/PROGRAM_EFFECTS.md`](docs/zavod/PROGRAM_EFFECTS.md): журнал эффектов программы (зачем сделано → что улучшило, в каком модуле), заполняется в dev-`/close_session` §7.5 при отгруженной функциональности. Обратный мост: идеи ППО, дозревшие до «делаем в программе», приходят в dev-поток задачами (через владельца или PENDING_FOLLOWUPS).

## Команды управления сессией

- `/start` — онбординг новой сессии: подхватывает SESSION_HANDOFF, синхронизируется с origin, читает три источника правды, докладывает состояние. NL-триггеры: «начни сессию», «начни сессию разработки».
- `/close_session` — закрытие сессии: сохраняет «куда мы шли» в SESSION_HANDOFF, коммитит+пушит **всё** через PR-flow и не закрывает сессию, пока sync-гейт не зелёный (§9.5). NL-триггеры: «закрой сессию», «заверши сессию».
- `/reliz` — выпуск нового релиза согласно [Release process](#release-process). Деплой/релиз — отдельный осознанный шаг, **не** часть закрытия сессии. NL-триггеры: «создай релиз», «выпусти релиз».
- `/zavod` — производственная сессия-консультант (завод-контур, см. «Два режима проекта»). NL-триггеры: «поговорим про завод», «производственная сессия».

## Project overview
MatricaRMZ is an Electron + Node.js desktop application for engine repair plant management.
Monorepo structure:
- `electron-app/` — Electron desktop client (React + TypeScript)
- `backend-api/` — Express REST API + SQLite via Drizzle ORM
- `shared/` — shared types and domain logic (TypeScript)
- `web-admin/` — web admin panel
- `scripts/` — release automation scripts

## TypeScript config
`exactOptionalPropertyTypes: true` is enabled. **Never assign `undefined` to optional fields.**
Use conditional spread instead: `...(x.val ? { field: String(x.val) } : {})`

## EAV system
Entity attributes are stored in the `attribute_values` table (EAV pattern).
No DDL migrations needed when adding a new attribute — use `setAttr(entityId, attrName, value)`.
New attributes must be registered in `ensureAttributeDefs` inside `SimpleMasterdataDetailsPage.tsx`.

## Release process

**Версия — CalVer, генерируется автоматически.** Номер релиза НЕ выбирается вручную (никаких patch/minor/major). `node scripts/bump-version.mjs` штампит версию из текущей даты: `YYYY.(MM*100+DD).(HH*100+MM)` — напр. `2026.614.1530` (14 июня 2026, 15:30). Это валидный монотонный semver без ведущих нулей → весь конвейер (electron-updater/`latest.yml`, тег `v*`, `/health`, ledger-publish) работает как раньше. Канонический генератор/парсер — `shared/src/domain/calver.ts`; оператору версия показывается **датой сборки** (`formatCalverBuildDate`). Ниже `X.Y.Z` = сгенерированный CalVer. `--set X.Y.Z` — только аварийный ручной оверрайд.

1. `node scripts/bump-version.mjs` — штампит CalVer от текущей даты в `VERSION` + все `package.json` (печатает итоговый `X.Y.Z`).
2. Add entry to `shared/src/domain/releaseWelcome.ts` (prepend to `RELEASE_WELCOME_HISTORY`; `releaseLabel` = сгенерированный CalVer, текст «что нового» — человеческий). **Обязательно задать `epigraph`** — новую цитату-эпиграф для welcome-окна (показывается вверху вместо заголовка, мельче): юмор/афоризм про завод / машиностроение / механосборку / инструменталку / бухгалтерию, чтобы поднять настроение; можно составить по теме релиза. **Новый эпиграф на каждый релиз** (не повторять прежние; оригинальный текст, не копировать чужие защищённые цитаты).
3. Open PR (per `## Git flow`). After merge: `git tag vX.Y.Z` on fresh `main` → `git push origin vX.Y.Z` (GitHub Actions triggers installer build).
4. On prod server: `git pull --ff-only && corepack pnpm install && corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build`.
   > ⚠️ **Если `pnpm install` виснет на VPS** (на `added N-1/N` или зомби-процессом) — это флаки-сеть + бесполезная закачка electron-бинаря; гнать `env ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_fetch_timeout=45000 npm_config_fetch_retries=10 corepack pnpm install` (GOTCHAS **M16**). Для code-only релиза (lockfile не менялся) install можно вовсе пропустить — только build серверных пакетов. Застрявшие install'ы убивать по PID, НЕ `pkill -f 'corepack pnpm install'` (самоматчит ssh-команду).
   > ⚠️ **На проде собираются ТОЛЬКО серверные пакеты** (`shared` / `backend-api` / `web-admin`): backend-сервис запускается из **скомпилированного** `backend-api/dist/index.js` (systemd `ExecStart=node …/dist/index.js`), поэтому их build обязателен. **Electron-КЛИЕНТ (`.exe`) собирается GitHub Actions** (workflow «Release Electron Windows», триггерится тегом на шаге 3) и на прод приходит **готовым артефактом** — только скачивается (шаг 7), **никогда не собирается на проде**. **Не запускать на проде нефильтрованный `pnpm build` / `pnpm -r build`** — он соберёт и `electron-app` (клиент); всегда явный `-F` на серверные пакеты. (Повторяющаяся путаница — см. memory `prod-deploy-no-client-build`.)
5. **Apply DB migrations explicitly** — `corepack pnpm -F @matricarmz/backend-api db:migrate`. Drizzle migrations do **not** run automatically when services restart; the `db:migrate` script must be invoked between `build` and `restart` whenever the release ships a new `backend-api/drizzle/*.sql` file. Skipping this leaves services starting against an outdated schema (e.g. v1.22.0 backfill script failed because `component_type_id` column was missing until `db:migrate` was run).
6. Run release-specific backfill scripts if the release ships them (e.g. v1.22.0 → `warehouse:migrate-component-type` dry-run then `--apply`). Document row counts in the release PR body (git is the history of record).
7. **Prepare the updater artifacts BEFORE restarting** (the order matters — see note). After the GitHub Action builds the installer, download **all three artifacts** to `/opt/matricarmz/updates/` — `.exe`, `latest.yml`, `*.blockmap`. **Fetch the `.blockmap` in its OWN `gh release download` call** — the multi-pattern command reproducibly drops it (skipped on v2026.624.49, v2026.624.1021 **and** v2026.624.1153 — no longer "non-deterministic", treat it as expected; see GOTCHAS **M18**). Run from inside the repo (gh needs git context):
   ```bash
   gh release download vX.Y.Z --pattern "*.exe" --pattern "latest.yml" -D /opt/matricarmz/updates --clobber
   gh release download vX.Y.Z --pattern "*.blockmap" -D /opt/matricarmz/updates --clobber   # separate call — multi-pattern drops it
   ```
   > ⚠️ **Verify all three landed** (`ls /opt/matricarmz/updates/ | grep <version>` → `.exe`, `.exe.blockmap`, `latest.yml`; `latest.yml` has no version in its name). A missing blockmap makes `/updates/file/<exe>.blockmap` return 404 → clients lose delta and full-download the installer (~116 МБ vs ~10 МБ). Confirm after restart: `curl -fsSk -o /dev/null -w '%{http_code}' https://127.0.0.1/updates/file/<exe>.blockmap` → `200`.
8. `corepack pnpm release:ledger-publish X.Y.Z` — writes `latest.json` / `latest.torrent` into the updates dir. Still **before** restart.
9. Restart services: `sudo systemctl restart matricarmz-backend-primary.service matricarmz-backend-secondary.service`. Verify with `curl -fsk https://127.0.0.1/health` (should report new version).
10. Verify clients will see the update: `curl -fsSk https://127.0.0.1/updates/status` must report `latest: { version: "X.Y.Z", ... }` (not `null` and not the previous version).

> **Why download + ledger-publish go before restart** (learned v1.34.2): `updateTorrentService` reads the updates dir into in-memory state **at process startup** and only re-scans on a long interval. If you restart while the dir still holds the previous installer, `/updates/status` reports the old version until the next scan (or a second restart). Preparing all artifacts first means the post-restart scan reads the final `latest.yml` / `latest.json` immediately. The DB-touching steps (5, 6) still run between `build` and `restart`.

**SSH tips for these steps** (don't retry blindly):
- **External SSH port is `49217`.** myjino port-forwards **external `49217` → internal `49412`** (sshd listens on 49412 on the VM). Connecting to `49412` from outside fails — it's the internal port, not exposed — and the symptom is a TCP timeout / "Connection timed out during banner exchange" while `ping a6fd55b8e0ae.vps.myjino.ru` still answers instantly. **If `ssh matricarmz` times out, check the port FIRST** (`~/.ssh/config` → `Host matricarmz` must have `Port 49217`), before suspecting fail2ban. The myjino panel ("Перенаправление портов") shows the mapping.
- Each dev machine uses its **own isolated ed25519 key** authorized on prod (see `PROJECT_STATE.md` SSH history), and the `matricarmz` config block MUST set `IdentitiesOnly yes`. Without it, ssh offers every local key — each a failed auth — and fail2ban bans the IP (then even the correct port shows TCP-filtered, masquerading as a network problem). Unban / re-authorize a key via the myjino.ru panel console (`fail2ban-client unban <IP>`; append pubkey to `valstan`'s `~/.ssh/authorized_keys`).
- Always pass `-o ConnectTimeout=15` so a real glitch fails fast (default is 60s+). Don't loop on failures — diagnose port → key/`IdentitiesOnly` → fail2ban, in that order.

## Prod server
SSH: alias `matricarmz` (`~/.ssh/config`) → `valstan@a6fd55b8e0ae.vps.myjino.ru` **port 49217** (external; myjino forwards `49217 → 49412` internal). Per-machine isolated ed25519 key + `IdentitiesOnly yes` (see §SSH tips above and `PROJECT_STATE.md`). fail2ban is active — repeated wrong-key attempts ban the IP (unban via myjino.ru panel).
Services: `matricarmz-backend-primary.service` and `matricarmz-backend-secondary.service`
Updates dir: `/opt/matricarmz/updates/`
Health check: `curl -fsk https://127.0.0.1/health`
Updates status: `curl -fsSk https://127.0.0.1/updates/status`

## Key architecture decisions
- Services (услуги) belong to the Supply (Снабжение) menu group
- `engine_brand_ids` attribute on services: JSON array of engine brand entity IDs, stored via EAV
- Service card origin tracking: `serviceOriginTab` state in App.tsx — close returns to opening tab
- Work order service dropdown filtered by selected engine's brand; universal services (no brands) always shown
- BOM ↔ engine brands: M:N junction table `bom_engine_brands`
- Ledger encryption: keyring format (enc:v2) with multiple keys, backward-compat with enc:v1
- **Client display rule:** wherever a program client/installation is shown (UI, diagnostics, audit, critical events, ops/SQL reports), show the **login + ФИО** of the user, not just the machine name (machine names mean nothing to the owner; he knows people by login/surname). Login lives in `client_settings.lastUsername` (app login, captured on heartbeat); ФИО is resolved on read via `resolveLoginsToFullNames` (employee `login` → `full_name`, EAV — no schema change). Format via `shared/src/domain/clientLabel.ts` (`formatClientLabel`/`formatClientShort`) — use it everywhere so the rule holds technically.

## Code style
- No comments unless the WHY is non-obvious
- No error handling for impossible cases
- No abstractions beyond what the task requires
- Prefer editing existing files to creating new ones
