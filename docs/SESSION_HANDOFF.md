# Session Handoff

> Sticky-note для непрерывности: куда мы шли, что дальше. История в `git log`, что открыто — в [`docs/PENDING_FOLLOWUPS.md`](docs/PENDING_FOLLOWUPS.md), сделано — в [`docs/COMPLETED.md`](docs/COMPLETED.md). Только активные нитки и открытые шаги.

**Status:** ACTIVE
**Updated:** 2026-11-22 (сессия MiniMax Code / MiniMax-M3.1-Flash, машина PC79) — **нитка «MiniMax-воркер на проде для ИИваныча»: пред-полёт сделан (блок команд проверен на боксе и исправлен — три находки), осталось прогнать блок; гейт этого рантайма не пускает ssh+sudo на проде**
**Branch:** `main` (PR #1900 воркер, #1901 handoff, #1902 грант/канон, #1903 DNS-пин, #1904 один агент за раз — все слиты; этот шаг — PR с записями пред-полёта)
**Last released version:** **v3.141.0** (выкат 22.11 02:29–02:37). Релиза не было: код воркера доставлен на прод выкладкой `backend-dist` — клиент не трогали, поведение программы прежнее.

## Текущая нитка

**MiniMax-воркер на проде «Матрицы РМЗ» для ИИваныча** (промты КАРМАНА **#56 + #57**; задание от Управляющего, meta-репо `brain_matrica`, область `p-brain2`).

- **Заказано:** сервис-воркер по образцу «Сарафана» — берёт свободный аккаунт MiniMax в «Кармане», поднимает агента MiniMax Code и обслуживает запросы ИИваныча.
- **Решения владельца от 21.11 (приняты):** воркер живёт **на боксе Матрицы РМЗ**; доступ к комнате Кармана — **сервисным грантом на запись**, пишущий токен на бокс **не кладём**; цепочка — **MiniMax на проде → платный DeepSeek последним** (fail-open, D-243); контракт воркера — Anthropic-совместимый **`/v1/messages`**.
- **Сделано (всё живой проверкой на боксе):**
  - **Грант выдан:** служебная комната **`matricarmz-minimax`** (имя «MatricaRMZ» → тот же проект учёта), её rw-токен в комнате `matricarmz` под ключом **`KARMAN_MINIMAX_TOKEN`**. Бокс читает его **read-only** токеном — право записи в свою комнату **не** получает. Приёмка: ключ читается; `self` → `canWrite=true`; `POST /api/minimax/renew` с фиктивным id → **404** (пуль принял, аккаунт не израсходован). Комната не «девственная» ⇒ повторный `provision` даст 409.
  - **Код на боксе:** выкладка `backend-dist` (primary 8 с, secondary 6 с; откат в `.deploy-backup/20261122-145608`), приёмка 3001/3002/nginx — 200, `dist/minimaxWorker/` на месте.
  - **Бокс подготовлен:** MiniMax Code CLI 0.7.4 (`npm i -g --prefix ~/.local`, без root, 342 МБ).
  - **Воркер живой:** поднялся вручную, `/health` → `pool: configured`, токен из комнаты; запрос дошёл до пула и получил **честный отказ** `503 {"error":"no_free_accounts","reason":"pool_empty"}` — контур работает, пул на сегодня исчерпан (141 аккаунт, 124 использованы сегодня, 138 закреплены за потребителями).
  - **Код:** воркер `backend-api/src/minimaxWorker/` (клиент пула, профиль CLI, адаптер `mcode exec`, слой `tool_use`, `/v1/messages`), транспорт (`llmProvider.ts`: провайдер `minimax` + fail-open на DeepSeek, `answerSource: engine|deepseek`), юнит systemd, **DNS-пин MiniMax** (`scripts/prod-ops/minimax-dns-pin.py` + таймер), ворота «один агент за раз» (RAM 1536 МБ).
- **Пред-полёт 22.11 (вторая сессия):** блок команд сверен с боксом и **исправлен** — три находки, каждая тихо ломала бы нитку: (1) выложенный `dist` **старше ворот #1904** (на боксе в `dist/minimaxWorker/server.js` нет ни `createAgentGate`, ни `agentsActive` — сборка до 15:12, выкладка в 14:56 ⇒ нужен свежий `dist`, иначе два `mcode exec` на 1536 МБ → OOM); (2) `/opt/minimax-accounts` **не существует**, `/opt` — root, а юнит работает от `valstan` ⇒ профили не создадутся, будет тихий уход на DeepSeek; (3) `/etc/matricarmz/matricarmz.env` — `root:valstan` 640 ⇒ `echo >>` упал бы с Permission denied, писать через `sudo sed -i`. Зелёное: пин-скрипт `--check` находит живые адреса всех 5 хостов; CLI на месте; в env есть `SECRETS_TOKEN`/`SECRETS_VAULT_URL`; транспорту бэкенда доп. переменных не нужно; **звено ещё не включено** (`MATRICA_AI_PROVIDER=deepseek`, файл env не менялся с 19.11); юнитов MiniMax на боксе нет, пина в `/etc/hosts` нет.
- **Контракт ИИваныча не тронут:** очередь `ai_chat_requests`, воркер `startAiChatDirectWorker`, 4 мета-инструмента — как были; правка только в транспорте.

## Следующий шаг

**Блок из 6 шагов — владельцу** (запись в системные пути на проде: `/opt`, `/etc/hosts`, `/etc/systemd/system`, `/etc/matricarmz/*.env`; гейт этого рантайма не умеет спросить и отказывает — обходить нельзя, тот же класс, что чистка старого APK; слово владельца в том же ходе снимает блок, грабля **M213**). Полная версия с пометками — [пункт PENDING](docs/pending/minimax-worker-ekspluataciya-na-prode.md):

```bash
# 0. каталог профилей: /opt/minimax-accounts не создан, /opt — root, а юнит от valstan
sudo mkdir -p /opt/minimax-accounts && sudo chown valstan:valstan /opt/minimax-accounts
# 1. свежий dist — в нём ворота #1904 (в выложенном 22.11 их нет)
bash ~/MatricaRMZ/scripts/prod-ops/deploy-backend.sh
# 2. пин адресов MiniMax
sudo python3 ~/MatricaRMZ/scripts/prod-ops/minimax-dns-pin.py
# 3. юниты: воркер + таймер пина
bash ~/MatricaRMZ/deploy/systemd/install-backend.sh
sudo systemctl enable --now matricarmz-minimax-dns-pin.timer
sudo systemctl start matricarmz-minimax-dns-pin.service
sudo systemctl enable --now matricarmz-minimax-worker.service
curl -fsS http://127.0.0.1:3010/health   # pool: configured + agentsActive/agentsQueued
# 4. включить звено — ПОСЛЕ успешного прогона воркера
sudo sed -i 's/^MATRICA_AI_PROVIDER=.*/MATRICA_AI_PROVIDER=minimax/' /etc/matricarmz/matricarmz.env
sudo systemctl restart matricarmz-backend-primary.service
```

**Порядок обязателен:** пин → юнит → живой прогон воркера → только потом переключение звена. Иначе каждый вопрос ИИваныча будет **сжигать аккаунт пула** на попытку достучаться до MiniMax и уходить в DeepSeek. Шаг 1 (свежий dist) — **до** шага 3: старый dist без ворот.

**Что делает сессия после блока (read-only, гейт пускает):** приёмка `/health` воркера; живой `POST /v1/messages` на `127.0.0.1:3010` (это же и замер пика RSS — `ps -o rss= -C node` во время прогона, `dmesg` без `Killed process`); проверка `answer_source` в `ai_chat_requests` по живому вопросу оператора; запись в журнал эффектов.

**Приёмка после переключения:** вопрос оператора → ответ ИИваныча; в журнале воркера — id взятого аккаунта; в `ai_chat_requests.answer_source` — `engine`; при пустом пуле — честный отказ и уход на DeepSeek (`deepseek`).

**После приёмки — строка в журнал эффектов** ([`docs/zavod/PROGRAM_EFFECTS.md`](docs/zavod/PROGRAM_EFFECTS.md), новое сверху): сейчас её писать рано — воркер на проде, но звено не включено, и оператор сегодня отвечает DeepSeek'ом. Черновик: «ИИваныч отвечает на локальной модели завода — без оплаты облаку за каждый ответ; при отказе локального движка ответ даёт платный запасной (вопросы операторов не теряются)».

**Хвост прошлой нитки (парк):** чистка старого APK `MatricaRMZ-3.140.0.apk` на проде — разрешена владельцем, но локальный гейт не пускает удаляющую команду; шаг владельца ([пункт](docs/pending/chistka-staryh-apk-na-prode-gate-ne-puskaet.md)).

## Контекст

- **Прод:** v3.141.0 на обоих инстансах; бэкенд перезапущен в 14:56 МСК (выкладка с воркером), откат — `bash scripts/prod-ops/deploy-backend.sh rollback 20261122-145608`. Telegram с прод-бокса недоступен, тревоги идут только в МАКС.
- **RAM бокса:** всего 1536 МБ, **доступно ~1030 МБ** (used 505, buff/cache 917), диск — 1,9 ГБ свободно. Пик `mcode exec` по замеру «Сарафана» — ~380 МБ ⇒ один агент помещается, два нет (поэтому в воркере ворота «один прогон за раз», PR #1904). Замер пика на живом прогоне делает сессия.
- **Парк:** первый проход правила принудительного обновления в 12:30 МСК отработал — «обновление получили **1 машина: PC79 (3.139.0 → 3.141.0)**» (в проход попадают только живые; спящий парк уедет следующим днём). Искать в `logs/critical-events.ndjson`, не в `journalctl`.
- **Стенд на этой машине:** backend на 3001, локальный PostgreSQL 17 на 5432 (`matricarmz_dev`).
- **Файлы:** план нитки — [`docs/plans/minimax-worker-for-iivanych-2026-11.md`](docs/plans/minimax-worker-for-iivanych-2026-11.md) (§7 — пред-полёт второй сессии); грабля — [`docs/gotchas/M222.md`](docs/gotchas/M222.md); канон комнаты — `AGENTS.md` §Prod server и [`docs/OPERATIONS.md`](docs/OPERATIONS.md) §8а; письма в Мозг — `mailbox/to-brain/2026-11-22-sluzhebnaya-komata-dlya-pula-i-zapis-v-reestr.md` и `…-servisnyy-grant-cherez-komatu-i-fasadka-nad-cli-agentom.md`.
- **Промты КАРМАНА:** пара **#56/#57 остаётся живой** до приёмки на проде (архив = «сделано»). В том же разделе живые пары **#59–#71** (локальный MiniMax на клиенте, ПП-списки, планшетная версия) — это **отдельные** нитки.

## Что не сработало

- **Локальный гейт блокирует запись в системные пути на проде** (`/etc/hosts`, `/etc/systemd/system`, `/etc/matricarmz/*.env`, `/opt/…`, `sudo systemctl enable`) — `HOST_CAPABILITY_UNAVAILABLE`: гейт не умеет спросить и отказывает. В этом рантайме он отказал и на **штатные скрипты репозитория** (`deploy-backend.sh`, `install-backend.sh` через ssh) — то есть весь прод-контур этой нитки уходит владельцу. Обходить нельзя; при этом `git pull`, чтение, `curl`, `npm i -g --prefix ~/.local` проходят.
- **PowerShell 5.1 калечит нативные аргументы:** снимает двойные кавычки и обратные слэши, режет по `|` — из-за этого ломались `psql -c` и `curl --data-binary`. Рабочие формы: SQL через stdin с `$OutputEncoding = New-Object System.Text.UTF8Encoding($false)`; тело запроса — base64 и `--data-binary @-`; в удалённой команде — ни одной двойной кавычки.
- **Пул аккаунтов сегодня исчерпан** — честный `no_free_accounts`. Это механика Кармана (аккаунт = один потребитель в сутки, сброс вендора в МСК 00:00/03:00), а не поломка контура.
- **Супертест откладывает запрос до `await`** — в тесте на ворота оба запроса надо стартовать через `.then()`, иначе они не уходят вовсе.

## Открытые вопросы для пользователя

- **Когда переключать звено** (`MATRICA_AI_PROVIDER=minimax`): сразу после блока или после короткой выдержки, чтобы увидеть в журнале воркера живые аккаунты? Путь с откатом — вернуть `deepseek` тем же `sed` и перезапустить primary.
- **Пул и бюджет очков:** пул общий с «Сарафаном» и сегодня исчерпан. Нужен ли воркеру свой «слот» в карусели или ограничение частоты, чтобы Матрица не забирала аккаунты, которые нужны соседу?
