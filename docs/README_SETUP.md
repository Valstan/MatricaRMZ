# Инструкция по установке и запуску MatricaRMZ

## Текущее состояние проекта

✅ **Готово:**
- Монорепо настроен (pnpm workspaces)
- Схемы БД созданы (SQLite для клиента, PostgreSQL для сервера)
- Backend API реализован (синхронизация push/pull)
- Electron приложение с UI готово
- Авторизация пользователей (логин/пароль → JWT) + refresh token
- Гибкие права доступа (permissions) + админка управления пользователями/правами (в UI)
- Обязательный логин при старте приложения (без входа дальше не пускает)
- Все собирается и проходит линт

⚠️ **Требует настройки:**
- Подключение к PostgreSQL на VPS (нужен правильный пароль)
- Запуск backend API на VPS
- Сборка Electron приложения для Windows
- Настройка Electron на подключение к backend

Справочник путей/структуры/ENV/логов: `docs/PATHS.md` (единый источник).

---

## Шаг 1: Настройка PostgreSQL на VPS

### 1.1. ✅ Уже настроено!

Пользователь PostgreSQL `valstan` создан.
Файл `/home/valstan/MatricaRMZ/backend-api/.env` **хранится только на сервере** и содержит актуальные учетные данные (в GitHub не попадает).

**Если нужно изменить пароль:**
```bash
sudo -u postgres psql -c "ALTER USER valstan PASSWORD 'новый_пароль';"
# Затем обновите /home/valstan/MatricaRMZ/backend-api/.env
```

### 1.3. Применить миграции

```bash
cd /home/valstan/MatricaRMZ/backend-api
pnpm run db:migrate
```

Должно вывести: `[backend-api] migrations applied`

---

## Шаг 2: Запуск Backend API на VPS

### 2.1. Запуск в режиме разработки (для тестирования)

```bash
cd /home/valstan/MatricaRMZ/backend-api
pnpm run dev
```

Backend слушает локально: `http://127.0.0.1:3001`
А **снаружи** обычно доступен через nginx/панель провайдера (80/443): `http://a6fd55b8e0ae.vps.myjino.ru`

### 2.2. Проверка работы

В другом терминале:
```bash
curl http://localhost:3001/health
```

Должен вернуть: `{"ok":true}`

### 2.4. Важно: JWT secret (без него логин не работает)

Backend запускается через systemd и читает env из файла:
- `/home/valstan/MatricaRMZ/backend-api/.env`

Там обязательно должен быть задан параметр:
- `MATRICA_JWT_SECRET` (строка **32+ символов**)

Проверка (должно дать 200/401/400, но не 404 и не 500):
```bash
curl -sS -i -X POST http://127.0.0.1:3001/auth/login \
  -H 'Content-Type: application/json' \
  --data '{"username":"admin","password":"admin111"}' | head
```

### 2.3. Запуск в production (через PM2 или systemd)

**Вариант A: PM2 (рекомендуется)**
```bash
# Установить PM2 глобально
npm install -g pm2

# Запустить backend
cd /home/valstan/MatricaRMZ/backend-api
pnpm run build
pm2 start dist/index.js --name matricarmz-api

# Автозапуск при перезагрузке
pm2 startup
pm2 save
```

**Вариант B: systemd service**
Создайте файл `/etc/systemd/system/matricarmz-api.service`:
```ini
[Unit]
Description=MatricaRMZ Backend API
After=network.target postgresql.service

[Service]
Type=simple
User=valstan
WorkingDirectory=/home/valstan/MatricaRMZ/backend-api
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Затем:
```bash
sudo systemctl daemon-reload
sudo systemctl enable matricarmz-api
sudo systemctl start matricarmz-api
```

---

## Шаг 3: Сборка Electron приложения

### 3.1. На VPS (Linux, для тестирования)

```bash
cd /home/valstan/MatricaRMZ/electron-app
pnpm run build
```

Собранные файлы будут в `dist/`

### 3.2. Для Windows (на вашем компьютере)

**Вариант A: Скачать исходники и собрать локально**

1. Установите на Windows:
   - Node.js (v22+)
   - pnpm: `npm install -g pnpm`
   - Git

2. Клонируйте/скачайте проект:
```bash
git clone <ваш_репозиторий> # или скачайте архив
cd MatricaRMZ
pnpm install
```

3. Настройте URL backend API:
   - См. `docs/PATHS.md` → раздел **ENV переменные (ключевые)**.

4. Соберите приложение:
```bash
cd electron-app
pnpm run build
pnpm run dist  # Создаст установщик для Windows
```

Установщик будет в `electron-app/release/`

**Вариант B: Собрать на VPS и скачать**

Если на VPS есть возможность собрать для Windows (нужен wine или cross-compile):

```bash
cd /home/valstan/MatricaRMZ/electron-app
# Настроить apiBaseUrl в src/main/index.ts
pnpm run build
pnpm run dist
```

Затем скачайте файлы из `electron-app/release/` через SCP/SFTP.

---

## Шаг 4: Настройка Electron клиента

### 4.1. Указать URL backend API
См. `docs/PATHS.md` → раздел **ENV переменные (ключевые)**.

### 4.3. Пользователи и права доступа (новое)

Приложение требует входа при старте. Пользователи создаются на сервере.

Техническая заметка:
- `clientId` для синхронизации **стабилен** (хранится в локальной SQLite `sync_state`), поэтому серверный `sync_state` не раздувается от каждого запуска.

Создание пользователя (на VPS):
```bash
cd /home/valstan/MatricaRMZ
pnpm --filter @matricarmz/backend-api user:create -- --username <login> --password <pass> --role admin
```

Seed прав (на VPS, один раз после миграций):
```bash
cd /home/valstan/MatricaRMZ/backend-api
pnpm run perm:seed
```

UI управление правами:
- Вкладка **Справочники** → блок **Пользователи и права доступа** (доступен только при permission `admin.users.manage`).

### 4.2. Запуск в режиме разработки

```bash
cd /home/valstan/MatricaRMZ/electron-app
pnpm run dev
```

---

## Торрент‑обновления клиента

### 1) Переменные окружения backend
Добавьте в `.env` (или systemd Environment):
- `MATRICA_UPDATES_DIR=/opt/matricarmz/updates` — папка с последним `.exe` инсталлятором.
- `MATRICA_PUBLIC_BASE_URL=https://<domain>` — публичный base URL (нужен для ссылок на торрент/трекер).
- `MATRICA_TORRENT_TRACKER_PORT=6969` — порт трекера (HTTP+UDP).
- `MATRICA_TORRENT_TRACKER_URLS=https://<domain>/announce` — список tracker URL (через запятую).

