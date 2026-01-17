# Релизы MatricaRMZ (независимые версии клиента и бэкенда)

## Формат версий

Версия хранится в формате **MAJOR.MINOR.RELEASE**.

- **RELEASE** — монотонный счётчик релизов (увеличивается *на каждом* выпуске и **не сбрасывается** при росте MAJOR/MINOR).
- **MINOR** повышаем при заметных функциональных/UX-изменениях без «ломания» совместимости.
- **MAJOR** повышаем при несовместимых изменениях (когда нужен обязательный апдейт).

### Клиент (Electron)
Источник истины: файл `VERSION` в корне репозитория + `electron-app/package.json` (они должны совпадать).

Клиент использует формат `MAJOR.MINOR.RELEASE`, где:

- `MAJOR` — главный релиз (повышаем при реально больших/ломающих изменениях).
- `MINOR` — “beta-ветка” (можно повышать для группировки изменений). При `MAJOR` релизе `MINOR` **сбрасывается в 0**.
- `RELEASE` — **количество всех изменений клиента**, считая git‑коммиты, которые затрагивали `electron-app/**` или `shared/**`:
  - `git rev-list --count HEAD -- electron-app shared`

Из-за перехода на схему “RELEASE=git‑счётчик” версия клиента могла **визуально “скакнуть”** — это **не означает**, что клиент внезапно получил 80 релизов, просто поменялся смысл третьего разряда.

### Backend API
Источник истины: `backend-api/package.json`.

## Как выпускаем новую версию клиента (Electron)

1. Поднимаем версию через скрипт (он обновит `VERSION` и версию `electron-app`):
   - обычный релиз: `pnpm version:bump`
   - минорный релиз: `pnpm version:bump:minor`
   - мажорный релиз: `pnpm version:bump:major`
2. Делаем коммит.
3. Создаем тег вида `vX.Y.Z` (например `v0.1.53`) и пушим его в GitHub.
4. GitHub Actions соберёт Windows установщик и загрузит файлы в GitHub Releases.

Важно: **клиент и бэкенд могут быть разных версий** — это нормально. Клиент обновляется при запуске, а совместимость обеспечивается API/миграциями.

## Правило: команда “выпусти релиз” (автоматически: клиент + backend)

Если в задаче/чате написано **«выпусти релиз»**, используем автоматическую команду:

```bash
cd /home/valstan/MatricaRMZ
pnpm release:auto
```

Что делает `pnpm release:auto`:

- проверяет изменения в **клиенте** (`electron-app/**` + `shared/**`) с момента последнего тега `vX.Y.Z`
- проверяет, “отстаёт” ли **backend** (`backend-api/package.json`) от git‑счётчика изменений (`backend-api/**` + `shared/**`)
- если у клиента/бэкенда есть изменения — выставляет версии по правилам (в т.ч. третий разряд = git‑счётчик), делает отдельные коммиты
- если был новый релиз backend — делает `pnpm -C shared build`, `pnpm -C backend-api build`, затем пытается перезапустить backend (systemd)
- создаёт тег `v<client-version>` (если нужно) и **пушит** `main` и `--tags`

Важно: если релиз содержит изменения схемы БД, необходимо применять миграции на backend.
Рекомендуется выполнять полный цикл: сборка shared+backend, `db:migrate`, `perm:seed`,
и перезапуск сервиса, чтобы клиент сразу мог синхронизироваться без ошибок.

## Веб‑админка (web-admin)

Веб‑админка — отдельное браузерное приложение. Оно **раздаётся backend‑ом** как статические файлы из `web-admin/dist`
и доступно по пути `/admin-ui/`.

### Сборка
```bash
cd /home/valstan/MatricaRMZ
pnpm --filter @matricarmz/web-admin install
pnpm --filter @matricarmz/web-admin build
```

После сборки должны появиться файлы:
```
/home/valstan/MatricaRMZ/web-admin/dist
```

