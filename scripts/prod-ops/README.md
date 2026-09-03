# Prod-ops scripts (Phase 4: автоматизация безопасности)

Три задачи cron на проде, плюс установщик.

## Скрипты

| Скрипт | Запуск | Что делает |
|---|---|---|
| `backup-encrypted.sh` | ежедневно ночью | одним потоком `tar`(ledger + `pg_dump`) → zstd → GPG AES-256 → Yandex.Disk; ротация 14 копий; архив проверяется листингом до отправки; Telegram при любом отказе; отказ ещё до старта, если под архив нет места (`--no-upload` — приёмочный прогон без отправки) |
| `audit-deps.sh` | еженедельно | `pnpm audit --prod --json` → Telegram-алерт при high/critical |
| `watch-failed-auth.sh` | каждые 5 минут | парсит `/var/log/nginx/matricarmz_access.log`, считает 401/403 по `X-Forwarded-For`, Telegram при всплеске с одного IP (порог и cooldown — в скрипте) |

Все три читают `~/MatricaRMZ/backend-api/.env` для:
- PG-кред (`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGHOST`/`PGPORT`)
- Yandex.Disk (`YANDEX_DISK_TOKEN`, `YANDEX_DISK_BASE_PATH`)
- Telegram (`MATRICA_TELEGRAM_ENABLED`, `MATRICA_TELEGRAM_BOT_TOKEN`, `MATRICA_TELEGRAM_ALERT_CHAT_ID`)

## Установка

```bash
ssh matricarmz
cd ~/MatricaRMZ
git pull --ff-only
bash scripts/prod-ops/install-prod-ops.sh
```

Установщик:
1. Создаёт `/etc/matricarmz`, `/var/log/matricarmz`, `/var/lib/matricarmz`.
2. Копирует скрипты в `/usr/local/sbin/matricarmz-*`.
3. **Генерирует passphrase** в `/etc/matricarmz/backup.passphrase` (mode 600, root) — **печатает на экран ровно один раз**. Сохраните вне сервера в менеджере паролей. Без этой passphrase бэкапы расшифровать нельзя.
4. Добавляет сервисного пользователя (того, кто запускает установщик; `MATRICA_USER`) в группу `adm` (для чтения nginx-логов).
5. Пишет cron в `/etc/cron.d/matricarmz-ops`.

## Проверка вручную перед cron

От имени сервисного пользователя (того же, что в cron):

```bash
# Watch failed auth — самый безопасный, читает только логи
/usr/local/sbin/matricarmz-watch-failed-auth

# Audit deps — может занять минуту
/usr/local/sbin/matricarmz-audit-deps

# Backup, приёмка — строит и проверяет архив, ничего не отправляет (минуты, ~2 ГБ в /tmp на время прогона)
/usr/local/sbin/matricarmz-backup-encrypted --no-upload

# Backup, полный прогон — плюс отправка на Я.Диск и ротация
/usr/local/sbin/matricarmz-backup-encrypted
```

Telegram-алерт уходит только при `MATRICA_TELEGRAM_ENABLED=true` в `.env`; выключенный или ненастроенный TG скрипт пишет в лог строкой `telegram alert suppressed …`, так что подавленный алерт виден. Единственный случай, когда алерт невозможен, — нечитаемый сам `.env` (в нём и лежат credentials); скрипт говорит об этом явно (`ALERT IMPOSSIBLE`). Второй одновременный прогон отказывает по `flock` (`/var/lib/matricarmz/backup.lock`).

Скрипт покрыт смоук-тестом `backup-encrypted.test.sh` (фикстура ledger, шимы `pg_dump`/`curl`, `--no-upload`): happy-path и семь путей отказа, каждый — с проверкой, что алерт ушёл ровно один раз. Гоняется в CI (job `prod-ops-backup`); локально на машине без `zstd`/`flock` печатает `SKIP`.

## Перенос вложений на Я.Диск (`files:offload-to-yandex`)

Вложения до `MATRICA_MAX_LOCAL_BYTES` (по умолчанию 10 МиБ) лежат на боксе, крупнее — на Я.Диске. Когда бокс — дефицитный ресурс, порог опускают в `.env` (новые файлы) и переносят уже сохранённые:

```bash
cd ~/MatricaRMZ
corepack pnpm -F @matricarmz/backend-api files:offload-to-yandex                      # dry-run: кандидаты + сироты, ничего не меняет
corepack pnpm -F @matricarmz/backend-api files:offload-to-yandex --limit 100 --apply  # первая партия, крупные первыми
corepack pnpm -F @matricarmz/backend-api files:offload-to-yandex --apply              # остальное
```

