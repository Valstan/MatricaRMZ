# 🟡 Два разошедшихся прод-env: сервисы и ops-скрипты читают разные файлы 🗓 since:2026-09-03

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг и отложенное»

Замер 03.09: `~/MatricaRMZ/backend-api/.env` — **обычный файл** (2 210 Б), а не симлинк на `/etc/matricarmz/matricarmz.env`, как требует `deploy/systemd/README.md`. Оба существуют и разошлись по набору ключей: 5 есть только в `/etc/matricarmz/matricarmz.env` (в т. ч. `MATRICA_AI_*`, `PGPOOL_*`, `SECRETS_TOKEN`), 6 — только в `backend-api/.env` (в т. ч. `BACKUP_SNAPSHOT_KEY`, `MATRICA_LEDGER_RELEASE_TOKEN`, `MATRICA_CORS_ORIGINS`).

Кто что читает: бэкенд-сервисы — `EnvironmentFile=/etc/matricarmz/matricarmz.env`; `backup-encrypted` и `matricarmz-nightly-backup.service` — `backend-api/.env`.

**Практическое следствие прямо сейчас:** `MATRICA_MAX_LOCAL_BYTES=1048576` (порог «бокс / Я.Диск», D-069) обязан лечь в **`/etc/matricarmz/matricarmz.env`** — в `backend-api/.env` он на маршрут загрузки не подействует, хотя выглядит очевидным местом. Сведение двух файлов в один — отдельная задача, не в окне выката.
