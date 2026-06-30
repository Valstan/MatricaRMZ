# Blockmap-delta обновления клиента (ADR-0001 Этап-2, Путь B)

Источник: [ADR-0001](../adr/0001-client-install-update-architecture.md) Блок 3 + директива brain `client-perf-initial-sync-and-delta-updates` (боль владельца: ~85 МиБ на каждое обновление). Цель: типовой релиз (меняется наш JS/asar) → закачка единицы МБ; Electron-блоки не качаются, пока не меняются.

## Контекст (разведка 2026-06-12)

- `.blockmap` (gzip-JSON: `{version, files:[{name, offset, checksums[], sizes[]}]}`) генерируется electron-builder, публикуется в GitHub Release и **уже скачивается на прод** в `/opt/matricarmz/updates/` (шаг 7 релиз-процесса). Клиент его игнорирует.
- Клиент кэширует последний скачанный installer в `getStableInstallerPath()` (`matrica_rmz_update.exe`) — старые блоки доступны локально. Версия — в `pending-update.json`, но обнуляется после установки → нужен свой sidecar-метафайл.
- Сервер `/updates/file/:name` отдаёт только текущий installer через `res.download()` — **без HTTP Range (206)**. LAN-сервер (`lanUpdateService.ts:142`) Range уже умеет — образец.
- `latest-meta` = `{version, fileName, size, sha256}` — blockmap не упоминается.
- Каскад: LAN-пиры → LAN HTTP → Yandex → GitHub → torrent+webseed → сервер.

## Фаза 1 — delta по server-leg (эта нитка) ✅ критерии в конце

1. **Сервер**: `/updates/file/:name` — ручной Range-парс + `206 Partial Content` (`createReadStream(start,end)`, образец LAN); валидное имя — installer ИЛИ `<installer>.blockmap` (если лежит рядом). `latest-meta` + `blockmapFileName` (если файл есть).
2. **Клиент, новый модуль `blockmapDelta.ts`**: парс blockmap (gunzip+JSON, абсолютные offsets из sizes), `computeDeltaPlan(old,new)` (checksum-матчинг чанков → ops `copy`/`download`, коалесценция смежных download-диапазонов, статистика), `assembleInstaller` (копия блоков из старого exe + Range-загрузки → outPath).
3. **Клиент, интеграция в server-leg** (`downloadUpdateFromServer`): перед полной закачкой — `tryServerDeltaDownload`: есть кэш-пара (exe+blockmap+sidecar `{version,sha256}`) и `blockmapFileName` в meta → качаем новый blockmap → план → если download-доля > 80% или Range-проба не 206 → fallback на полный путь. Собранный файл проходит существующий `validateInstallerIntegrity` (sha256 полного файла) — любой сбой = rm + полный путь.
4. **Кэш blockmap**: `cacheInstaller()` дополнительно сохраняет `matrica_rmz_update.exe.blockmap` + sidecar `cached-installer.json` `{version, sha256}`. Перед delta кэш-exe сверяется по sha256 с sidecar (битый кэш → полный путь).
5. **Тесты**: unit (vitest, electron-app) на парс/план/сборку с синтетическими blockmap; ручная проверка Range через curl на локальном backend.

Безопасность отката: delta — строго opportunistic-ветка внутри server-leg; все ошибки глушатся в fallback на существующий полный механизм. Каскад/LAN/torrent не трогаем.

## Фаза 2 (потом, отдельно)

- Range-delta с LAN-пиров (их HTTP уже умеет 206) и Yandex/GitHub (S3/Яндекс умеют Range нативно).
- Селективные torrent-pieces.
- Метрика в `/updates/status` или client-лог: «delta X МБ вместо Y МБ» — снять цифру на первом реальном релизе.

## Статус

- [x] Фаза 1 ✅ #341 (2026-06-12) — Range на сервере + delta server-leg клиента; метрика «85 МиБ → X МБ» снимется на первом проде-релизе с кэшированной парой
- [ ] Фаза 2

### Проба метрики 2026-06-13 (не закрыта — нужна машина оператора)

v1.54.0 — первый delta-eligible релиз после v1.53.0. Прод-проба показала: delta **eligible** (в `/opt/matricarmz/updates/` лежат ОБА blockmap'а — `MatricaRMZ-Setup-1.53.0.exe.blockmap` И `…-1.54.0.exe.blockmap`). Клиенты (seen <3д): 1×1.54.0, 1×1.53.0, 2×1.50.0. **Но цифру «X МБ» с прода снять нельзя:** nginx access.log **не логирует** `/updates/`-трафик вообще; backend-журнал primary без delta/Range/206-следов; единственный клиент на 1.54.0 обновлялся **не через server-leg** (Range-запросов по 1.54-инсталлятору в логах нет → пошёл LAN/Yandex/GitHub-ногой каскада). Метрика `delta ok: downloaded X` живёт только в клиентском `%LOCALAPPDATA%\…\matricarmz.log` машины, делавшей 1.53→1.54. **Как закрыть:** взять этот лог с машины оператора (Блок-1 аудит раскладки, всё равно требует машину оператора), ИЛИ добавить server-side delta-телеметрию (логировать Range-байты по `/updates/file/:name` в backend) — тогда будущие server-leg delta станут измеримы с прода. До тех пор — «ждать поле».