- `--min-bytes N` — порог (по умолчанию `MATRICA_MAX_LOCAL_BYTES`, если задан, иначе 1 МиБ); `--limit N` — сколько файлов за прогон (0 = все).
- Каждый файл: sha256 на диске = строке → загрузка → Яндекс подтверждает размер и sha256/md5 → строка переводится на `yandex` (только если она всё ещё `local` и жива) → локальная копия удаляется. Отказ на любом шаге оставляет строку и локальную копию; загрузка при этом удаляется. Превью не трогаются, маршрут раздачи один и тот же.
- Второй одновременный `--apply` отказывает (advisory lock в PG). Три отказа подряд с одной причиной — стоп: это среда (токен, сеть, квота), не файлы.
- Сироты в `uploads/local` (файл без живой локальной строки) печатаются всегда; в `--apply` удаляются только те, чья строка уже на Яндексе и копия там подтверждена.
- **Лог прогона — манифест.** Строка `OK <id> … -> <path> sha256=<hex>` позволяет после восстановления БД из дампа старше прогона снова привязать строки: `UPDATE file_assets SET storage_kind='yandex', yandex_disk_path=$2, local_rel_path=NULL WHERE id=$1 AND storage_kind='local';`. Сразу после успешного `--apply` — внеочередной `matricarmz-backup-encrypted`, чтобы свежий дамп уже нёс новые пути.

## Восстановление из бэкапа

```bash
# Скачать с Я.Диска (название: matricarmz-backup-YYYYMMDD-HHMMSS.tar.zst.gpg;
# копии до сентября 2026 — matricarmz-backup-*.tar.gpg, их раскладка описана ниже)
# Папка — YANDEX_DISK_BASE_PATH из прод-env; на проде это /matricarmz/files (та же, где вложения),
# а /matricarmz-backups — лишь дефолт скрипта, который прод перебивает. Точный путь скрипт печатает
# строкой `done: <path>`. Подставляем значение, а не $YANDEX_DISK_BASE_PATH: восстановление часто
# идёт на машине без прод-env (он внутри бэкапа), там переменная развернётся в пустоту.
curl -L -H "Authorization: OAuth $YANDEX_DISK_TOKEN" \
  "https://cloud-api.yandex.net/v1/disk/resources/download?path=/matricarmz/files/<file>" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['href'])" \
  | xargs curl -L -o backup.tar.zst.gpg

# Инструменты на машине восстановления: gpg 2.x, zstd, tar, pg_restore >= 17 (postgresql-client-17
# из PGDG, собранный с zstd — штатный клиент Ubuntu 24.04 (16) дамп pg_dump 17 не читает:
# «unsupported version (1.16)»). Пароль: --passphrase-file работает только с --batch;
# для интерактивного ввода — export GPG_TTY=$(tty) и без --batch.

# Вариант А — со staging-каталогом (нужно ~2× размера ledger свободного места)
mkdir restore && gpg --batch --passphrase-file <pass> --decrypt backup.tar.zst.gpg | zstd -d | tar -x -C restore
# теперь restore/db.dump, restore/<index/state/keys>.json и restore/blocks/… (без archive/, *.bak.*, *.corrupt.*)
pg_restore --list restore/db.dump | head -3        # должен показать Compression: zstd
pg_restore --clean --if-exists --no-owner --no-privileges -d <db> restore/db.dump
rsync -a --exclude db.dump restore/ "$MATRICA_LEDGER_DIR"/

# Вариант Б — потоком, без staging (место нужно только под сам архив)
gpg --batch --passphrase-file <pass> -d backup.tar.zst.gpg | zstd -d | tar -x --exclude=db.dump -C "$MATRICA_LEDGER_DIR"
gpg --batch --passphrase-file <pass> -d backup.tar.zst.gpg | zstd -d | tar -xO db.dump \
  | pg_restore --clean --if-exists --no-owner --no-privileges -d <db>
```

Условия на проде: остановить оба сервиса (`sudo systemctl stop matricarmz-backend-primary matricarmz-backend-secondary`); целевой каталог ledger — из `MATRICA_LEDGER_DIR` в `/etc/matricarmz/matricarmz.env` (**не** `backend-api/ledger` — это паразитная копия); распаковывать от имени сервисного пользователя (`sudo -Hu <user>`); после — права на ключи по `docs/SECURITY.md` (Фаза 1), затем primary → `/health` → secondary. Порядок в архиве гарантирует, что индекс не опережает блоки.

