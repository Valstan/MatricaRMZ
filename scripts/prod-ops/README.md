# Prod-ops scripts (Phase 4: автоматизация безопасности)

Три задачи cron на проде, плюс установщик.

## Скрипты

| Скрипт | Запуск | Что делает |
|---|---|---|
| `backup-encrypted.sh` | ежедневно 03:17 MSK | `pg_dump` + tar ledger → zstd → GPG AES-256 → Yandex.Disk; ротация 14 копий |
| `audit-deps.sh` | пн 04:23 MSK | `pnpm audit --prod --json` → Telegram-алерт при high/critical |
| `watch-failed-auth.sh` | каждые 5 минут | парсит `/var/log/nginx/matricarmz_access.log`, считает 401/403 по `X-Forwarded-For`, Telegram при ≥10/5мин с IP, cooldown 1 час |

Все три читают `/home/valstan/MatricaRMZ/backend-api/.env` для:
- PG-кред (`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGHOST`/`PGPORT`)
- Yandex.Disk (`YANDEX_DISK_TOKEN`, `YANDEX_DISK_BASE_PATH`)
- Telegram (`MATRICA_TELEGRAM_ENABLED`, `MATRICA_TELEGRAM_BOT_TOKEN`, `MATRICA_TELEGRAM_ALERT_CHAT_ID`)

## Установка

```bash
ssh matricarmz
cd /home/valstan/MatricaRMZ
git pull --ff-only
bash scripts/prod-ops/install-prod-ops.sh
```

Установщик:
1. Создаёт `/etc/matricarmz`, `/var/log/matricarmz`, `/var/lib/matricarmz`.
2. Копирует скрипты в `/usr/local/sbin/matricarmz-*`.
3. **Генерирует passphrase** в `/etc/matricarmz/backup.passphrase` (mode 600, root) — **печатает на экран ровно один раз**. Сохраните вне сервера в менеджере паролей. Без этой passphrase бэкапы расшифровать нельзя.
4. Добавляет `valstan` в группу `adm` (для чтения nginx-логов).
5. Пишет cron в `/etc/cron.d/matricarmz-ops`.

## Проверка вручную перед cron

```bash
# Watch failed auth — самый безопасный, читает только логи
sudo -u valstan /usr/local/sbin/matricarmz-watch-failed-auth

# Audit deps — может занять минуту
sudo -u valstan /usr/local/sbin/matricarmz-audit-deps

# Backup — займёт минуты + создаст файл на Я.Диске
sudo -u valstan /usr/local/sbin/matricarmz-backup-encrypted
```

## Восстановление из бэкапа

```bash
# Скачать с Я.Диска (название: matricarmz-backup-YYYYMMDD-HHMMSS.tar.gpg)
curl -L -H "Authorization: OAuth $YANDEX_DISK_TOKEN" \
  "https://cloud-api.yandex.net/v1/disk/resources/download?path=/matricarmz-backups/<file>" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['href'])" \
  | xargs curl -L -o backup.tar.gpg

# Расшифровать (введёт пароль или подсунуть через --passphrase-file)
gpg --decrypt --output backup.tar backup.tar.gpg

# Распаковать
tar -xvf backup.tar
# теперь есть db.dump и ledger.tar.zst

# Восстановить PG
pg_restore --clean --if-exists --no-owner --no-privileges -d <db> db.dump

# Распаковать ledger
zstd -d ledger.tar.zst -o ledger.tar
tar -xvf ledger.tar -C <target>
```

## Параметры через env

Все скрипты принимают override через переменные окружения:

| Var | Скрипт | Что меняет |
|---|---|---|
| `MATRICA_ENV_FILE` | все | путь к .env (default: `/home/valstan/MatricaRMZ/backend-api/.env`) |
| `MATRICA_BACKUP_PASSPHRASE_FILE` | backup | путь к passphrase |
| `MATRICA_BACKUP_RETENTION` | backup | сколько копий хранить (default 14) |
| `MATRICA_AUTH_WINDOW_MIN` | watch-auth | окно анализа (default 5 мин) |
| `MATRICA_AUTH_THRESHOLD` | watch-auth | порог 401/403 на IP в окне (default 10) |
| `MATRICA_AUTH_COOLDOWN_MIN` | watch-auth | минут между повторными алертами по тому же IP (default 60) |

## Логи

- `/var/log/matricarmz/backup.log`
- `/var/log/matricarmz/audit-deps.log`
- `/var/log/matricarmz/watch-failed-auth.log`

Ротация — стандартная logrotate, если потребуется добавить, сделать отдельным конфигом в `/etc/logrotate.d/`.

## Откат

```bash
sudo rm /etc/cron.d/matricarmz-ops
sudo rm -f /usr/local/sbin/matricarmz-backup-encrypted /usr/local/sbin/matricarmz-audit-deps /usr/local/sbin/matricarmz-watch-failed-auth
# Опционально: /etc/matricarmz, /var/log/matricarmz, /var/lib/matricarmz
```
