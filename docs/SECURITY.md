# Безопасность и секреты (MatricaRMZ)

## Главный принцип
**Секреты не храним в GitHub и в репозитории.** Никаких паролей/токенов/ключей в коде и документации.

## Критические инварианты (важно для агентов)

- **`MATRICA_LEDGER_RELEASE_TOKEN` — это JWT, подписанный `MATRICA_JWT_SECRET`.** При ротации JWT-секрета release-токен становится невалидным. После любой смены `MATRICA_JWT_SECRET` нужно сразу выпустить новый release-токен через web-admin (`/admin-ui/` → Admin → Release token) и положить в `.env` рядом с обновлённым JWT-секретом. Не путать: refresh-токены пользователей (`/auth/refresh`) живут в БД как SHA-256 хэши и не зависят от JWT-секрета — они переживают ротацию.
- **`data-key.json` и `server-key.json` всегда mode 600.** Любые архивы старых версий — тоже 600. При редактировании через `nano` / `vim` иногда дефолтные umask сбрасывают на 644; после правок `stat -c '%a'` обязателен.
- **Live ledger живёт ВНЕ git-репозитория.** Прод: `MATRICA_LEDGER_DIR=/home/valstan/matricarmz-ledger` (задан в `/etc/matricarmz/matricarmz.env`). Каталог `backend-api/ledger/` — gitignored и **никогда не должен трекаться**: это рантайм-данные (подписной ключ + data-key + блоки + `state.json`). CLI-скрипты (`ledger:rotate-data-key` и т.п.) запускать с **экспортированным** `MATRICA_LEDGER_DIR`, иначе они уйдут в дефолтный `cwd/ledger`. **Инцидент 2026-06-26:** ровно эти файлы были закоммичены в **публичный** репо (`server-key.json` в HEAD + `data-key.json`/`state.json` в истории + 552 `enc:v1:` поля ПДн) → ремедиация: ротация подписного ключа на проде + relocate live-ledger из checkout + untrack (#614) + **репозиторий сделан приватным**. Подробности — `PENDING_FOLLOWUPS.md` §Security (H8 закрыт). Урок: рантайм-данные backend'а не должны лежать внутри git-дерева.
- **Ledger-блоки в `blocks/` неперешифровываемы** — перешифровка нарушит хэш-цепочку. Только `state.json` (проекция) пересчитывается при ротации data-key. Старые ключи в keyring остаются навсегда, чтобы можно было читать историю.
- **UFW deny incoming default.** Любое добавление новой службы, слушающей порт — это новое UFW-правило. Без правила служба будет недоступна снаружи (правильное поведение, но проверь, что так и задумано).


## Где должны храниться секреты
- **Только на сервере (VPS)**: файлы `.env`, systemd/PM2 env, приватные ключи.
- **В GitHub**: допускаются только **GitHub Actions Secrets** (они не попадают в git и не видны в логах при правильном использовании).

## Что считаем секретами
- пароли БД (PostgreSQL), JWT/refresh keys (когда появятся), API ключи
- ключи ledger‑узла (server‑key.json) и data‑key для шифрования payload
- клиентский E2E ключ (`ledger-client-key.json`) при включенном `MATRICA_LEDGER_E2E`
- токены GitHub (PAT), ключи доступа к облачным хранилищам
- приватные ключи (SSH, TLS)

## Правила для проекта
1. `.env` файлы **никогда не коммитим** (они игнорируются `.gitignore`).
2. В `.env.example`/`env.example.txt` — только шаблоны (`CHANGE_ME`), без реальных значений.
3. В документации — только примеры и “заглушки”, без реальных паролей.
4. Backend читает конфиг из переменных окружения (`PGHOST/PGUSER/PGPASSWORD/...`).
5. Ledger‑ключи не коммитим: `backend-api/ledger/server-key.json` и `data-key.json` создаются на VPS.
6. Если секрет попал в git случайно:
   - немедленно **ротируем** (меняем) секрет на сервере;
   - удаляем упоминания из файлов;
   - при необходимости переписываем историю (git filter-repo).

## Рекомендация по CI/CD
Используем GitHub Actions для сборки релизов. Если нужен токен/ключ:
- кладем его в **GitHub Actions Secrets**
- в workflow используем через `${{ secrets.NAME }}` (не печатать в лог)

## Поэтапный план усиления защиты прод-контура

План вводится поэтапно, каждая фаза самостоятельна и обратима. История фактически применённых шагов фиксируется здесь и в commit-сообщениях.

### Фаза 1 — права доступа и ротация JWT (выполнено)
Дата применения: 2026-05-17.

- `chmod 600 /home/valstan/MatricaRMZ/backend-api/.env`
- `chmod 600` на `ledger/server-key.json` и `ledger/data-key.json`
- `chmod 640` на рабочие файлы ledger (`state.json`, `index.json`, `checkpoint.json`, `bootstrap.json`)
- `ledger/` → `chmod 750`, `ledger/archive/` создан с правами 700 для старых `state.json.bak.*` и `state.json.corrupt.*` (внутри файлы 600)
- Старые `.conf.bak*` и `default.conf.disabled` из `/etc/nginx/conf.d/` перенесены в `/etc/nginx/conf.d/archive/` (mode 700, файлы 600)
- `MATRICA_JWT_SECRET` ротирован на свежее 64-символьное значение. Refresh-токены не зависят от JWT-секрета (рандом + SHA-256 в БД), поэтому переавторизация пользователей не нужна.
- Резервная копия `.env` сохранена в `.env.bak-YYYYMMDD-HHMMSS` рядом с активным, mode 600.
- Сервисы `matricarmz-backend-primary` и `matricarmz-backend-secondary` перезапущены в режиме rolling, оба `/health` зелёные.

### Фаза 2 — firewall, SSH hardening, fail2ban (выполнено)
Дата применения: 2026-05-18.

- В коде backend закреплён порт WebTorrent: новая env-переменная `MATRICA_TORRENT_PEER_PORT` (по умолчанию 51413), `dhtPort` + `torrentPort` пробрасываются в `new WebTorrent(...)` — больше не случайные порты после перезапуска.
- UFW активирован: default deny incoming / allow outgoing; allow `49412/tcp` (SSH), `80/tcp` (redirect), `443/tcp` (HTTPS), `6969/tcp` (tracker), `51413/tcp+udp` (WebTorrent peer/DHT). Порт `22/tcp` закрыт после подтверждения, что `49412` работает.
- `/etc/ssh/sshd_config.d/99-matricarmz-hardening.conf`: `PasswordAuthentication no`, `PermitRootLogin no`, `KbdInteractiveAuthentication no`, `ChallengeResponseAuthentication no`, `MaxAuthTries 3`, `PermitEmptyPasswords no`, `X11Forwarding no`, `ClientAliveInterval 300`, `ClientAliveCountMax 2`. Старый `sshd_config` сохранён в `sshd_config.bak-YYYYMMDD-HHMMSS`.
- Установлен `fail2ban` с jail `sshd` (port 22+49412, `mode = aggressive`, `bantime = 1h`, `findtime = 10m`, `maxretry = 5`).
  - **Известная особенность**: aggressive-mode может банить и за pre-auth-аномалии, в т.ч. за лавину быстрых SSH-подключений с одного IP во время автоматизации. При активной работе с сервером через CI/ИИ-агента имеет смысл смягчить (`mode = normal`, `maxretry = 6`, `bantime = 10m`).
  - Команда для разбана: `sudo fail2ban-client unban --all` или `sudo fail2ban-client set sshd unbanip <IP>`.

### Что ещё имеет смысл по сетевому уровню (опционально, не критично)
- Опционально включить fail2ban jail `nginx-http-auth` (по 401 в `/auth/*`).
- Рассмотреть отключение DHT в WebTorrent, если внешние пиры не нужны (обновления раздаются клиентами, и DHT помогает им находить друг друга — выключай только если убедился, что трекер обслуживает всех).
- При смене провайдера / адресной NAT-схемы пересмотреть `MATRICA_TRUST_PROXY_HOPS`.

1. Зафиксировать порт WebTorrent через env-переменную в `backend-api` (`MATRICA_TORRENT_PEER_PORT`), чтобы UFW мог открыть конкретный, а не случайный порт.
2. Установить и активировать UFW:
   - allow `22/tcp`, `49412/tcp` (SSH резерв и основной), `80/tcp`, `443/tcp`, фиксированный WebTorrent-порт (TCP+UDP), `6969/tcp` (tracker — если используется), `out` allow all, `deny incoming` default.
   - после проверки доступа в свежем SSH-сеансе — закрыть `22/tcp` и оставить только `49412/tcp`.
3. Жёсткие настройки sshd: `PasswordAuthentication no`, `PermitRootLogin no`, `PubkeyAuthentication yes`, `MaxAuthTries 3`, `KbdInteractiveAuthentication no`, `X11Forwarding no`. Перезапустить sshd.
4. Установить `fail2ban` с jail для `sshd` (4 неудачные попытки → бан 1 час). Включить jail для `nginx-http-auth` (для частых 401).
5. Опционально: расследовать UDP-листенер WebTorrent (`*:36549`) — он используется для DHT/peer-exchange; решить, нужны ли DHT и tracker, либо отключить DHT и оставить только tracker.

### Фаза 3 — app-level hardening (helmet, CORS, rate-limit) (выполнено)
Дата применения: 2026-05-18.

- Установлены и подключены `helmet` (HSTS 1 год + `includeSubDomains`, `noSniff`, `frameguard`, `referrerPolicy`) и `express-rate-limit`.
- CORS заменён на allow-list через `MATRICA_CORS_ORIGINS` (CSV). Пустое значение — legacy «разрешать всё», как было. Electron-клиент не отправляет Origin, на него ограничение не влияет.
- `trust proxy` зафиксирован на `MATRICA_TRUST_PROXY_HOPS` (по умолчанию `1`) вместо `true`, чтобы атакующий не мог подделать `X-Forwarded-For` и обойти rate-limit.
- Глобальный rate-limit: `MATRICA_RATE_LIMIT_GLOBAL` запросов/мин на IP (по умолчанию 600).
- Auth-limiter на `/auth`: `MATRICA_RATE_LIMIT_AUTH` попыток за 15 минут на IP (по умолчанию 30).
- CSP оставлена выключенной — у backend есть статический `/admin-ui` SPA, который ломается строгими дефолтами. План: добавить `Content-Security-Policy-Report-Only` отдельным шагом после ручной проверки фронта.
- Лимит тела запросов оставлен 20 МБ (нужен `/files`, `/ledger`, `/backups`); разделение по роутам — отдельная задача в Фазе 4 / 5.
- 52/52 теста backend проходят.

### Что ещё имеет смысл по app-level (опционально)
- Дробить body-limit: 1 МБ глобально, 20 МБ только на `/files`, `/ledger`, `/backups`.
- Включить CSP сначала в `Report-Only`, собрать violations, потом enforce. Сделать `/admin-ui` совместимым с CSP (избавиться от inline-script где возможно).
- Поднять дополнительный limiter на `/sync/*`, `/ledger/*` — но осторожно, активные клиенты ходят туда часто; нужен реалистичный замер RPS перед тюнингом.
- Добавить HSTS-заголовок и `X-Content-Type-Options: nosniff` ещё и в nginx — defense in depth.

1. Установить `helmet` и подключить в `backend-api/src/app.ts` с настройками:
   - HSTS на 1 год, `includeSubDomains`
   - `noSniff`, `frameguard: deny`, `referrerPolicy: strict-origin-when-cross-origin`
   - CSP: сначала в `Content-Security-Policy-Report-Only` (есть `/admin-ui` SPA, рискованно ломать).
2. Заменить голый `cors()` на allow-list из `process.env.MATRICA_CORS_ORIGINS` (CSV). Electron-клиент не шлёт `Origin`, для него ничего не меняется; web-admin браузерный — добавить его origin в env.
3. Установить `express-rate-limit`:
   - `/auth/login` — 10 запросов / 15 мин на IP, при превышении 429 на 15 мин.
   - `/auth/refresh` — 60 / час на IP.
   - global limiter — 600 / мин на IP.
4. Пройти по `app.ts` и убедиться, что все маршруты с приватными данными имеют `requireAuth` либо на уровне роутера, либо на каждом эндпойнте. Закрыть выявленные дыры (`/notes`, `/presence`, `/diagnostics`, `/employees` — нуждаются в подтверждении).
5. Подкорректировать body-лимит: `express.json({ limit: '1mb' })` глобально, и поднять до 20mb только на `/files`, `/ledger`, `/backups`.
6. Добавить в nginx HSTS и `X-Content-Type-Options: nosniff` (defense in depth).

### Фаза 4.1 — версионирование ledger-крипто и ротация data-key (выполнено)
Дата применения: 2026-05-18 (код), 2026-05-18 (первая боевая ротация).

**Боевая ротация выполнена:** keyring переведён в v2 (`activeId=k-mpay0khj-59638c`, старый `v1-legacy` остался для чтения исторических блоков), 35874 строк просканировано, 4245 шифрованных полей перешифрованы (в `state.json` теперь 0 вхождений `enc:v1:` и 4245 — `enc:v2:`). Бэкапы `state.json.bak.<ts>.before-rotate` и `data-key.json.bak.<ts>.before-rotate` лежат в `backend-api/ledger/` с правами 600 — архивировать в `archive/` спустя сутки после подтверждения, что всё работает.


- Новый модуль [backend-api/src/ledger/dataKeyring.ts](../backend-api/src/ledger/dataKeyring.ts): keyring AES-256-GCM с поддержкой нескольких ключей одновременно, формат `data-key.json` версии 2 (`{ version:2, activeId, keys:[{id,keyBase64,createdAt}] }`).
- Полная обратная совместимость: старый `{keyBase64}` файл прозрачно загружается как legacy-keyring с id `v1-legacy`. Пока activeId = `v1-legacy` (то есть ротация ещё не запускалась), новые шифровки пишутся в `enc:v1:` — downgrade backend остаётся возможным.
- После первой ротации новые шифровки идут в `enc:v2:<keyId>:iv:tag:data`. Старые `enc:v1:` остаются читаемыми, потому что legacy-ключ остаётся в keyring навсегда.
- В [ledgerService.ts](../backend-api/src/ledger/ledgerService.ts) убраны прямые `createCipheriv`/`createDecipheriv`, всё через keyring. Реэкспортирован `loadOrCreateDataKeyring`.
- CLI [backend-api/src/scripts/rotateLedgerDataKey.ts](../backend-api/src/scripts/rotateLedgerDataKey.ts) + npm-скрипты:
  - `pnpm --filter @matricarmz/backend-api ledger:rotate-data-key:dry-run` — посмотреть, сколько строк надо перешифровать
  - `pnpm --filter @matricarmz/backend-api ledger:rotate-data-key` — реальная ротация
- 7 юнит-тестов keyring проходят, общий backend test-suite расширен с 52 до 59 без регрессий.

**Что про блоки и подписи (`server-key.json`):** код уже rotation-friendly без правок — каждая подписанная транзакция несёт `public_key` внутри, `verifyTxs` верифицирует именно этим ключом. Старые блоки остаются валидными после смены `server-key.json`; новые подписываются новой парой. Блок-файлы в `blocks/` НЕ перешифровываются (это нарушит хэш-цепочку); CLI ротации работает только с проекцией `state.json`.

#### Процедура ротации data-key (выполняется оператором):

```bash
ssh matricarmz
cd /home/valstan/MatricaRMZ

# 1) Сначала dry-run, чтобы увидеть масштаб перешифровки:
pnpm --filter @matricarmz/backend-api ledger:rotate-data-key:dry-run

# 2) Останавливаем backend (чтобы не было гонок записи state.json):
sudo systemctl stop matricarmz-backend-secondary.service
sudo systemctl stop matricarmz-backend-primary.service

# 3) Реальная ротация: добавляется новый ключ, перешифровывается state.json,
#    сохраняются бэкапы .bak.<ts>.before-rotate
pnpm --filter @matricarmz/backend-api ledger:rotate-data-key

# 4) Права на свежий data-key.json (CLI сохраняет с дефолтными правами 644 — нужно ужесточить):
chmod 600 /home/valstan/MatricaRMZ/backend-api/ledger/data-key.json

# 5) Старт primary, ждать /health, потом secondary:
sudo systemctl start matricarmz-backend-primary.service
sleep 10 && curl -fsS http://127.0.0.1:3001/health
sudo systemctl start matricarmz-backend-secondary.service
sleep 5 && curl -fsS http://127.0.0.1:3002/health

# 6) Архивировать backup state.json спустя сутки после проверки, что всё работает:
mv /home/valstan/MatricaRMZ/backend-api/ledger/state.json.bak.*.before-rotate \
   /home/valstan/MatricaRMZ/backend-api/ledger/archive/
```

#### Процедура ротации server-key (подпись):

```bash
sudo systemctl stop matricarmz-backend-secondary.service
sudo systemctl stop matricarmz-backend-primary.service

# Перемещаем старый ключ в архив, при следующем старте сгенерируется новый:
mv /home/valstan/MatricaRMZ/backend-api/ledger/server-key.json \
   /home/valstan/MatricaRMZ/backend-api/ledger/archive/server-key.json.bak.$(date +%s)

sudo systemctl start matricarmz-backend-primary.service
sleep 10 && curl -fsS http://127.0.0.1:3001/health
sudo systemctl start matricarmz-backend-secondary.service

# После старта новый server-key.json сгенерирован; chmod 600:
chmod 600 /home/valstan/MatricaRMZ/backend-api/ledger/server-key.json
```

Подписи существующих блоков остаются валидными — каждая транзакция несёт свой `public_key`.
### Фаза 4.3 — закрытие уязвимостей зависимостей (выполнено)
Дата применения: 2026-05-18.

`pnpm audit --prod` показывал 9 high CVE. Закрыто 8, осталась 1 — **accepted risk**.

Применённые исправления:
- **`drizzle-orm` 0.40.1 → 0.45.2** в `backend-api` и `electron-app` (прямые зависимости). 59/59 backend-тестов проходят, тип-чек без регрессий, sqlite-API совместим.
- **pnpm overrides** в корневом `package.json` для транзитивных:
  ```json
  {
    "minimatch@<3.1.4": "3.1.4",
    "minimatch@>=5.0.0 <5.1.8": "5.1.8",
    "minimatch@>=10.0.0 <10.2.3": "10.2.3",
    "@isaacs/brace-expansion@<5.0.1": "5.0.1",
    "brace-expansion@>=2.0.0 <2.0.3": "2.0.3",
    "path-to-regexp@<0.1.13": "0.1.13",
    "qs@<6.14.2": "6.14.2",
    "ip-address@<=10.1.0": "10.1.1"
  }
  ```

**Accepted risk: `ip <=2.0.1`** через `bittorrent-tracker>ip`. Апстрим-патча нет (`patched: <0.0.0`, пакет заброшен). В нашем сценарии не эксплуатируется: tracker раздаёт Electron-обновления, использует `ip.isPublic()` для фильтрации peer IP — не для server-side запросов по URL. Худший вариант — псевдо-приватный IP попадёт в список пиров. Заменить `bittorrent-tracker` целиком — отдельная задача, делать когда появится критичная необходимость.

### Фаза 4.2 — операционная автоматизация безопасности (выполнено)
Дата применения: 2026-05-18.

Три cron-скрипта развёрнуты на проде через `scripts/prod-ops/install-prod-ops.sh`:

- **Шифрованные бэкапы off-VPS** (`/usr/local/sbin/matricarmz-backup-encrypted`, ежедневно в 03:17 MSK):
  `pg_dump` + tar ledger (zstd −9) → GPG AES-256 (passphrase из `/etc/matricarmz/backup.passphrase`, mode 640 root:valstan) → upload в Yandex.Disk (`YANDEX_DISK_BASE_PATH`) → ротация (хранится 14 последних). Тестовый прогон: 64 с от старта до завершения, итоговый файл ~230 МБ. Tar warning «file changed as we read it» игнорируется (state.json — проекция, blocks/ append-only — backend безопасно восстановит).
- **Cron-аудит зависимостей** (`/usr/local/sbin/matricarmz-audit-deps`, понедельник 04:23 MSK):
  `pnpm audit --prod --json` → Telegram-алерт при наличии high/critical. На момент первого запуска найдено **9 high vulnerabilities** — отдельная задача обновления зависимостей.
- **Алерт по неудачным логинам** (`/usr/local/sbin/matricarmz-watch-failed-auth`, каждые 5 минут):
  парсит `/var/log/nginx/matricarmz_access.log`, выделяет реальный клиентский IP из `X-Forwarded-For`, считает 401/403 в окне 5 минут. При ≥10 неудач с одного IP — Telegram-алерт с примерами URL и cooldown 60 минут на повтор для того же IP.

**Важно:** passphrase бэкапа **выводится один раз при установке** и должна быть сохранена off-server (менеджер паролей). Без неё расшифровать бэкап невозможно.

Telegram-уведомления **включены** (`MATRICA_TELEGRAM_ENABLED=true`). Тестовое сообщение доставлено успешно после двух связанных починок:

1. **DNS-блок myjino → Telegram CDN.** Из 9 проверенных IP `api.telegram.org` (149.154.x.x, 91.108.x.x) с прод-сервера достижим только `149.154.167.220`. Зафиксирован в `/etc/hosts` с комментарием:
   ```
   149.154.167.220 api.telegram.org # MatricaRMZ: pinned working CDN IP
   ```
   Если этот IP станет недоступен — повторить проверку диапазона и обновить запись.
2. **`/etc/ssl/certs/ca-certificates.crt` был забит нулями** (тот же паттерн порчи, что был у `sshd_config`). Восстановлен `sudo update-ca-certificates --fresh` (146 сертификатов). После этого `curl https://api.telegram.org/` начал работать. Стоит периодически проверять критичные конфиги командой `file <path>` — паттерн порчи системных файлов на этом VPS повторяется.

Файловая раскладка на проде:
- `/usr/local/sbin/matricarmz-{backup-encrypted,audit-deps,watch-failed-auth}` (root, 755)
- `/etc/matricarmz/backup.passphrase` (root:valstan 640)
- `/var/log/matricarmz/` (valstan:adm 755)
- `/var/lib/matricarmz/` (valstan 700, state-файлы)
- `/etc/cron.d/matricarmz-ops` (root 644)

2. **PostgreSQL SSL (self-signed CA).** Сейчас PG слушает только `127.0.0.1`, SSL не критичен, но при разделении DB-хоста потребуется:
   - Создать локальный CA (`openssl genrsa` + `openssl req -x509`), серверный cert/key подписанный CA.
   - `ssl = on` + `ssl_cert_file`/`ssl_key_file` в postgresql.conf, `hostssl ... cert clientcert=verify-ca` в pg_hba.conf.
   - В backend `.env`: `PGSSL=true`, `PGSSLROOTCERT=/path/to/ca.crt`, и поправить `db.ts` чтобы передавать `ca` и `rejectUnauthorized: true`.
3. **mTLS backend ↔ Electron-клиент.** Каждой инсталляции выдаём клиентский cert, подписанный нашим CA. nginx настроен `ssl_client_certificate ca.crt` и `ssl_verify_client on` на чувствительных location (`/ledger/`, `/auth/`). Поднимает планку для атакующего: даже знание JWT не даёт доступа без правильного cert.
4. **Бэкап ledger + PG-dump шифруется (`age` / `gpg`) и отгружается off-VPS** — Yandex.Disk-токен уже есть, нужно завернуть в cron + ротация хранилища.
5. **Cron-аудит зависимостей.** `pnpm audit --prod` еженедельно, отправка уведомления в чат (есть `MATRICA_TELEGRAM_*`).
6. **Структурный алерт по неудачным логинам.** Скрипт, который считает 401 на `/auth/*` в nginx access.log и пингует Telegram, если >N/мин — простая защита, пока нет полноценного SIEM.

### Фаза 5 — операционная гигиена (постоянно)
- Не возвращать `chmod 644` на `.env` после правок.
- При новых секретах — сразу `chmod 600` и в `.env` рядом с остальными, а не в новый «тестовый» файл.
- В docs/CHANGELOG отмечать любую новую сетевую службу (новый порт), чтобы UFW успел получить allow-правило.
- Раз в квартал — `certbot renew --dry-run`, проверка `unattended-upgrades`, ручная сверка `sudo ss -lntp` со списком ожидаемых служб.
- При наёме новых разработчиков — отдельный пользователь без `NOPASSWD: ALL`; sudo-разрешения только на нужные команды.