**Обязательная проверка высоты — до старта primary, не после.** Оба варианта распаковки кладут файлы поверх населённого каталога (`rsync` без `--delete`, `tar -x`), поэтому блоки прежней жизни ledger'а остаются лежать выше восстановленного индекса. Бэкенд их **не** подберёт и **не** пересчитает индекс: `ensureLedgerStateFile` (`backend-api/src/ledger/ledgerService.ts`) в `blocks/` не заглядывает — он либо копирует `state.json.bak.*`, либо пишет **пустой** state. А `store.ts` берёт высоту как `index.lastHeight + 1` и пишет по этому пути без проверки существования: лишние блоки сначала раздаются клиентам через `listBlocksSince`, а потом молча перезаписываются другими байтами на тех же высотах — это форк цепочки.

```bash
# старший блок в blocks/ обязан совпасть с lastHeight из индекса
ls "$MATRICA_LEDGER_DIR"/blocks/*.json | sed 's#.*/##; s#\.json$##' | sort -n | tail -1
python3 -c "import json;print(json.load(open('$MATRICA_LEDGER_DIR/index.json'))['lastHeight'])"
# не совпало — удалить всё, что выше lastHeight, и только потом поднимать primary
```

Если скрипт при сборке архива напечатал `WARN: … block(s) are ahead of the archived index`, эта проверка не формальность: в самом архиве блоки уже опережают его собственный индекс.

Старая раскладка (`.tar.gpg`, до сентября 2026; тоже pg_dump 17 → pg_restore ≥ 17): `gpg --batch --passphrase-file <pass> --decrypt --output backup.tar backup.tar.gpg && tar -xvf backup.tar` даёт `db.dump` и `ledger.tar.zst`; ledger распаковывается `zstd -d ledger.tar.zst -o ledger.tar && tar -xvf ledger.tar -C "$MATRICA_LEDGER_DIR"`.

**Где лежат старые копии.** 03.09.2026 все 14 архивов старого формата (31.07–13.08, 15,5 ГБ) перенесены в **`/matricarmz/files/backups-frozen-2026-08/`** — подставлять этот путь в команду скачивания выше. Причина: префикс имени у старого и нового формата общий, а ротация удаляет с `permanently=true`, то есть мимо корзины. Ротация листает базовую папку **не рекурсивно**, поэтому подпапка ей не видна и набор заморожен. Размораживать (возвращать в базовую папку или удалять) — только после того, как архив **нового** формата хотя бы раз восстановят на машине без `/etc/matricarmz/backup.passphrase`: до этого старый набор — единственный проверенный практикой фолбэк. Той же датой сделан первый успешный архив нового формата (`matricarmz-backup-20260903-201439.tar.zst.gpg`, 1703 МБ) — до него ledger был без резервной копии с 13.08.

Проверка без восстановления (то же, что скрипт делает перед отправкой): `gpg --batch --passphrase-file <pass> --decrypt backup.tar.zst.gpg | zstd -d | tar -t | head`.

## Параметры через env

Все скрипты принимают override через переменные окружения:

| Var | Скрипт | Что меняет |
|---|---|---|
| `MATRICA_ENV_FILE` | все | путь к .env (default: `$MATRICA_REPO_DIR/backend-api/.env`, при его отсутствии — `/etc/matricarmz/matricarmz.env`) |
| `MATRICA_BACKUP_PASSPHRASE_FILE` | backup | путь к passphrase |
| `MATRICA_BACKUP_RETENTION` | backup | сколько копий хранить (default 14; целое ≥ 1, иначе отказ) |
| `MATRICA_BACKUP_ZSTD_RATIO_PCT` | backup | ожидаемый размер архива в % от ledger для предполётной проверки (default 50; фактический печатается каждым прогоном) |
| `MATRICA_BACKUP_FLOOR_BYTES` | backup | сколько места оставить соседям по разделу (default 1 ГиБ): при нехватке — отказ до первого байта |
| `MATRICA_BACKUP_DUMP_EST_BYTES` | backup | оценка размера `db.dump` для предполётной проверки **до** `pg_dump` (default 128 МиБ ≈ 2× замера прода 2026-09-03: 70,8 МБ). Гейт сразу после дампа перепроверяет по фактическому размеру, поэтому заниженная оценка стоит одного лишнего дампа, а завышенная отказывает на боксе, где бэкап прошёл бы |
| `MATRICA_BACKUP_LOCK` | backup | файл блокировки от двойного запуска (default `/var/lib/matricarmz/backup.lock`) |
| `MATRICA_OPS_TELEGRAM_ENABLED` | все | включает алерты ops-скриптов, не трогая продуктовый Telegram (`MATRICA_TELEGRAM_ENABLED` включил бы заодно polling бота и critical-events). Не задан — падает обратно на `MATRICA_TELEGRAM_ENABLED` |
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
