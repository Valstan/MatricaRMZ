# 🟡 Два разошедшихся прод-env: сервисы и ops-скрипты читают разные файлы 🗓 since:2026-09-03

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг и отложенное»

Замер 03.09: `~/MatricaRMZ/backend-api/.env` — **обычный файл** (2 210 Б), а не симлинк на `/etc/matricarmz/matricarmz.env`, как требует `deploy/systemd/README.md`. Оба существуют и разошлись по набору ключей: 5 есть только в `/etc/matricarmz/matricarmz.env` (в т. ч. `MATRICA_AI_*`, `PGPOOL_*`, `SECRETS_TOKEN`), 6 — только в `backend-api/.env` (в т. ч. `BACKUP_SNAPSHOT_KEY`, `MATRICA_LEDGER_RELEASE_TOKEN`, `MATRICA_CORS_ORIGINS`).

Кто что читает: бэкенд-сервисы — `EnvironmentFile=/etc/matricarmz/matricarmz.env`; `backup-encrypted` и `matricarmz-nightly-backup.service` — `backend-api/.env`.

**Практическое следствие прямо сейчас:** `MATRICA_MAX_LOCAL_BYTES=1048576` (порог «бокс / Я.Диск», D-069) обязан лечь в **`/etc/matricarmz/matricarmz.env`** — в `backend-api/.env` он на маршрут загрузки не подействует, хотя выглядит очевидным местом. Сведение двух файлов в один — отдельная задача, не в окне выката.

**Перемер 31.10.2026 — расхождение выросло, порог D-069 не задан нигде:** оба файла по-прежнему **обычные** (не симлинки): `backend-api/.env` — 2335 Б (28.09), `/etc/matricarmz/matricarmz.env` — 2850 Б (25.10). Только в `/etc/...` — **14** ключей (`MATRICA_AI_*`, `AI_SERVER_ENGINE_*`, `HOTLINE_RELAY_*`, `SECRETS_TOKEN`, `SECRETS_VAULT_URL`, `PGPOOL_*`), только в `backend-api/.env` — **6** (`BACKUP_SNAPSHOT_KEY`, `MATRICA_LEDGER_RELEASE_TOKEN`, `MATRICA_CORS_ORIGINS`, `AI_READONLY_URL`, `AI_ROUTINE_TOKEN`, `BACKUP_ENCRYPTION_PUBLIC_KEY_FILE`). Читающие по-прежнему разные: оба юнита бэкенда — `EnvironmentFile=/etc/matricarmz/matricarmz.env`, а `matricarmz-nightly-backup.service` — `backend-api/.env`. **И `MATRICA_MAX_LOCAL_BYTES` не найден ни в одном из двух файлов** — то есть порог D-069 сегодня не действует ни по какому пути, а не «в неправильном». Сведение двух файлов в один по-прежнему не сделано.
