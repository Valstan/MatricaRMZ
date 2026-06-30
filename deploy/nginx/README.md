# Nginx config для MatricaRMZ backend

`matricarmz-backend.conf` — конфигурация nginx, которая лежит на проде в
`/etc/nginx/conf.d/matricarmz-backend.conf`.

## Что делает

Reverse-proxy перед двумя экземплярами backend'а (`matricarmz-backend-primary` и
`matricarmz-backend-secondary`, порты 3001/3002), плюс SSL-терминация и
HTTP→HTTPS редирект.

## Архитектура: catch-all + спец-блоки

Все эндпойнты backend'а проксируются через **catch-all `location /`** на
дефолтных настройках (30s read/send timeout, 2m body). **Новые эндпойнты в
backend работают без правки nginx.**

Специальные `location ^~ /…/` блоки определены **только** для эндпойнтов с
нестандартными параметрами:

| Location | Read/Send timeout | Body size | Особенности |
|---|---|---|---|
| `/sync/` | 300s | 20m | большие буферы (32×128k) |
| `/files/` | 300s | 30m | — |
| `/ai/` | 300s | — | `proxy_buffering off` (SSE/streaming) |
| `/ledger/` | 300s | — | большие буферы (32×128k) |
| `/updates/` | 300s | — | загрузка .exe |
| `/backups/` | 300s | — | pg_dump streaming |
| `/reports/` | 60s | — | — |
| `/work-orders/` | 60s | — | — |
| `/auth/` | 30s | 2m | — |
| `/api(/v1)?/(erp|warehouse)/…` | 30s | 2m | regex rewrite в `/erp/…` или `/warehouse/…` |

Раньше config был whitelist'ом на 580 строк, по 12-строчному блоку на каждый
эндпойнт. При добавлении нового маршрута в backend (`/warehouse-locations`,
`/workshops`, …) нужно было руками вписывать новый блок, иначе nginx отдавал
404. Сейчас catch-all это решает.

## Как выкатить на прод

```bash
ssh matricarmz
cd /home/valstan/MatricaRMZ
git pull --ff-only
bash deploy/nginx/install.sh
```

Скрипт:

1. Сохраняет текущий конфиг в `/etc/nginx/conf.d/matricarmz-backend.conf.bak-<ts>`.
2. Копирует `deploy/nginx/matricarmz-backend.conf` → `/etc/nginx/conf.d/`.
3. Валидирует через `nginx -t`.
4. Перезагружает: `nginx -s reload`.
5. Smoke-test: `curl https://127.0.0.1/health`.

При любой ошибке после копирования — авто-откат из backup'а и `nginx -s reload`.

## Когда нужно править config

Только если новый эндпойнт требует **нестандартных параметров**:

- timeout > 30s (например streaming/long-poll)
- body > 2m (например загрузка файлов)
- особые буферы / `proxy_buffering off`

Иначе ничего не править — catch-all обработает автоматически.

## Ручной откат

Backup-файл показывается в конце вывода `install.sh`. Чтобы вернуть:

```bash
sudo cp /etc/nginx/conf.d/matricarmz-backend.conf.bak-<ts> \
        /etc/nginx/conf.d/matricarmz-backend.conf
sudo nginx -s reload
```
