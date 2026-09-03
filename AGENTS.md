# AGENTS.md — единые правила для AI-агентов MatricaRMZ

Этот файл — **единственный канонический вход для любой нейросети**: Claude Code, Codex, Gemini CLI и других агентов. Vendor-файлы (`CLAUDE.md`, `GEMINI.md`, …) — тонкие адаптеры: они указывают на инструмент-специфичное, но **не дублируют и не переопределяют** проектные правила. Копия канона расходится с оригиналом молча — это уже случилось здесь однажды (см. [ADR-0011](../brain_matrica/adr/0011-vendor-neutral-agent-contract.md)).

## Language
All final messages, summaries, explanations, and recommendations to the user must be in **Russian**.
Internal reasoning, code comments, commit messages, identifiers — in English (as used in the project).

## Конституция — приоритетное чтение

**Прежде всего — [`docs/CONSTITUTION.md`](docs/CONSTITUTION.md):** компактный слой **принципов** проекта (ценности, из которых выводятся решения и против которых проверяются задачи). Читать **первым**; процедуры/гейты ниже — точечно. Включает статью «Claude — активный советник с предохранителями» (предлагай лучший путь раз и коротко, поднимай флаг последствий *до* реализации, идеи — в бэклог, решение за владельцем, анти-спам — закон). Статья относится к **любому агенту**.

## Источники правды для продолжения работы

Эти файлы хранят состояние разработки между сессиями, между компьютерами и **между моделями**. Читать в начале каждой новой сессии (это делает `/start`).

**Раскол «открытое vs сделанное» ([план memory-reorg](docs/plans/_archive/memory-reorg-2026-06.md), образец Мозга):** рабочие файлы держат **только открытое**; завершённое уходит в тонкий done-индекс + git/PR. Это убирает «всплытие уже сделанного» и токены холодного старта.

- [`docs/SESSION_HANDOFF.md`](docs/SESSION_HANDOFF.md) — **sticky-note последней сессии**: текущая активная нитка, следующий шаг, ссылка на план. **Только активное** — без дампа завершённого. Обновляется в PR каждого шага нитки (D-066), страховочно — `/close_session`; читается `/start` и SessionStart-хуком. Перезаписывается целиком — история через `git log -- docs/SESSION_HANDOFF.md`. **Читать всегда.**
- [`docs/CODEBASE_MAP.md`](docs/CODEBASE_MAP.md) — **карта монорепо**: где живёт X, когда сюда лезть. Куратируемый markdown ≤2 экрана, не автогенерируется. Читать **вместо** широкой разведки `docs/` или файловых поисков «на ощупь». «Карта прежде разведки» — [ADR-0003 brain_matrica](../brain_matrica/adr/0003-token-economy-principles.md). **Читать всегда.**
- [`docs/PENDING_FOLLOWUPS.md`](docs/PENDING_FOLLOWUPS.md) — **только открытые** задачи/техдолги/отложенные (🔴 / ⏳ / 🟡 / 🟢) + метки старения. Завершённое сюда **не кладём** (выпиливается при закрытии). **Читать только если задача про open issues.**
- [`docs/COMPLETED.md`](docs/COMPLETED.md) — **done-индекс (Tier-1):** 1 строка на завершённую нитку/релиз. Не дублирует git/PR — только навигация «это уже сделано?». **Читать по требованию**, `/start` его не читает.
- [`docs/GOTCHAS.md`](docs/GOTCHAS.md) — **проектные грабли по симптомам** (Tier-1 индекс + записи). **Грепать перед долгой отладкой**, `/start` не читает. Кросс-проектные — в `../brain_matrica/cross-project-ideas/GOTCHAS.md`.
- [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) — архитектурное состояние, правила, устаревшие решения. **Читать только если задача про архитектуру / прод / релизный контур.**
- [`docs/plans/`](docs/plans/) — **активные** многоэтапные планы. Завершённые → [`docs/plans/_archive/`](docs/plans/_archive/). **При планировании создавай файл сразу здесь** (`docs/plans/<slug>.md`), а не в служебном каталоге своего инструмента — иначе план не виден на других компах и другим моделям.
- [`docs/machines/<hostname>.md`](docs/machines/README.md) — **профиль окружения этого компа**: порты dev-стенда (PG/backend/vite/CDP), пути к инструментам, как поднимать скиллы (`verifier-electron`), машинные грабли. По файлу на hostname (правит только свой комп → нет межмашинных конфликтов). `/start` §0.5 читает свой по hostname; **пиши по мере изучения** «как тут запускается X». Без секретов. **Читать всегда** (свой). Конвенция — [`docs/machines/README.md`](docs/machines/README.md).

**Принцип token economy:** `SESSION_HANDOFF` + `CODEBASE_MAP` + `docs/machines/<hostname>.md` — обязательны на старте. `PENDING_FOLLOWUPS` / `COMPLETED` / `GOTCHAS` / `PROJECT_STATE` читаются **по требованию задачи**, не безусловно (ADR-0003). История релизов — `git log` + тело PR; тонкая навигация по ней — `COMPLETED.md`.

## Cross-project knowledge base

