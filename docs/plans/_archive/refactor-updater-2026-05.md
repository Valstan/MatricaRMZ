# Refactor: Autoupdater + Self-heal + Boot lifecycle

> **Статус:** ⏳ pre-plan / raw findings. Не начато. Создан 2026-05-27.
> **Источник findings:** сессия `/start` 2026-05-27 (валидация раскатки v1.31.2 после того как v1.31.1 сломал клиент на машине пользователя).
> **Цель:** сделать autoupdater + self-heal + boot lifecycle **быстрее, надёжнее, само-восстанавливающимися** при ошибках запуска и обновления.

## Контекст инцидента 2026-05-27

Цепочка событий, мотивирующая рефакторинг:

1. На прод раскатался **v1.31.1** (Phase 2.4 финал — `DROP COLUMN warehouse_id`).
2. Клиент пользователя автообновился c v1.29.2 → v1.31.1 (autoupdater pull через `/updates/status`, скачка через Yandex.Disk, install через `oneClick: true, perMachine: false`).
3. **Первый старт v1.31.1 упал на SQLite-миграции** `0014_drop_warehouse_id.sql`:
   ```
   sqlite init failed: DrizzleError: Failed to run the query
   ALTER TABLE `erp_reg_stock_balance` DROP COLUMN `warehouse_id`;
   ```
   Причина (выяснилось позже): SQLite не даёт DROP COLUMN если на колонке висит индекс. На колонке `warehouse_id` был индекс с Phase 2.1.
