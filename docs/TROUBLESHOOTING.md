# Troubleshooting MatricaRMZ (синхронизация / деплой)

Цель: чтобы в следующих сессиях разработки быстро диагностировать “почему не синкается”.

---

## 1) Быстрая проверка доступности API (снаружи)

На рабочем месте (Windows):

- Проверка, что nginx/панель пропускают HTTP:
  - `curl.exe -I http://<domain>/health`

Если это работает — API снаружи доступен по 80, и клиент **должен** использовать `apiBaseUrl=http://<domain>`.

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


