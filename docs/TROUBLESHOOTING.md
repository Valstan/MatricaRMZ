# Troubleshooting MatricaRMZ (синхронизация / деплой)

Цель: чтобы в следующих сессиях разработки быстро диагностировать “почему не синкается”.

---

## 1) Быстрая проверка доступности API (снаружи)

На рабочем месте (Windows):

- Проверка, что nginx/панель пропускают HTTP:
  - `curl.exe -I http://<domain>/health`

Если это работает — API снаружи доступен по 80, и клиент **должен** использовать `apiBaseUrl=http://<domain>`.

---

## 1.1) Логин (Electron) падает `login HTTP 404` (nginx 404)

### Симптом
В Electron на вкладке “Вход”:
- `Ошибка: login HTTP 404: <html>... nginx ...</html>`

### Причина
Nginx проксирует не все пути backend. Для авторизации нужны пути:
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`
а для админки:
- `/admin/*`

### Решение
На VPS в nginx конфиге MatricaRMZ должны быть `location ^~ /auth/` и `location ^~ /admin/`.

Проверка:
```bash
curl -I http://127.0.0.1/auth/me
# ожидаемо 401 (если backend жив и прокси настроен)
```

---

## 2) `push HTTP 502` / `502 Bad Gateway`

### Симптом
Electron пишет:
- `push HTTP 502: <html>...502 Bad Gateway...</html>`

Nginx пишет в error log:
- `upstream prematurely closed connection while reading response header from upstream`

### Типовые причины
- backend не запущен / упал
- backend слушает не там, куда проксирует nginx
- **переполнение типа `integer` временем в миллисекундах** (самое коварное — backend падает на insert/update)

### Важное правило про время
В проекте время хранится как Unix-time в **миллисекундах** (`Date.now()`).
В PostgreSQL это **не помещается** в `integer` (int4).

Поэтому колонки вида `created_at`, `updated_at`, `deleted_at`, `performed_at`, `sync_state.last_*` обязаны быть `bigint`.

### Быстрая проверка на сервере

```bash
curl -sS http://127.0.0.1/health
curl -sS http://127.0.0.1/sync/pull?since=0
curl -sS -X POST http://127.0.0.1/sync/push -H 'Content-Type: application/json' --data '{"client_id":"diag","upserts":[]}'
```

Если `push` падает/502 — проблема на стороне backend/БД.

---

## 2.1) Логин падает `500 ... MATRICA_JWT_SECRET is not configured`

### Причина
Backend требует `MATRICA_JWT_SECRET` (32+ символа). Если он не задан в env, `/auth/login` вернёт 500.

### Где задаётся
Если backend запущен через systemd, обычно используется:
- `EnvironmentFile=/home/valstan/MatricaRMZ/backend-api/.env`

### Проверка
```bash
curl -sS -i -X POST http://127.0.0.1:3001/auth/login \
  -H 'Content-Type: application/json' \
  --data '{"username":"admin","password":"admin111"}' | head
```

### Рекомендованный фикс
- Drizzle schema (`backend-api/src/database/schema.ts`): использовать `bigint(..., { mode: 'number' })` для ms timestamp полей.
- Миграция: `ALTER TABLE ... ALTER COLUMN ... SET DATA TYPE bigint`
- Обязательно: ошибки `/sync/*` не должны ронять процесс — нужен `try/catch` или общий error middleware.

---

## 3) HTTPS на Windows падает schannel `0x80092013`

### Симптом
`curl.exe https://<domain>/...` падает с:
- `0x80092013 - Невозможно проверить функцию отзыва...`

### Причина
Windows schannel не может проверить CRL/OCSP сертификата, который выдаёт провайдер/панель (TLS терминируется “не на VPS”).

### Решения
- Быстро: использовать `apiBaseUrl=http://<domain>` (HTTP, порт 80).
- Правильно: свой TLS на VPS:
  - панель: 80→80 и **443→443**
  - nginx: `listen 443 ssl;`
  - Let's Encrypt (certbot)

Для диагностики (не прод): `curl.exe --ssl-no-revoke https://<domain>/health`

---

## 4) `push HTTP 500` из-за новых типов операций/документов (например `supply_request`)

### Симптом
В Electron на вкладке “Синхронизация”:
- `push HTTP 500: ... invalid_enum_value ... received 'supply_request'`

### Причина
Backend запущен на старом `dist/` и его Zod-схема `operation_type` (в `@matricarmz/shared`) не содержит новый тип.

### Решение (VPS)
1) Обновить код (pull) до нужного тега/коммита.
2) Пересобрать `shared` и `backend-api`, затем перезапустить systemd сервис.

```bash
cd /home/valstan/MatricaRMZ
git describe --tags --always

pnpm --filter @matricarmz/shared build
pnpm --filter @matricarmz/backend-api build

sudo systemctl restart matricarmz-backend.service
sudo systemctl status matricarmz-backend.service --no-pager -l | head -n 30
```

---

## 5) `push HTTP 500` (FK) при синхронизации заявок: `operations.engine_entity_id` не существует

### Симптом
Electron:
- `push HTTP 500: error: insert or update on table "operations" violates foreign key constraint "operations_engine_entity_id_entities_id_fk"`

### Причина
Для модуля “Заявки” клиент пишет операции `operation_type='supply_request'` в таблицу `operations` и использует специальный контейнерный `engine_entity_id = 00000000-0000-0000-0000-000000000001`.
Если такой `entities.id` отсутствует на сервере — FK на `operations.engine_entity_id -> entities.id` падает.

### Решение
- Backend должен гарантировать наличие контейнерной сущности перед upsert операций `supply_request`.
- Фикс внесён в `backend-api/src/services/sync/applyPushBatch.ts`: авто-создание system container entity/type при получении `supply_request`.

---

## 6) Клиентские логи: отправка на сервер (remote logging)

В MatricaRMZ есть механизм для диагностики: **клиент (Electron) может отправлять свои логи на сервер**.

### 6.1) Куда клиент отправляет логи
- **Endpoint на сервере**: `POST /logs/client`
  - Реализация: `backend-api/src/routes/logs.ts`
  - Роут подключён в `backend-api/src/index.ts` как `app.use('/logs', logsRouter);`
  - Доступ: требуется авторизация (`requireAuth`), в лог-строку пишется `actor.username`.

### 6.2) Куда сервер складывает эти логи
- По умолчанию: директория **`logs/`** (относительно `WorkingDirectory` backend процесса).
- Файл по дням: **`logs/client-YYYY-MM-DD.log`**
- Папку можно переопределить переменной окружения: **`MATRICA_LOGS_DIR`**

### 6.3) Как это работает на клиенте
- Клиент буферизует записи и отправляет пачкой раз в ~5 секунд.
  - Код: `electron-app/src/main/services/logService.ts` (`LOG_SEND_INTERVAL_MS = 5000`)
- Управляется настройкой `logging.enabled` (IPC `logging:setEnabled`).
  - IPC: `electron-app/src/main/ipc/register/logging.ts`
  - Инициализация фоновой отправки: `electron-app/src/main/ipc/registerIpc.ts` (`startLogSender(...)`)

### 6.4) Локальный файл лога клиента (на ПК пользователя)
Клиент также пишет локальный файл **`matricarmz.log`** в `app.getPath('userData')`.
Код: `electron-app/src/main/ipc/registerIpc.ts`, `electron-app/src/main/services/syncService.ts`.


