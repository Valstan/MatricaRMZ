# Безопасность и секреты (MatricaRMZ)

## Главный принцип
**Секреты не храним в GitHub и в репозитории.** Никаких паролей/токенов/ключей в коде и документации.

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

### Фаза 4 — defense in depth (долгосрочные улучшения)
Цель: подготовиться к редкому, но дорогому сценарию — компрометации сервера или ключей.

1. **Версионирование ledger-крипто и ротация ключей.** Сейчас в коде только префикс `enc:v1:` и один ключ. Нужно:
   - Ввести `enc:v2:` с `keyId` в payload, поддержку списка ключей в `data-key.json` (массив, текущий + предыдущие).
   - Добавить серверный фоновый job: «пере-зашифровать всё с v1 на v2 текущим ключом», после чего старый ключ можно вывести.
   - Аналогично для `server-key.json`: подпись по `keyId`, проверка принимает любой из набора публичных ключей. При ротации генерируем новый ключ, добавляем в keyring, новые блоки подписаны новым.
   - После того как код поддержит keyring — ротировать оба ключа (они были world-readable до Фазы 1, считаем потенциально скомпрометированными).
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