4. **Self-heal сработал** — забэкапил БД в `matricarmz.sqlite.corrupted-2026-05-27T17-37-14-493Z` (30 MB реальных данных), создал пустой `matricarmz.sqlite` (12 KB).
5. **Self-heal попытался накатить миграции на пустой БД** — упал на той же миграции.
6. Клиент мёртв: SQLite не инициализирована, БД пустая, новых corrupted-копий не добавляется (видимо проверка «уже свежий»).
7. На сервере экстренный hot-fix **v1.31.2** ([PR #110](https://github.com/Valstan/MatricaRMZ/pull/110)): миграция SQLite дополнена `DROP INDEX … BEFORE DROP COLUMN`.
8. Но **v1.31.2 не дошёл до клиента**, потому что клиент не может стартовать → не может проверить `/updates/status` → autoupdater не запустится.
9. Починка только ручной установкой installer v1.31.2 (через `gh release download v1.31.2 → запустить .exe`).

**После ручной установки v1.31.2 миграция прошла без ошибок**, клиент жив, sync с продом восстановился (employee list подтянулся).

## Findings (что починить)

### F1. Self-heal в текущем виде зацикливается

**Файл:** [`electron-app/src/main/db/...`](../../electron-app/src/main/) (точное место — выяснить grep'ом по `corrupted db backed up`).

Текущая логика:
1. Миграции падают → бэкап БД с суффиксом `.corrupted-<timestamp>`.
2. Создаётся пустая БД.
3. **Накатывается тот же migrationsFolder** → падает на том же sql-файле.
4. Лог: `DB self-heal failed: <same error>`.
5. SQLite не готова, IPC не зарегистрирован, renderer не стартует.

**Проблема:** если миграция структурно сломана (как 0014 в v1.31.1), self-heal **не помогает никогда** — он бесконечно репродуцирует ту же ошибку. И при этом теряет данные (старая БД с 30 MB данных переименована в `corrupted-*` и больше не используется).

**Что нужно:**
- Если миграция упала на свежей (только что созданной) пустой БД — это **fatal**, не повторять.
- Логировать `which migration failed` и сравнивать с предыдущей попыткой.
- Если две попытки подряд упали на одной и той же миграции — переключаться в **emergency mode**:
  - Не пересоздавать БД.
  - Не терять данные — оставить старую `.sqlite` как есть.
  - Показать UI «Ошибка БД: миграция X. Скачайте свежий релиз вручную или свяжитесь с админом», с кнопкой «Открыть `/updates/status`».
  - Альтернатива: попробовать скачать installer свежей версии через `/updates/status` и запустить его сразу — без участия пользователя. Это и есть «само-восстановление».

### F2. Installer integrity sha256 mismatch — постоянное полное перекачивание

В логе **каждой** версии (1.24.0, 1.31.1) виден pattern:
```
pending-update saved version=X.Y.Z installer=… size=89503354
installer integrity failed before launch: installer sha256 mismatch
installer integrity repair: resume download start (yandex.disk URL)
installer integrity failed after resume: installer sha256 mismatch
installer integrity repair: full re-download start (yandex.disk URL)
update-helper spawn version=X.Y.Z installer=…
```

Initial integrity check **никогда не проходит** → resume **никогда не проходит** → full re-download. Это означает:
- **Каждое обновление качается 2 раза** (resume бесполезен).
- Полоса пропускания клиента / прод-сервера / Yandex.Disk тратится впустую.
- Время обновления для пользователя удлиняется в ~2 раза.

**Что нужно:**
- Понять, почему initial sha256 не совпадает. Скорее всего хеш считается **не по тому, что лежит в файле** — может быть кейс с downloaded-частично+резюм, либо неправильный expected hash в `latest.yml`.
- Если expected hash в `latest.yml` действительно соответствует целому файлу, а после download размер совпадает (`size=89503354` всегда совпадает) — значит **файл целый, но хеш не сходится**. Возможно используется blockmap-hash, а не file-hash, и check считает file-hash.
- Если integrity check бесполезен — отключить его до выяснения, либо заменить на простой size+last-byte check.

### F3. Загрузка идёт через Yandex.Disk, а не прод-сервер

В `installer integrity repair: resume download start (https://downloader.disk.yandex.ru/disk/...)` — Yandex.Disk. При этом на прод-сервере (`/updates/status`) у нас лежит installer (`MatricaRMZ-Setup-1.31.2.exe`, 89505975 байт) и `infoHash` для торрент-раздачи (`d371b62f...`).

Получается **три параллельных канала доставки installer'а**:
1. Прямая загрузка с прод-сервера (через `/updates/status` → file path).
2. Торрент (через `infoHash` + trackers).
3. **Yandex.Disk** (по hardcoded URL'ам в логе).

Третий канал странный — почему он есть? Возможно legacy fallback. Стоит выяснить:
- Грепнуть по `disk.yandex.ru` в `electron-app/src/main/`.
- Если это legacy — выкинуть. Один канал доставки (или два — прод-сервер + торрент как fallback) проще для отладки.

### F4. Кириллица в логах сломана (UTF-8 → win1251 mojibake)

```
sqlite init failed: DrizzleError: Failed to run the query '-- Phase 2.4 PR 3 вЂ" SQLite РєР»РёРµРЅС‚: РґСЂРѕРїР°РµРј legacy ...
```

Это UTF-8 байты, прочитанные/записанные как Windows-1251. Скорее всего комментарий в SQL-файле в UTF-8, при ошибке Drizzle конкатенирует в текст ошибки, лог-форматтер пишет в stream который Windows-консоль интерпретирует как win1251.

**Что нужно:**
- Явно открывать log file со `encoding: 'utf8'` в Node.js.
- Возможно убрать кириллические комментарии из SQL миграций (они не несут ценности в production traces).

### F5. ERR_FAILED при загрузке update.html

```
update-ui loadFile error: Error: ERR_FAILED (-2) loading 'file:///.../resources/app.asar/dist/renderer/update.html'
```

Видно после каждой установки нового релиза, когда update-helper показывает progress UI. Возможно `update.html` не упакован в asar для финального production билда, или путь неверный.

**Что нужно:**
- Проверить `electron-vite.config.ts` / `package.json` build config — попадает ли `update.html` в `dist/renderer/`.
- Если нет — добавить в build inputs.

### F6. update-helper flow с magic `sleep 1s` и shell-open

```
update-helper waiting for parent pid=7360
update-helper parent exited after 0s
update-helper launching installer (detached)
update-helper launch attempt=helper-try-1
installer launch scheduled in 1s (initial)
installer launch strategy=shell-open path=…
installer launched via shell-open (initial)
```

Шаблон с `setTimeout 1000ms` перед `shell.openPath` — workaround для какого-то race condition (видимо PID parent ещё не освободил файл). Это hack, не root cause. Стоит проследить.

### F7. Sync пишет `/diagnostics/consistency/report` на каждом sync.run

```
sync push attempt=ok status=200 durMs=265 url=…/diagnostics/consistency/report
```

Эта телеметрия идёт **на каждый sync.run** — не только при сбое. Создаёт лишнюю нагрузку на прод. Стоит подумать: реально ли нужен report каждый цикл, или достаточно при ошибках / раз в час.

### F8. Pending-update logic

```
pending-update saved version=1.31.1 ...
pending-update ignored: version=1.31.1 current=1.31.2
```

Логика «если pending версия ≤ current — игнорировать» работает корректно. Но pending-файл (`updates/pending-update.json`) не очищается даже после установки → старый pending болтается. Стоит явно `unlink()` после успешной установки.

## План реализации (черновой, на согласование)

Размер большой — точно не один PR. Декомпозиция:

1. **PR 1: self-heal не зацикливается (P0)** — F1.
   - Детект «двойного фейла на одной миграции».
   - Emergency-mode UI с инструкцией ручной установки + кнопкой «открыть страницу обновлений».
   - Лучший вариант: при emergency автоматически попытаться скачать `latest` с прод-сервера и запустить installer (само-восстановление).
   - Unit-тесты: симуляция «миграция X всегда падает» → emergency mode после 2 попыток.

2. **PR 2: integrity check починить или выключить (P1)** — F2.
   - Воспроизвести локально: запустить v1.31.x autoupdater, проверить какой хеш он считает и какой ждёт.
   - Если expected hash битый — починить генерацию `latest.yml`.
   - Если check бесполезен — заменить на size-only или выключить.

3. **PR 3: единый канал доставки installer'а (P1)** — F3.
   - Грепнуть и выкинуть Yandex.Disk URLs.
   - Оставить **только** прод-сервер (через `/updates/status`) + торрент как fallback.

4. **PR 4: encoding/logging fixes (P2)** — F4, F5.
   - Лог в UTF-8.
   - `update.html` в build inputs.

5. **PR 5: cleanup (P3)** — F6, F7, F8.
   - Убрать magic sleep если возможно.
   - Сократить частоту `/diagnostics/consistency/report`.
   - Cleanup pending-update.json после установки.

## Критерий «готово»

- При **полностью сломанной миграции** (специальный test-fixture) клиент не зацикливается, а уходит в emergency mode с понятным UI и **самостоятельно** пытается скачать свежий installer.
- Каждое обновление качается **ровно 1 раз** (integrity passes).
- Yandex.Disk вырезан из кода.
- Лог в UTF-8.
- `update.html` загружается без ошибок.
- E2E test: симулируем «версия X сломана, версия X+1 чинит» — autoupdater сам восстанавливает работу без участия пользователя.

## Не делаем в этой нитке

- Не меняем cross-version migrations strategy (Drizzle).
- Не трогаем sync protocol версионирование.
- Не пересматриваем torrent-tracker архитектуру.

## Сопровождающие материалы

- Логи инцидента 2026-05-27 сохранены локально пользователя:
  - `%APPDATA%\@matricarmz\electron-app\matricarmz-updater.log`
  - `%APPDATA%\@matricarmz\electron-app\matricarmz.log`
  - `%APPDATA%\@matricarmz\electron-app\matricarmz.sqlite.corrupted-2026-05-27T17-37-14-493Z` (30 MB pre-migration DB).
  - `%APPDATA%\@matricarmz\electron-app\PRE-MIGRATION-BACKUP-2026-05-27.sqlite` (та же копия, переименованная — long-term safe).
- При работе над PR 1 — взять `corrupted-2026-05-27T17-37-14-493Z` как fixture для теста миграции 0014.
