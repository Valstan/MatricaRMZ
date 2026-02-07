# Troubleshooting MatricaRMZ (синхронизация / деплой)

Цель: чтобы в следующих сессиях разработки быстро диагностировать “почему не синкается”.

---

## 1) Быстрая проверка доступности API (снаружи)

На рабочем месте (Windows):

- Проверка, что nginx/панель пропускают HTTP:
  - `curl.exe -I http://<domain>/health`

Если это работает — API снаружи доступен по 80, и клиент **должен** использовать `apiBaseUrl=http://<domain>`.

---

## 1.2) Legacy `/sync/*` больше не используется

Синхронизация работает **только через ledger**:
- `POST /ledger/tx/submit` — push
- `GET /ledger/state/changes` — pull

`/sync/push` и `/sync/pull` возвращают `410 Gone` и не должны использоваться.

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

## 6) `sync_dependency_missing` и рассинхрон доменных данных

### Симптом
Electron в вкладке “Синхронизация” показывает ошибку push:
- `sync_dependency_missing: ...`

### Причина
Сервер обнаружил зависимость, которой нет в БД (например, `entity_type`, `attribute_def`, `engine_entity` или `chat_message`).
Раньше такие строки могли тихо отбрасываться, из‑за чего данные терялись.

### Что происходит сейчас
- Сервер возвращает явную ошибку и не коммитит транзакцию.
- Клиент автоматически делает `resetSyncState` → полный `pull` (`since=0`) → повторный `push` один раз.

### Что делать, если ошибка повторяется
- Проверьте, что сервер и клиент на актуальной версии.
- В web‑admin можно запустить “Пересинхронизировать сотрудников” (если проблема в справочнике сотрудников).
- При необходимости выполнить диагностику в web‑admin → раздел “Диагностика”.

---

## 7) Клиентские логи: отправка на сервер (remote logging)

Описание путей, файлов и механизмов логирования находится в `docs/PATHS.md`
(разделы **Логи** и **Troubleshooting checklist**). Это единый источник,
чтобы не дублировать информацию в нескольких местах.

---

## 8) Восстановление консистентности (ledger → БД)

### Когда нужно
- Диагностика показывает расхождения (`/diagnostics/consistency`).
- Есть подозрение, что ledger содержит каноничные изменения, а БД отстала.

### Вариант A: админ‑эндпоинт (рекомендуется)
- `POST /diagnostics/ledger/replay` (требуется permission `clients.manage`).
- Применяет ledger‑состояние к БД через server‑side pipeline.

### Вариант B: локальный скрипт
```bash
cd /home/valstan/MatricaRMZ/backend-api
pnpm exec tsx src/scripts/ledgerReplayToDb.ts
```

Важно: делайте это в период минимальной нагрузки и только после бэкапа.

---

## 9) Клиентский full-pull не помогает, ФИО пустые, в логах `ledger/state/changes filtered invalid rows`

### Симптом
- В web‑admin “Диагностика” виден drift по `attribute_values`, но “Перекачать с сервера” не исправляет.
- На сервере в логах backend:
  - `[ledger/state/changes] filtered invalid rows: ...`
- На клиенте возможны ошибки синка `net::ERR_CONNECTION_RESET`.

### Причина
Клиент тянет изменения **из ledger** (`/ledger/state/changes`), а не из `change_log`.
Если ledger повреждён/неконсистентен (массово “filtered invalid rows”), клиент отбрасывает изменения и остаётся с пустыми полями.

### Решение (пересобрать ledger из БД)
```bash
sudo systemctl stop matricarmz-backend.service

# резервная копия старого ledger
mv /home/valstan/MatricaRMZ/backend-api/ledger /home/valstan/MatricaRMZ/backend-api/ledger.bak-$(date +%Y%m%d-%H%M%S)

# пересборка ledger
cd /home/valstan/MatricaRMZ/backend-api
pnpm run ledger:import

sudo systemctl start matricarmz-backend.service
curl -sS http://127.0.0.1:3001/health
```

После этого на клиенте: “Перекачать с сервера”/“Повторить синхронизацию”.