### 2) Размещение инсталлятора
- Положите последнюю сборку `.exe` в `MATRICA_UPDATES_DIR`.
- Backend автоматически создаст `latest.torrent` и будет сидировать файл.

### 3) Проксирование через nginx (пример)
Если используете nginx, добавьте прокси:
- `GET /updates/*` → `http://127.0.0.1:3001/updates/*`

Для трекера:
- откройте порт `MATRICA_TORRENT_TRACKER_PORT` наружу (TCP/UDP), либо настройте проброс.

---

## HTTPS и панель провайдера (важно для синхронизации)

Если на панели настроено проксирование **внешний 443 → внутренний 80**, то HTTPS терминируется не на VPS, а на стороне провайдера. В некоторых сетях Windows может падать с ошибкой schannel `0x80092013` (CRL/OCSP недоступен), и тогда **HTTPS запросы не проходят**, хотя HTTP работает.

Рекомендуемая схема для прод:
- панель: **внешний 80 → внутренний 80**
- панель: **внешний 443 → внутренний 443**
- на VPS: nginx `listen 443 ssl;` + сертификат Let's Encrypt

Быстрый workaround: для синхронизации использовать `http://<domain>` как `apiBaseUrl` (без `:3001`).

---

## Частые проблемы и решения (для следующих сессий разработки)

### 1) Синхронизация не работает “через интернет”
Проверьте, что клиент использует **nginx (80/443)**, а не прямой порт backend:
- правильно: `apiBaseUrl=http://<domain>` или `https://<domain>`
- неправильно (часто заблокировано провайдером): `apiBaseUrl=http://<domain>:3001`

На сервере nginx должен проксировать как минимум:
- `GET /health` → `http://127.0.0.1:3001/health`
- `POST /sync/push` → `http://127.0.0.1:3001/sync/push`
- `GET /sync/pull?...` → `http://127.0.0.1:3001/sync/pull?...`

### 2) Ошибка `push HTTP 502` (nginx Bad Gateway)
Симптом: в Electron `push HTTP 502`, а nginx пишет `upstream prematurely closed connection`.

Реальная причина, которую уже ловили в этом проекте: **переполнение `integer` временем в миллисекундах** (PostgreSQL int4).
В проекте время (`created_at`, `updated_at`, `deleted_at`, `performed_at`, `sync_state.last_*`) хранится как Unix-time в **миллисекундах**, поэтому в PostgreSQL эти поля обязаны быть **`bigint`**.

Фикс:
- Drizzle schema: `bigint(..., { mode: 'number' })`
- миграция: изменить тип колонок `ALTER TABLE ... ALTER COLUMN ... SET DATA TYPE bigint`

### 3) Windows не может ходить по HTTPS (schannel `0x80092013`)
Это не проблема API/БД, а проверка отзыва сертификата (CRL/OCSP) на стороне провайдера/панели.

Варианты:
- быстро: использовать `http://<domain>` для `apiBaseUrl`
- правильно: сделать свой TLS на VPS (nginx + Let's Encrypt) и проброс 443→443

См. также: `docs/TROUBLESHOOTING.md`.

---

## Шаг 5: Тестирование синхронизации

### 5.1. Запустить backend на VPS
```bash
cd /home/valstan/MatricaRMZ/backend-api
pnpm run dev
```

### 5.2. Запустить Electron приложение
```bash
cd /home/valstan/MatricaRMZ/electron-app
pnpm run dev
```

### 5.3. Проверить синхронизацию

1. В Electron приложении:
   - Откройте вкладку "Двигатели"
   - Нажмите "Добавить двигатель"
   - Введите номер и марку
   - Перейдите на вкладку "Синхронизация"
   - Нажмите "Синхронизировать сейчас"

2. Проверить в базе данных:
```bash
sudo -u postgres psql -d matricarmz -c "SELECT * FROM entities LIMIT 5;"
```

---

## ✅ Текущий статус

1. ✅ **PostgreSQL настроен** — пользователь `valstan` создан, миграции применены
2. ✅ **Backend готов** — можно запускать через `pnpm run dev`
3. ⏳ **Electron сборка для Windows** — нужно собрать на вашем компьютере
4. ⏳ **Тестирование** — готово к проверке синхронизации

---

## Следующие шаги

После того как все заработает:
- Настроить автозапуск backend через PM2/systemd
- Настроить firewall для доступа к порту 3001 (если нужно)
- Создать релиз Electron приложения с автообновлением через GitHub Releases
- Аутентификация пользователей уже реализована (логин/пароль → JWT + refresh token) и обязательна при запуске клиента.

