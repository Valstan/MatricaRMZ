# Systemd units for MatricaRMZ

## `matricarmz-backend-primary` / `matricarmz-backend-secondary` — backend-api сервисы

Прод запускает два инстанса `backend-api` (за nginx round-robin): **primary** (порт 3001, фоновые джобы) и **secondary** (порт 3002, `MATRICA_INSTANCE_ROLE=secondary`). Оба читают секреты из `EnvironmentFile=/etc/matricarmz/matricarmz.env` (вне репо, см. brain #008) и запускают собранный `dist/index.js`.

Файлы [`matricarmz-backend-primary.service`](matricarmz-backend-primary.service) / [`matricarmz-backend-secondary.service`](matricarmz-backend-secondary.service) — **снимок реально работающей прод-конфигурации** (источник истины; раньше юниты жили только в `/etc/systemd/system/` на проде, без версионирования). Секретов не содержат — только пути, порты и роль.

### Установка / обновление на проде

```bash
sudo cp deploy/systemd/matricarmz-backend-primary.service /etc/systemd/system/
sudo cp deploy/systemd/matricarmz-backend-secondary.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now matricarmz-backend-primary.service matricarmz-backend-secondary.service
curl -fsk https://127.0.0.1/health   # smoke-check
```

> **Предусловия:** клон репо в `/home/valstan/MatricaRMZ`, собранный `backend-api/dist` (`pnpm -F @matricarmz/backend-api build`), `node` в `/usr/bin/node`, секрет-файл `/etc/matricarmz/matricarmz.env`, и **симлинк** `backend-api/.env → /etc/matricarmz/matricarmz.env` (его сносит `git clean -fdx` — пересоздать `ln -sfn /etc/matricarmz/matricarmz.env /home/valstan/MatricaRMZ/backend-api/.env`, иначе `db:migrate` падает). Рестарт релизом — `sudo systemctl restart matricarmz-backend-primary.service matricarmz-backend-secondary.service`.

## `matricarmz-cleanup-updates` — еженедельная очистка старых .exe

После каждого релиза GitHub Action кладёт новый `MatricaRMZ-Setup-X.Y.Z.exe` в `/opt/matricarmz/updates/`. Старые установщики оттуда не удаляются автоматически — со временем там скапливается ~270 МБ (4–5 версий × ~70 МБ).

Этот таймер раз в неделю запускает [`cleanup-updates.sh`](cleanup-updates.sh), который оставляет 3 самых свежих по `mtime` файла, остальные `MatricaRMZ-Setup-*.exe` удаляет.

### Установка на проде

```bash
ssh valstan@<server>
cd ~/MatricaRMZ        # путь к клону репо на проде
git pull --ff-only     # подтянуть скрипт и unit-файлы
bash deploy/systemd/install.sh
```

Что делает `install.sh`:

1. Копирует `cleanup-updates.sh` в `/usr/local/bin/matricarmz-cleanup-updates.sh` (chmod 0755).
2. Копирует `.service` и `.timer` в `/etc/systemd/system/`.
3. `systemctl daemon-reload`.
4. `systemctl enable --now matricarmz-cleanup-updates.timer` — таймер активирован.
5. Smoke-check: запускает `--dry-run` для проверки прав и видимости каталога.
6. Печатает следующий запуск (`list-timers`).

### Расписание

- **OnCalendar=Sun *-*-* 03:00:00** — каждое воскресенье в 03:00 MSK (низкая нагрузка, операторов нет).
- **Persistent=true** — если в момент запуска сервер был выключен, скрипт запустится при следующем boot'е.

### Параметры

По умолчанию хранятся 3 последних `.exe`. Изменить можно через systemd drop-in:

```bash
sudo systemctl edit matricarmz-cleanup-updates.service
```

В редакторе добавить:

```ini
[Service]
Environment=KEEP_COUNT=5
```

### Ручной запуск / диагностика

```bash
# Прогон вручную (выполняется немедленно, без ожидания таймера)
sudo systemctl start matricarmz-cleanup-updates.service

# Что было / что будет
sudo journalctl -u matricarmz-cleanup-updates.service --since "1 week ago"
sudo systemctl list-timers matricarmz-cleanup-updates.timer

# Dry-run без удаления
sudo /usr/local/bin/matricarmz-cleanup-updates.sh --dry-run
```

### Откат

```bash
sudo systemctl disable --now matricarmz-cleanup-updates.timer
sudo rm /etc/systemd/system/matricarmz-cleanup-updates.{service,timer}
sudo rm /usr/local/bin/matricarmz-cleanup-updates.sh
sudo systemctl daemon-reload
```

### Безопасность

- Скрипт **отказывается** работать с каталогами вне `/opt/*` (защита от опечатки `UPDATES_DIR`).
- Удаляются только файлы по pattern `MatricaRMZ-Setup-*.exe`, всё остальное в каталоге не трогается.
- Service-unit использует `ProtectSystem=full` + `ProtectHome=true` + `ReadWritePaths=/opt/matricarmz/updates` — даже если скрипт сошёл с ума, он не может писать никуда ещё.