Кросс-проектный pool идей, tech-radar, реестр проектов и cross-project ADRs — в meta-репо [`brain_matrica`](https://github.com/Valstan/brain_matrica). Локально: `../brain_matrica/` (если все репо клонированы в одну родительскую папку, например `D:\GitHubReps\`).

Перед предложением переносимой идеи (фишка из MatricaRMZ, которая может пригодиться в GONBA/setka, или наоборот) — глянь `<brain_matrica>/cross-project-ideas/INDEX.md`. Новые идеи добавляй **в brain_matrica отдельной сессией**, не из этого репо. При применении идеи у себя — отметь `✅ YYYY-MM-DD` в её таблице.

**Consult-library рефлекс (pool #014, условный триггер):** перед вводом в проект **нового инструмента/библиотеки/паттерна** (не рутинная правка) — глянь [`brain_matrica/cross-project-ideas/REFERENCE.md`](../brain_matrica/cross-project-ideas/REFERENCE.md) / tech-radar: возможно, экосистема уже выбрала решение или отвергла кандидата. Триггер условный — только на «вводим новое», не шаг каждой сессии.

**ADR-0007 «тактика напрямую, знание через курацию»:** любой sibling-репо можно **читать read-only напрямую** (`../<project>/`) для тактических фактов — API-контракт, форматы, docs, handoff соседа. **Соседние репо не синхронизируются** (brain D-008): ни `fetch`, ни `pull`, ни `checkout` в чужих репо — только чтение того, что лежит локально (незакоммиченное чужое тоже видно и свежее закоммиченного). Писать/коммитить в чужой репо нельзя; прочитанное — не контракт (зависимость от чужого API = интеграция → письмо в мозг). Знание/директивы/переносимые уроки — по-прежнему через mailbox.

**Mailbox-протокол ([ADR-0001](../brain_matrica/adr/0001-brain-projects-mailboxes.md), асимметричный с 2026-05-23):** каждая сторона пишет только в свой репо.

- **brain → MatricaRMZ:** brain пишет в `../brain_matrica/mailboxes/MatricaRMZ/from-brain/*.md`. Мы читаем **двухканально, без синхронизации чужого репо** (brain D-008): локально `../brain_matrica/mailboxes/MatricaRMZ/from-brain/*.md` (как есть, без `pull`) + через GitHub API/веб `main` того же проекта (`mailbox/to-brain/*.md`), без clone/fetch/pull. Свежесть — по истории именно этого пути, набор = объединение источников (детали — в `/start` §0).
- **MatricaRMZ → brain:** мы пишем в [`mailbox/to-brain/`](mailbox/to-brain/) **этого** репо. brain читает через `git pull` MatricaRMZ.
- **`ref:` в ответном письме — full-slug письма, на которое отвечаем** (с датой, без `.md`): `ref: 2026-07-28-gate-audit-104`. Номер идеи, тема или пересказ мандата на этом месте не работают — их место в теле. Счётчик открытых директив у brain сопоставляет ответ с оригиналом **ровно по этой строке**: неверный `ref:` = ответ виден человеку и невидим счётчику, директива висит «просроченной», и brain по постулату 38 эскалирует сделанную работу как тишину (ADR-0001 §Правила п.5, brain G233).
- **Шеринг находок (pool #009):** значимые *переносимые* находки (скилл/фича/паттерн/решённая нетривиальная боль) отправляем в brain через `mailbox/to-brain/` — не только по явной просьбе. Фильтр (слать только если все три: значимость + переносимость + неочевидность) и шаг встроены в `/close_session`. По умолчанию — молчим.
- Запись/коммит в `../brain_matrica/` из проектной сессии **запрещён** (никаких `.last-seen`, никакой архивации, никакого `to-brain/` в чужом репо).
- `/start` §0 сканит входящие и докладывает в формате `[urgency COMPLIANCE] slug — topic`. Compliance: `MAY/SHOULD/MUST` (suggest/recommend/mandate, RFC 2119). Письма kind=directive/idea без поля compliance — читать как `MUST`/`SHOULD` соответственно.

## Git flow

**PR-only flow ([ADR-0002](../brain_matrica/adr/0002-pr-only-flow-no-direct-push.md)).** Прямой `git push origin main` запрещён. Любое изменение:

```bash
git checkout -b <type>/<slug>        # feat/ fix/ chore/ docs/ refactor/
# … работа, коммиты …
git push -u origin <type>/<slug>
gh pr create --title "..." --body "## Summary ... ## Test plan ..."
# подтверждение — зелёные гейты, не человеческое «окей» (см. §Autonomy)
gh pr merge --squash --delete-branch   # squash по умолчанию; merge commit — для длинных серий
git checkout main && git pull
```

- Slug — kebab-case, описательный (`feat/work-order-bom-tree-view`, `fix/payroll-signature-fio`).
- Один PR — одна задача. Коммиты — Conventional Commits. Трейлер `Co-Authored-By: <агент и его фактическая версия> <noreply-адрес вендора агента>` (у Claude — `noreply@anthropic.com`) — каждый агент подписывается собой; имя модели и адрес в памятках не пинятся.
- Релиз = merge PR → `git tag vX.Y.Z` на свежем `main` → `git push origin vX.Y.Z` (GitHub Actions триггерит installer build).
- **Force-push в `main` — запрещён**; в feature-ветку — разрешён (rebase / amend перед merge).
- **Hot-fix исключение:** прод упал → допустим direct push, но обязательный follow-up PR постфактум с описанием инцидента.
- Branch protection на GitHub для `main`: require PR, disallow force push, disallow deletion, **`enforce_admins=true`** — правило действует и для администратора: прямой апдейт `refs/heads/main` отклоняется сервером (`422 Changes must be made through a pull request`). **Аварийный выход** (прод упал, hot-fix мимо PR): `gh api -X DELETE repos/Valstan/MatricaRMZ/branches/main/protection/enforce_admins` — одна команда; после инцидента включить обратно тем же путём с `-X POST` + follow-up PR (см. «Hot-fix исключение» выше).

**GitHub — источник истины между машинами ([brain #010](../brain_matrica/cross-project-ideas/ideas/010-session-sync-safeguard.md), mandate).** Работа ведётся на разных компах; не оставляй сессию с несинхронизированной работой. Всё (код + доки) должно быть закоммичено и запушено через PR-flow до закрытия сессии. Гейт встроен в `/close_session` (§9.5, `scripts/git_sync_check.ps1 -Gate`); У Claude Code SessionStart-хуки в `.claude/settings.json` дополнительно предупреждают о несинхроне на входе (`git_sync_check.ps1 -Warn`, не блокирующий) и печатают `git status`, последние коммиты и handoff в контекст (`session_start.ps1`, D-066) — сессия стартует в теме, что бы владелец ни набрал первым; агент без хуков делает то же руками в `/start` §1–2. Ручной шаг владельца: отключить тумблер Cowork «Classify session states», иначе сессия может уйти в авто-архив с незапушенной работой.

## Сосуществование нескольких агентов

Владелец работает в репо разными нейросетями. Два конфликта, которые это создаёт, снимаются правилами ниже ([ADR-0011](../brain_matrica/adr/0011-vendor-neutral-agent-contract.md)).

**Файловый конфликт:**

- Один агент — одна задача — своя ветка. **Не запускай двух пишущих агентов в одном рабочем дереве**; при одновременной работе второй берёт отдельный `git worktree`.
- Перед правкой смотри `git status`. **Незнакомые изменения считай чужими:** не удаляй, не форматируй попутно, не включай в свой коммит, не прячь в `stash`.
- Не переключай ветку в рабочем дереве, которым может пользоваться другой агент.
- Объявляй границы (файлы/задача) в описании PR. Границы пересеклись — второй ждёт merge первого и ребейзит свою ветку до начала правок.
- Не клади временные файлы в дерево репо: параллельная сессия с `git add -A` их подхватит. Временное — в скретчпад своего инструмента или в изолированный worktree.

**Мнемонический конфликт:**

- **Чат одной модели не источник истины для другой.** Межмодельная память — только артефакты: Git/PR, [`docs/SESSION_HANDOFF.md`](docs/SESSION_HANDOFF.md), остальные `docs/` (`PENDING_FOLLOWUPS`/`COMPLETED`/`GOTCHAS`/`PROJECT_STATE`/`machines`), `mailbox/`, ADR в brain. Локальная память агента (`memory/` и подобное) — только преференции владельца и его корректировки; проектный факт или грабля кладётся в `docs/` (GOTCHAS/PENDING/machines), не в локальную память.
- После обрыва восстанавливай фактическое состояние **из Git/PR и `docs/SESSION_HANDOFF.md`**, не повторяй действия по памяти чата: незакоммиченную правку перечитай в файле, а не вспоминай (завершена или оборвана на полпути?); коммит при `ahead>0` уже лёг — не пересоздавай; перед `gh pr create` проверь `gh pr list` — PR мог быть открыт до обрыва.
- Код-файл, который `git diff --stat` показывает как `Bin`, — битая запись (NUL / UTF-16 / BOM): Windows `Out-File`/`Set-Content` по умолчанию пишут UTF-16 — всегда `-Encoding utf8`. Вычистить NUL и пересохранить UTF-8: `node -e "const fs=require('fs'),f=process.argv[1],b=fs.readFileSync(f),n=[...b].filter(x=>x===0).length;console.log(f,'NUL',n);if(n)fs.writeFileSync(f,Buffer.from([...b].filter(x=>x!==0)))" '<путь>'` (brain G21).
- Решение, которое должно пережить сессию, обязано лечь в файл. Не оставленное в файле для следующей модели не существует.

## Какие AI-файлы хранить в Git

**Коммитить:**

- `AGENTS.md` — канон, единственный источник правды для агентов;
- `CLAUDE.md`, `GEMINI.md` — короткие адаптеры к `AGENTS.md`;
- `.claude/commands/`, `.claude/agents/`, `.claude/skills/`, `.claude/scripts/`, `.claude/settings.json` — общие команды, скиллы, хуки и безопасные разрешения;
- `docs/**`, `mailbox/**` — проектная документация и почта.

**Не коммитить:**

- локальные разрешения и персональные настройки (`.claude/settings.local.json`);
- кэши/сессии моделей (`.codex/`, `.gemini/`, `.claude/worktrees/`) и временные планы вне `docs/plans/`;
- `.env*`, ключи, токены, логи, артефакты сборки, временные файлы.

Секреты не должны жить в репозитории даже под защитой `.gitignore` — **репо публичный**.

### Публичный репозиторий — тоже recon-поверхность (brain D-038, 2026-08-23)

Правило сформулировано **через свойство, а не через канал**: неважно, «на витрине» это, «в доках» или «в комментарии к коду» — репо публичен с 2026-08-17, и любой отслеживаемый файл читает кто угодно. В отслеживаемые файлы **не кладём ничего, что идентифицирует прод-хост, аккаунт на нём или хостера**:

- IP-адреса и хостнеймы прода в прозе; имя хостера и его панель;
- внешние и внутренние SSH-порты, топологию порт-форварда;
- имена SSH-ключей, их отпечатки и комментарии; имя пользователя на сервере и пути вида `/home/<user>/…`;
- ёмкость VPS (RAM/CPU/диск), тариф, соседей/жильцов на том же сервере;
- пороги fail2ban/UFW и точный список открытых портов, содержимое `/etc/hosts`, `sshd_config`;
- внутренние URL, id чатов и ботов.

Это касается **всех** отслеживаемых файлов: доков, планов, `docs/machines/*` (там — только dev-стенд), комментариев в коде, скриптов, конфигов, `.claude/`. Нужна конкретика — она живёт в `~/.ssh/config`, gitignored `*.env*` и `.claude/settings.local.json`; другому агенту её даёт владелец, а не документ.

Допустимое — граница осознанная, не лазейка:

- **публичный URL API** (он же хостнейм прода) как дефолт в коде клиентов (`electron-app/src/main/index.ts`, `stub-updater/main.go`, `android-app/vite.config.ts`, `.env.example`) и в nginx-конфиге: он зашит в каждый выпущенный бинарь и в `latest.yml`, прятать его некуда. В прозе доков его не повторяем — пишем «прод»;
- **SSH-алиас `matricarmz`** — единственный способ сослаться на сервер в доках и командах; хост, порт, пользователь и ключ живут в `~/.ssh/config` на машине;
- **инсталляционная раскладка самого приложения** (`/opt/matricarmz/…`, `/etc/matricarmz/…`, `/usr/local/sbin/matricarmz-*`, имена systemd-юнитов) — это описание приложения, а не хоста. Домашний каталог сервисного пользователя пишется как `~/MatricaRMZ` / `$HOME`, systemd-юниты — шаблонами с подстановкой при установке (`deploy/systemd/install-backend.sh`);
- **закрытые записи** (`mailbox/to-brain/`, `docs/plans/_archive/`, `docs/_archive/`, тексты прошлых релизов в `releaseWelcome.ts`) не переписываем — это записи о том, что было сказано и решено; их правка была бы подделкой переписки, а не гигиеной. Вычистка ничего не отзывает: история публична с первого коммита. `docs/COMPLETED.md` — **не** закрытая запись, а живой индекс (в него дописывают каждый релиз): recon-детали в нём не трогали, ПДн — убрали (см. ниже, D-041).

### Персональные данные сотрудников (brain D-041, 2026-08-24)

Правило того же вида, что и recon-поверхность, и по тому же свойству — **репо публичен, отслеживаемый файл читает кто угодно**. В отслеживаемых файлах не держим **ФИО и рабочие логины сотрудников**: ни в коде и комментариях, ни в тест-фикстурах, ни в подписях UI, ни в прозе доков и планов.

- **Одноразовым скриптам данные приходят снаружи** — аргументом запуска или файлом вне репо (`--restricted-editor=<login>`), а не литералом в коде. Отработавший скрипт без встроенного маппинга теряет смысл — такой удаляем целиком (git помнит).
- **Фикстуры тестов — вымышленные** (`owner1`, `buh`, `oper`, «Иванова Мария Петровна»). Реальный логин в фикстуре не делает тест правдивее.
- **В прозе — роль, а не человек:** «оператор», «главбух», «ограниченная владелица закрытых нарядов». Ссылка на инцидент — по дате и PR, без фамилии.
- **Правим то, во что ещё пишем:** код, тесты, `PENDING_FOLLOWUPS`, `COMPLETED`, планы в работе, `docs/zavod/PROGRAM_EFFECTS.md`, профили машин. Закрытые записи (список выше) и git-историю — нет.
- **Осознанное исключение:** логин суперадмина `valstan` — он зашит в продукт (`employeeAuthService.ts`) и совпадает с GitHub-хэндлом владельца, прятать нечего.

## Autonomy (gate-replaced) — brain [#027](../brain_matrica/cross-project-ideas/ideas/027-gate-replaced-autonomy.md) (mandate)

Владелец почти всегда соглашается на «окей на дифф/мерж/деплой» → человеческое «окей» — слабый гейт (ритуал). Заменяем его **автоматическими гейтами**: автономия безопасна ⟺ гейты зелёные. У Claude Code это настроено в коммитимом [`.claude/settings.json`](.claude/settings.json) (`permissions.defaultMode: auto` + узкие `allow`/`deny` + `autoMode.soft_deny`); агент без такого механизма соблюдает те же ярусы вручную.

**Ярусы по риску:**
- **Правки файлов, ветки, коммиты, PR, авто-мерж** — авто, без переспрашивания. **Подтверждение = зелёные гейты:** build `shared`+`ledger` → `corepack pnpm -r typecheck` + `corepack pnpm -F @matricarmz/electron-app typecheck:test` + `lint` → `corepack pnpm -r test` → **CDP e2e-smoke** (`verifier-electron`, skill `verify`) при UI-правках → CI зелёный. Прогонять перед мержем; красный гейт = стоп, чиню, не мержу.
  - Тестовый гейт — всё монорепо, не один `backend-api`: правила проекта живут и в клиенте (пример — тест-сторож «оператору не показывают служебный код», `electron-app/src/main/services/reports/humanLabels.guard.test.ts`).
  - `typecheck` **не покрывает тест-файлы** (у `electron-app` они исключены из `tsconfig.json`), поэтому `typecheck:test` — отдельный шаг, а не дубль.
  - **На малоядерной машине `-r test` даёт случайный красный — это перегруз, а не регресс** (`pnpm -r` поднимает четыре пакета разом, каждый со своим пулом потоков vitest). Красный тест вне зоны твоей правки — перезапусти файл одиночно (`corepack pnpm -F <пакет> exec vitest run <путь>`); зелёный в одиночку = перегруз, гейт пройден. Гарантированный прогон — `corepack pnpm -r --workspace-concurrency=1 test` (зелёный целиком, дольше в разы). Список случаев — `docs/PENDING_FOLLOWUPS.md` §«Параллельный -r test».
- **Деплой на прод** — авто под smoke-гейтом (`/health` + `/updates/status` после рестарта) и лёгким откатом; деплои сериализованы (не внахлёст).
- **Работа всегда внутри PR-flow** (ADR-0002): авто-PR + авто-мерж, **не** прямой push в main.

**⚠️ Черту НЕ пересекать (brain [#025](../brain_matrica/cross-project-ideas/ideas/025-destructive-prod-confirm-same-turn.md) / GOTCHAS G29):** необратимые операции с **живыми прод-данными** — `DROP`/`DELETE`/`UPDATE`/`TRUNCATE` на прод-БД, `db:migrate`/Drizzle-миграции на проде, `systemctl stop` прод-сервисов, `rm` на прод-путях, `git reset --hard` на прод-checkout — **остаются под явным подтверждением в том же ходе**. У Claude Code это реализовано через `autoMode.soft_deny` (семантический гейт классификатора, очищается явным намерением — надёжнее prefix-матча для ssh-обёрнутых команд). Это ровно класс инцидента `client_settings` 76→39. Read-only прод-probe (`systemctl is-active`, `curl /health`, `git log`) — авто.

## Два режима проекта

1. **Dev-режим** (`/start`, по умолчанию) — разработка программы. Источники правды: SESSION_HANDOFF / CODEBASE_MAP / PENDING_FOLLOWUPS. `docs/zavod/` **не читает** по умолчанию; исключение — точечный взгляд в [`docs/zavod/FACTORY_MODEL.md`](docs/zavod/FACTORY_MODEL.md), если строимая фича касается описанного там производственного процесса.
2. **Завод-режим** (`/zavod`) — консультант по организации производства (бригады, процессы, отчётность ППО), НЕ программист. Источники: только `docs/zavod/` (FACTORY_MODEL, INDEX, PROGRAM_EFFECTS, inbox) + код точечно для заземления советов. Dev-гущу (handoff/pending/планы) не читает, код не правит.

Мост между режимами — [`docs/zavod/PROGRAM_EFFECTS.md`](docs/zavod/PROGRAM_EFFECTS.md): журнал эффектов программы (зачем сделано → что улучшило, в каком модуле), заполняется в dev-`/close_session` §7.5 при отгруженной функциональности. Обратный мост: идеи ППО, дозревшие до «делаем в программе», приходят в dev-поток задачами (через владельца или PENDING_FOLLOWUPS).

## Два поколения программы (гейт смешения, D-031)

Матрица 4 строится в **отдельном репозитории [`Matrica4`](https://github.com/Valstan/Matrica4)** (директива D-031, план — [`docs/plans/matrica-v4-kickoff-2026-08.md`](docs/plans/matrica-v4-kickoff-2026-08.md)). Требование владельца 2026-08-17: «чтобы проекты сами меня контролировали, если я забуду, в каком я репо».

- **Стройка ядра v4 (контракт, kernel, манифесты, модули) — НЕ здесь.** На просьбу про v4-ядро отвечай «это делается в Matrica4, ты в MatricaRMZ» и требуй явного подтверждения, прежде чем что-либо делать тут.
- **Релизы и деплой клиентов парка — ТОЛЬКО отсюда** (из MatricaRMZ). В Matrica4 до стадии клиентских релизов физически нет релизных механизмов — не заводить их там.
- Что **остаётся здесь** по плану v4: трек B — финиш миграции EAV→erp_* (этапы 0–6), обычные релизные циклы v3.

## Команды управления сессией

Исполняемые памятки лежат в [`.claude/commands/`](.claude/commands/), скиллы — в [`.claude/skills/`](.claude/skills/). Несмотря на имя каталога, **их workflow применим любому агенту** — агент без slash-команд читает соответствующий `.md` и выполняет описанный порядок шагов. **Зеркал в vendor-каталогах не заводим** (`.agents/skills/` и т.п.): рваное зеркало хуже отсутствующего — агент решает, что видит всё, и молча теряет половину команд.

**Правило перевода vendor-синтаксиса ([ADR-0011](../brain_matrica/adr/0011-vendor-neutral-agent-contract.md) §5)** — читая эти файлы под другим инструментом:

- `allowed-tools:` в шапке — игнорируй (Claude-специфичное);
- `/команда` — не «Claude-фича», а «выполни шаги файла `.claude/commands/<команда>.md`»;
- `AskUserQuestion: …` — задай вопрос владельцу и **дождись явного ответа**, не продолжай по своей догадке;
- **форма любая, шаг обязателен**: отсутствие у тебя механизма ≠ отмена шага. Так снимаются прод-предохранители «как не про меня».

- `/start` ([`start.md`](.claude/commands/start.md)) — онбординг новой сессии: синхронизируется с origin, подхватывает SESSION_HANDOFF, читает источники правды, докладывает состояние. NL-триггеры: «начни сессию», «начни сессию разработки».
- `/close_session` ([`close_session.md`](.claude/commands/close_session.md)) — закрытие сессии: сохраняет «куда мы шли» в SESSION_HANDOFF, коммитит+пушит **всё** через PR-flow и не закрывает сессию, пока sync-гейт не зелёный (§9.5). Страховка, не обязанность (D-066): handoff едет в PR каждого шага нитки; команда нужна, когда шаг сделан словами в чате, при смене машины посреди нитки или когда handoff распух. NL-триггеры: «закрой сессию», «заверши сессию».
- `/reliz` ([`reliz.md`](.claude/commands/reliz.md)) — выпуск нового релиза согласно [Release process](#release-process). Деплой/релиз — отдельный осознанный шаг, **не** часть закрытия сессии. NL-триггеры: «создай релиз», «выпусти релиз».
- `/zavod` ([`zavod.md`](.claude/commands/zavod.md)) — производственная сессия-консультант (завод-контур, см. «Два режима проекта»). NL-триггеры: «поговорим про завод», «производственная сессия».

## Project overview
MatricaRMZ is an Electron + Node.js desktop application for engine repair plant management.
Monorepo structure:
- `electron-app/` — Electron desktop client (React + TypeScript)
- `backend-api/` — Express REST API + SQLite via Drizzle ORM
- `shared/` — shared types and domain logic (TypeScript)
- `web-admin/` — web admin panel
- `scripts/` — release automation scripts; `scripts/prod-ops/` — ops-скрипты прод-VPS, `scripts/client-ops/` — инструменты для машин парка (помощник по исключениям Касперского)

Где что живёт подробно — [`docs/CODEBASE_MAP.md`](docs/CODEBASE_MAP.md). Ledger (`ledger/`) участвует в релизах, синхронизации и обновлениях клиента — **не обходить его** новыми путями доставки.

## Быстрые команды разработки

Всё через `corepack pnpm` (корень репо):

| Задача | Команда |
|---|---|
| Установка и подготовка | `corepack pnpm run setup:dev` |
| Сборка общих типов | `corepack pnpm run build:shared` |
| Миграции БД | `corepack pnpm run db:migrate` |
| Backend / Electron / web-admin dev | `corepack pnpm run dev:backend` · `dev:electron` · `dev:web-admin` |
| Гейты перед мержем | `corepack pnpm -r typecheck` · `lint` · `corepack pnpm -F @matricarmz/backend-api test` |

Порты dev-стенда и особенности запуска зависят от машины — см. `docs/machines/<hostname>.md`. При изменении типов сначала пересобирается `@matricarmz/shared`, иначе зависимые пакеты типизируются по старому `dist`.

## TypeScript config
`exactOptionalPropertyTypes: true` is enabled. **Never assign `undefined` to optional fields.**
Use conditional spread instead: `...(x.val ? { field: String(x.val) } : {})`

## EAV system
Entity attributes are stored in the `attribute_values` table (EAV pattern).
No DDL migrations needed when adding a new attribute — use `setAttr(entityId, attrName, value)`.
New attributes must be registered in `ensureAttributeDefs` inside `SimpleMasterdataDetailsPage.tsx`.

**EAV-freeze (с 2026-08-18, план v4 трек B):** EAV дожимается и выводится — **новые фичи не добавляют новых EAV-атрибутов**. Новые данные идут в строгие таблицы (`erp_*` / `directory_*` / отдельная таблица); каждый новый атрибут удорожает миграцию доменов (двигатели — 28k значений). Исключение — только с явной отсылкой к [`docs/plans/matrica-v4-kickoff-2026-08.md`](docs/plans/matrica-v4-kickoff-2026-08.md) и обоснованием в PR.

## Release process

**Версия — поколение программы + порядковый номер выпуска, считается автоматически.** Номер НЕ выбирается «на глаз»: `node scripts/bump-version.mjs` берёт текущий `VERSION` и прибавляет единицу — `3.27.0` → `3.28.0`. Патч-сегмент всегда `0`, он есть только потому, что semver требует трёх сегментов. Оператору версия показывается как **«Матрица3-РМЗ (27)»** (`formatAppVersionLabel`); поколение несёт и само название программы. Канонический парсер/генератор — `shared/src/domain/appVersion.ts`. Ниже `X.Y.Z` = сгенерированный номер. `--major` — новое поколение программы со счётом выпусков заново (`3.27.0` → `4.1.0`), решение владельца. `--set X.Y.Z` — только аварийный ручной оверрайд.

> **Прежняя схема — CalVer** (`2026.814.1503`, дата сборки как semver, `shared/src/domain/calver.ts`). Клиенты на ней ещё встречаются в парке, поэтому **сравнение версий эпохо-зависимое** (`compareAppVersion`): числами `3` меньше `2026`, и без учёта эпохи новый релиз читался бы как откат назад — самообновление встало бы у всех. Правило простое: любая новая точка, где версии сравниваются или сортируются, берёт `compareAppVersion`, а не сравнение по числам. Это касается и dependency-free скриптов (`scripts/bump-version.mjs`, `scripts/upload-yandex-disk.mjs` — там формула продублирована намеренно).
>
> **Заглушка и Диспетчер (переход парка со старой нумерации).** Клиенты, выпущенные до 3.1.0, сравнивают версии по числам и сами на 3.x не обновятся. Для них старый канал `/updates/latest-meta` (запрос **без** параметра `current`) навсегда отдаёт заглушку `/opt/matricarmz/updates/stub/MatricaRMZ-Setup-2026.1231.2359.exe` (исходник `stub-updater/`, CI `stub-updater-build.yml`): она спрашивает `GET /dispatcher/update-plan` и ставит настоящий свежий дистрибутив. Новые клиенты передают `current` и получают настоящий latest. **Файл заглушки с прода не удалять** — он вечный мост для оживших древних клиентов. Диспетчер (`/dispatcher/*`) — расширяемая точка координации; клиент здоровается с ним при каждом запуске (`/dispatcher/checkin`). Если какой-то выпуск ломает прямой прыжок «со старой сразу на свежую» (формат базы, каталог, ключ) — НЕ полагаться на удачу: добавить правило в `UPGRADE_CASCADE` (`updateDispatcherService.ts`) и положить промежуточный инсталлятор в `<updatesDir>/archive/` (или указать в правиле внешнюю ссылку с size+sha256) — Диспетчер проведёт клиента каскадом.
>
> **`productName` в `electron-app/package.json` НЕ переименовывать** вслед за отображаемым именем: из него Electron выводит путь `userData`, а NSIS-инсталлятор и watchdog-handshake — свои пути. Переименование увело бы клиентов от их же локальной базы.

1. `node scripts/bump-version.mjs` — штампит следующий номер выпуска в `VERSION` + все `package.json` (печатает итоговый `X.Y.Z`).
2. Add entry to `shared/src/domain/releaseWelcome.ts` (prepend to `RELEASE_WELCOME_HISTORY`; `releaseLabel` = сгенерированный номер, `releaseDate` = дата выката `YYYY-MM-DD`).
   - **Только `highlights` — построчный список новинок. `intro` НЕ заполнять** (поле осталось необязательным ради старых записей и в окне не показывается): раньше проза дублировала список, и оператор читал одно и то же дважды, только длиннее.
   - Пишем **языком бухгалтера**: что нового, чем удобно, что теперь можно делать. Технические подробности (гонки, миграции, гейты, названия таблиц и файлов) в окно **не выносим** — им место в теле PR. Если строку нельзя объяснить без слова «синхронизация» — скорее всего, оператору она не нужна.
   - Окно показывает новинки **всех релизов за последние 2 календарных дня** (`buildReleaseWelcomeDigest`). Дату несёт поле `releaseDate` — **без него запись выпадет из окна** (прежний CalVer нёс дату прямо в номере, порядковый номер её не несёт). Несколько выкатов за день сливаются в один список — не дублируй в новой записи строки, уже сказанные сегодня.
   - **Обязательно задать `epigraph`** — новую цитату-эпиграф для welcome-окна (показывается вверху вместо заголовка, мельче): юмор/афоризм про завод / машиностроение / механосборку / инструменталку / бухгалтерию, чтобы поднять настроение; можно составить по теме релиза. **Новый эпиграф на каждый релиз** (не повторять прежние; оригинальный текст, не копировать чужие защищённые цитаты).
   - `outro` — одна короткая строка-подсказка «где это найти / как применить».
3. Open PR (per `## Git flow`). After merge: `git tag vX.Y.Z` on fresh `main` → `git push origin vX.Y.Z` (GitHub Actions triggers installer build).
   - **Тег планшета — отдельным префиксом, в том же ходе:** `git tag android-vX.Y.Z && git push origin android-vX.Y.Z`. Префиксы разведены намеренно (`android-apk-build.yml`): `v*.*.*` собирает Electron-инсталлятор и APK **не** трогает, `android-v*.*.*` собирает подписанный release-APK и публикует его GitHub Release'ом. Без этого тега планшетный парк остаётся на прежней версии, и Диспетчер честно скажет `up-to-date`.
4. On prod server: `git pull --ff-only && corepack pnpm install && corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build`.
   > ⚠️ **Если `pnpm install` виснет на VPS** (на `added N-1/N` или зомби-процессом) — это флаки-сеть + бесполезная закачка electron-бинаря; гнать `env ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_fetch_timeout=45000 npm_config_fetch_retries=10 corepack pnpm install` (GOTCHAS **M16**). Для code-only релиза (lockfile не менялся) install можно вовсе пропустить — только build серверных пакетов. Застрявшие install'ы убивать по PID, НЕ `pkill -f 'corepack pnpm install'` (самоматчит ssh-команду).
   > ⚠️ **На проде собираются ТОЛЬКО серверные пакеты** (`shared` / `backend-api` / `web-admin`): backend-сервис запускается из **скомпилированного** `backend-api/dist/index.js` (systemd `ExecStart=node …/dist/index.js`), поэтому их build обязателен. **Electron-КЛИЕНТ (`.exe`) собирается GitHub Actions** (workflow «Release Electron Windows», триггерится тегом на шаге 3) и на прод приходит **готовым артефактом** — только скачивается (шаг 7), **никогда не собирается на проде**. **Не запускать на проде нефильтрованный `pnpm build` / `pnpm -r build`** — он соберёт и `electron-app` (клиент); всегда явный `-F` на серверные пакеты.
5. **Apply DB migrations explicitly** — `corepack pnpm -F @matricarmz/backend-api db:migrate`. Drizzle migrations do **not** run automatically when services restart; the `db:migrate` script must be invoked between `build` and `restart` whenever the release ships a new `backend-api/drizzle/*.sql` file. Skipping this leaves services starting against an outdated schema (e.g. v1.22.0 backfill script failed because `component_type_id` column was missing until `db:migrate` was run).
6. Run release-specific backfill scripts if the release ships them (e.g. v1.22.0 → `warehouse:migrate-component-type` dry-run then `--apply`). Document row counts in the release PR body (git is the history of record).
7. **Prepare the updater artifacts BEFORE restarting** (the order matters — see note). After the GitHub Action builds the installer, download **all three artifacts** to `/opt/matricarmz/updates/` — `.exe`, `latest.yml`, `*.blockmap`. **Fetch the `.blockmap` in its OWN `gh release download` call** — the multi-pattern command reproducibly drops it; treat it as expected behaviour, not a flake (GOTCHAS **M18**). Run from inside the repo (gh needs git context):
   ```bash
   gh release download vX.Y.Z --pattern "*.exe" --pattern "latest.yml" -D /opt/matricarmz/updates --clobber
   gh release download vX.Y.Z --pattern "*.blockmap" -D /opt/matricarmz/updates --clobber   # separate call — multi-pattern drops it
   ```
   > ⚠️ **Verify all three landed** (`ls /opt/matricarmz/updates/ | grep <version>` → `.exe`, `.exe.blockmap`, `latest.yml`; `latest.yml` has no version in its name). A missing blockmap makes `/updates/file/<exe>.blockmap` return 404 → clients lose delta and full-download the installer (~116 МБ vs ~10 МБ). Confirm after restart: `curl -fsSk -o /dev/null -w '%{http_code}' https://127.0.0.1/updates/file/<exe>.blockmap` → `200`.
8. **Wait for `latest.json` to agree with the `.exe` on disk BEFORE anything else** (GOTCHAS **M40** — expected behaviour of the rescan, not a flake). The running `updateTorrentService` rescans the updates dir every 60 s and seeds the manifest from whatever it finds — `gh release download` writes the `.exe` in place, so a rescan mid-download persists a manifest with a **partial size**. That poisoned manifest survives the restart: `version/fileName/size` mismatch nulls the state and `/updates/file/:name` 404s **both** installer and blockmap — clients see no update at all. Poll until they match, don't eyeball it:
   ```bash
   until [ "$(stat -c%s /opt/matricarmz/updates/MatricaRMZ-Setup-X.Y.Z.exe)" = "$(python3 -c "import json,sys;print(json.load(open('/opt/matricarmz/updates/latest.json'))['size'])")" ]; do sleep 10; done
   ```
   If you already restarted and see `lastError: "stale_manifest"` → just restart the primary again once the file is complete (the fresh scan re-seeds correctly).
8a. **APK планшета — качать локально, класть на прод через `scp`** (не забывать: без этого шага планшеты не обновятся). Самообновление Android читает свежайший `.apk` из `<updatesDir>/android/` (`/opt/matricarmz/updates/android/`) и **версию берёт из имени файла** (`extractVersionFromFileName` в `updateDispatcherService.ts`, старший по `compareAppVersion`), поэтому имя обязано содержать номер выпуска. Размер и sha256 сервер считает сам, `latest.yml`/blockmap у Android нет, рестарт не нужен — кэш инвалидируется по mtime.
   ```bash
   gh release download android-vX.Y.Z --pattern "*.apk" -D "$TMP" --clobber   # ЛОКАЛЬНО, не на проде
   scp "$TMP/app-release.apk" matricarmz:/opt/matricarmz/updates/android/MatricaRMZ-X.Y.Z.apk
   ```
   > ⚠️ **Не гонять `gh release download` на самом проде** — к GitHub CDN оттуда воспроизводимо валится TLS-таймаут. Каталог `updates/` принадлежит `valstan`, так что `scp` идёт без `sudo`. Проверка: `curl -fsSk "https://127.0.0.1/dispatcher/update-plan?platform=android&current=<прежняя>"` → план с новой версией (а не `up-to-date`).

9. `corepack pnpm release:ledger-publish X.Y.Z` — publishes the release into the ledger. Still **before** restart. Note it does **not** rewrite `latest.json` itself — that is the rescan's job (see step 8).
10. Restart services: `sudo systemctl restart matricarmz-backend-primary.service matricarmz-backend-secondary.service`. Verify with `curl -fsk https://127.0.0.1/health` (should report new version).
11. Verify clients will see the update: `curl -fsSk https://127.0.0.1/updates/status` must report `latest: { version: "X.Y.Z", ... }` (not `null` and not the previous version), `lastError: null`, and `/updates/file/<exe>.blockmap` → `200`.

> **Why download + ledger-publish go before restart** (learned v1.34.2): `updateTorrentService` reads the updates dir into in-memory state **at process startup** and only re-scans on a long interval. If you restart while the dir still holds the previous installer, `/updates/status` reports the old version until the next scan (or a second restart). Preparing all artifacts first means the post-restart scan reads the final `latest.yml` / `latest.json` immediately. The DB-touching steps (5, 6) still run between `build` and `restart`.

**SSH tips for these steps** (don't retry blindly):
- **The SSH port is non-standard and lives only in `~/.ssh/config`** (`Host matricarmz` → `Port …`; the values are not written anywhere in the repo — see §«Публичный репозиторий — тоже recon-поверхность»; ask the owner). The hoster port-forwards an **external** port to the **internal** sshd port: connecting to the internal one from outside fails with a TCP timeout / "Connection timed out during banner exchange" while `ping` still answers instantly. **If `ssh matricarmz` times out, check the port FIRST** (the mapping is in the hoster panel, «Перенаправление портов»), before suspecting fail2ban.
- Each dev machine uses its **own isolated ed25519 key** authorized on prod (see `PROJECT_STATE.md` SSH history), and the `matricarmz` config block MUST set `IdentitiesOnly yes`. Without it, ssh offers every local key — each a failed auth — and fail2ban bans the IP (then even the correct port shows TCP-filtered, masquerading as a network problem). Unban / re-authorize a key via the hoster panel console (`fail2ban-client unban <IP>`; append pubkey to the service user's `~/.ssh/authorized_keys`).
- Always pass `-o ConnectTimeout=15` so a real glitch fails fast (default is 60s+). Don't loop on failures — diagnose port → key/`IdentitiesOnly` → fail2ban, in that order.

## Prod server
SSH: alias `matricarmz` (`~/.ssh/config`) — host, non-standard port, user and the per-machine isolated ed25519 key (+ `IdentitiesOnly yes`) live **only** in that config, never in tracked files (see §SSH tips above, `PROJECT_STATE.md`, §«Публичный репозиторий — тоже recon-поверхность»). fail2ban is active — repeated wrong-key attempts ban the IP (unban via the hoster panel console).
Services: `matricarmz-backend-primary.service` and `matricarmz-backend-secondary.service`
Updates dir: `/opt/matricarmz/updates/`
Health check: `curl -fsk https://127.0.0.1/health`
Updates status: `curl -fsSk https://127.0.0.1/updates/status`

## Key architecture decisions
- **Внутренний номер двигателя** («клеймо» на безымянных деталях): EAV-атрибуты `engine_internal_number` + `engine_internal_number_year`. Уникальна **пара (номер, год)**, не номер: нумерацию ведёт работник в журнале дефектовки и каждый год начинает с единицы. Показывается как `41/26`, в цеху на деталях живёт короткий `41`. Год — **текущий** на момент ввода (номер приходит «с земли» при дефектовке); поле года редактируемо для задним числом. Домен — `shared/src/domain/engineInternalNumber.ts` (формат/ключ/парс/сортировка), гейт дублей — на клиенте (`engineService.setEngineAttribute`) и на сервере (`adminMasterdataService` + `engineNumberGuard`), карточка пишет **год до номера** (гейт дочитывает второй элемент пары из БД). Префикс `engine_` обязателен: голый `internal_number` занят договорами. Флаги осознанного дубля (`repeat_arrival_flag`) на внутренний номер **не** распространяются.
- **Внутренний номер НЕ подставляется в `stamped_number`** строк списка деталей (решение 2026-07-15, разобрано в PR #216). `stamped_number` — *личный* номер экземпляра детали, набитый изготовителем; это человеческий ключ поэкземплярного учёта ремфонда — `(engineEntityId, nomenclatureId, stampedNumber)` (`repairFundInstance.ts`), дедуп `(partId, stampedNumber)` в `buildStampedInstancesFromInventory`. Одинаковый номер двигателя во всех безымянных строках **схлопнул бы** их в один экземпляр (6 поршней → 1) и обманул бы требование к заказчику. Связь «деталь ↔ двигатель» держит **`engineEntityId` самой записи** (провенанс), а не номер, — отчёты и фильтры ходят по нему и от номера не зависят. Оператору на дефектовке показывается плашка-подсказка с клеймом (`RepairChecklistPanel`), данные не засоряются.
- **Один действующий сборочный наряд на двигатель.** Гейт дублей (`shared/src/domain/workOrder.ts` — `buildAssemblyDuplicateMessage` / `isAssemblyWorkOrderBlocking`, реплика-скан `listAssemblyWorkOrdersForEngine`, обёртка UI — `renderer/src/ui/utils/assemblyDuplicateGate.ts`) спрашивается **до** создания карточки во всех трёх точках входа: ПКМ списка двигателей, пикер двигателя в шапке карточки, наряд из прогноза сборки. Блокируют только наряды **в работе** (`issued`/`overdue`) — выполненные и отозванные двигатель не держат, иначе повторный приход двигателя в ремонт требовал бы обхода гейта; по ним показывается предупреждение с кнопкой «Всё равно создать новый».
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