### Запуск / перезапуск
Если backend уже работает — достаточно **перезапустить backend**, чтобы он подхватил новую сборку:
- systemd: `sudo systemctl restart matricarmz-backend.service`
- pm2: `pm2 restart matricarmz-api`

### Проксирование в nginx (обязательно)
В nginx нужно проксировать `/admin-ui/` на backend:
```nginx
location /admin-ui/ {
  proxy_pass http://127.0.0.1:3001/admin-ui/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```
После изменения:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Проверка
```bash
curl -I http://127.0.0.1:3001/admin-ui/
```
Ожидаемо: `200 OK` (если backend доступен и папка `web-admin/dist` существует).

### Замечание по адресу API
По умолчанию веб‑админка использует **тот же домен**, где она открыта.
Для dev‑режима можно задать:
```
VITE_API_BASE_URL=http://127.0.0.1:3001
```

Настройки для перезапуска backend (опционально):

- `MATRICA_BACKEND_RESTART_CMD`: произвольная команда перезапуска (например `pm2 restart matricarmz-api`)
- `MATRICA_BACKEND_SYSTEMD_SERVICE`: имя systemd сервиса (по умолчанию `matricarmz-backend.service`)

1. **Определить тип релиза и поднять версию**
   - решить: `patch` / `minor` / `major` (по правилам выше)
   - выполнить bump:
     - `pnpm version:bump` (patch)
     - `pnpm version:bump:minor`
     - `pnpm version:bump:major`
   - сделать commit, где в сообщении есть версия (`v$(cat VERSION)`).

2. **Выпустить новый релиз клиента**
   - создать тег `vX.Y.Z` (равный `VERSION`) и запушить его
   - дождаться GitHub Actions (Release Electron) — он опубликует релиз и обновления (включая Яндекс.Диск).

3. **Запушить на GitHub**
   - `git push origin main --tags`

## Обновление Backend API (независимо от релиза клиента)

Если нужно обновить backend (VPS/прод) — делаем это отдельной процедурой, без требования совпадения версий:

### Версия Backend API (как считается)

Backend использует тот же формат `MAJOR.MINOR.RELEASE`, но:

- `MAJOR.MINOR` — “ветка” (beta/minor/major) и повышается вручную при крупных изменениях.
- `RELEASE` — **количество всех изменений backend**, считаемое как число git‑коммитов, которые затрагивали `backend-api/**`:
  - `git rev-list --count HEAD -- backend-api`

Из-за этого при переходе на новую схему версия backend могла **визуально “уменьшиться”** (например, `0.3.63 → 0.3.32`) — это **не откат**, а переопределение смыслов разряда `RELEASE`.

1) (Опционально) поднять версию backend:
- `pnpm version:backend:bump` (установит `RELEASE` по git‑счётчику)
- `pnpm version:backend:bump:minor` (MINOR+1, RELEASE по git‑счётчику)
- `pnpm version:backend:bump:major` (MAJOR+1, MINOR=0, RELEASE по git‑счётчику)

2) Деплой/перезапуск:
- обновить код (обычно `git pull`)
- `pnpm install`
- `pnpm -C shared build`
- `pnpm -C backend-api build`
- перезапустить backend:
  - systemd: `sudo systemctl restart <service-name>`
  - pm2: `pm2 restart <name>`
  - вручную: остановить старый процесс и запустить `pnpm -C backend-api start`

## Команды

```bash
cd /home/valstan/MatricaRMZ

# пример: минорный релиз (MINOR+1, RELEASE+1)
pnpm version:bump:minor

git add VERSION electron-app/package.json
git commit -m "release: v$(cat VERSION)"

git tag "v$(cat VERSION)"
git push origin main --tags
```

## Автообновление

Обновление клиента идёт через **Яндекс.Диск (public folder)**:
- клиент проверяет обновления при запуске и устанавливает их автоматически;
- меню для ручной проверки обновлений больше не используется.

`release-info.json` формируется в GitHub Actions (шаг `Write release-info.json`) и упаковывается в приложение.


