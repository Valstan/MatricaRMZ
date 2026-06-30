# Delta-обновления (ADR-0001 Этап-2, Путь B)

> **Статус:** 📋 план на согласовании. Создан 2026-06-15 (Claude Opus 4.8).
> **Боль владельца:** каждое обновление качает полный installer ~85 МиБ. Цель — единицы МБ.
> **Связано:** ADR-0001 client-install-update-architecture, `plans/refactor-updater-2026-05.md` (F-находки уже закрыты в v1.32.x).

## Ключевая находка (меняет масштаб задачи)

Delta **уже реализована и протестирована**, но в поле почти не срабатывает. Не нужно строить blockmap-diff с нуля — он есть:

- **Движок:** [`blockmapDelta.ts`](../../electron-app/src/main/services/blockmapDelta.ts) — `parseBlockmap`/`computeDeltaPlan`/`assembleFromPlan` (чистые функции, chunked copy ≤8 МБ, склейка смежных download-диапазонов). Покрыт `blockmapDelta.test.ts`.
- **Интеграция:** `tryServerDeltaDownload()` ([updateService.ts:2567](../../electron-app/src/main/services/updateService.ts)) — качает только изменившиеся блоки через HTTP `Range: bytes=` (206), собирает новый .exe из старого + диапазонов, проверяет целостность (`validateInstallerIntegrity`), гард `DELTA_MAX_DOWNLOAD_RATIO=0.8` (если diff >80% — не выгодно, откат на полную).
- **Топливо:** `cacheServerDeltaArtifacts()` (updateService.ts:2552) кэширует blockmap + sidecar `{version, sha256}` после server-закачки.

## Две дыры, из-за которых экономии нет

### Дыра 1 — delta стоит **последней** в каскаде (нога #6)

Порядок каскада (updateService.ts:1575–1755): ① torrent-local → ② LAN → ③ Yandex → ④ GitHub → ⑤ torrent-any → **⑥ server (единственная с delta)** → ⑦ ручной фолбэк. Ноги ①–⑤ качают **полный .exe**. Типичный онлайн/LAN-клиент скачивает полные 85 МиБ из ноги ① или ② и **до delta-ноги не доходит никогда**. Реализованная delta экономит трафик практически в нулевом числе случаев.

### Дыра 2 — топливо кэширует **только** server-нога

`cacheServerDeltaArtifacts` (blockmap + sidecar) вызывается только в `downloadUpdateFromServer` (нога ⑥). Ноги ①–⑤ зовут лишь `cacheInstaller` (копия .exe), но **не кэшируют blockmap + sidecar**. Клиент, обновившийся через LAN/torrent/Yandex/GitHub, остаётся без топлива → следующее обновление снова полное. Delta-топливо есть только у тех, кто случайно обновился через server-ногу.

## Решение владельца: источник диапазонов для delta-first

Когда delta станет первой попыткой — откуда тянуть изменившиеся блоки? Это компромисс WAN↔LAN (завод — много машин в LAN):

- **Server-only (просто):** delta-first зовёт server (WAN). Машина тянет единицы МБ с прод-сервера. Минус: ×N машин по WAN (сейчас LAN-first полный = 85 МиБ×1 сид + LAN остальным щадит WAN).
- **LAN-peer-preferred (правильно, сложнее):** изменившиеся блоки тянутся `Range`-запросом у LAN-пира (у которого уже есть новый .exe), фолбэк на server. Сохраняет и delta-выигрыш, и LAN-локальность. Требует поддержки 206 на peer-эндпойнте (тот же backend `/updates/file/:name` — поддерживает).

Рекомендация: начать с **server-only** в PR-2 (высокая ценность, низкий риск), добавить LAN-peer ranges отдельным PR-3 как локальную оптимизацию. Единицы МБ × N по WAN всё равно несравнимо лучше 85 МиБ. Но если завод чувствителен к WAN — можно сразу целиться в LAN-peer-preferred.

## Декомпозиция (критичный файл авто-апдейтера — каждый PR отдельно-релизный и обратимый)

### PR-0 — Верификация существующей server-delta (до правок каскада) ✅ ЗАВЕРШЕНО 2026-06-15
**Реальный замер на двух выпущенных соседних релизах** (v2026.615.108 → v2026.615.1201, blockmap'ы из GitHub Releases, прогон через продакшн-движок `parseBlockmap`+`computeDeltaPlan`):
- Полный installer: **109.67 МиБ**; delta-загрузка: **8.78 МиБ (8.0%)**; переиспользовано из старого: 100.90 МиБ (5044 copy-ops vs 11 download-ops). Гард 0.8 **PASS**.
- **Вывод: экономия ~92%.** Blockmap'ы наших CI-сборок блок-стабильны (опасение F2 о недетерминизме electron-builder для blockmap-delta не подтвердилось — diff локализован в изменившихся блоках). Движок рабочий и оправдан — кода в PR-0 не потребовалось (движок уже верен; `blockmapDelta.test.ts` покрывает parse/plan/byte-exact-assembly/short-range-fail).
- Рецепт повтора замера: `gh release download <tagA|tagB> --pattern "*.blockmap"`, прогнать через `computeDeltaPlan` (probe git-ignored, не коммитится).

**PR-0 follow-up (2026-06-15) — замер стал committed-инструментом + числа по всем соседним релизам.** Ad-hoc probe PR-0 не коммитился; теперь логика отчёта — чистые тестируемые функции движка (`summarizeDeltaPlan`/`formatDeltaReport`/`measureBlockmapDelta` + единый порог `DELTA_DEFAULT_MAX_DOWNLOAD_RATIO=0.8`, [`blockmapDelta.ts`](../../electron-app/src/main/services/blockmapDelta.ts)), а сам замер — opt-in skip-gated харнес [`blockmapDelta.measure.test.ts`](../../electron-app/src/main/services/blockmapDelta.measure.test.ts) (выложить `.blockmap` в `electron-app/.delta-blockmaps/` git-ignored → `pnpm -F @matricarmz/electron-app test blockmapDelta.measure`). Live-апдейтер теперь потребляет тот же helper для worth-it-гарда и лога (поведение гарда то же, лог обогащён `% reused`). Замер тем же движком на всех соседних прод-релизах:

| Пара | Полный | Delta | Экономия | worth-it |
|---|---|---|---|---|
| 108 → 1201 | 109.67 МиБ | 8.78 МиБ | 92.0% | yes |
| 1201 → 1417 | 109.68 МиБ | 8.83 МиБ | 91.9% | yes |
| 1417 → 1517 | 109.68 МиБ | 8.84 МиБ | 91.9% | yes |

108→1201 совпал с числами PR-0 байт-в-байт (helper == продакшн-движок). 1417→1517 — пара, через которую реально обновлялись клиенты: потенциал ~92%. «Сколько сэкономила delta в поле» по-прежнему клиент-лог-факт (`delta ok: …` в `matricarmz-updater.log`) — серверно не наблюдаемо.

### PR-1 — Топливо после **каждой** ноги (чистая добавка, порядок не меняется)
После любой успешной закачки (①–⑤, не только ⑥) кэшировать blockmap + sidecar. `cacheServerDeltaArtifacts` нужен лишь `serverMeta`+`apiBaseUrl` (есть в каскаде на всех ногах). Извлечь в leg-agnostic вызов после `cacheInstaller`. **Поведение загрузки не меняется** — только заполняется топливо. Один релиз «прогрева»: после него у всех клиентов появляется топливо для следующего обновления. Нулевой регресс.

### PR-2 — Delta-first попытка (выигрыш трафика) — код готов, PR [#403](https://github.com/Valstan/MatricaRMZ/pull/403)
Добавлена delta-попытка **в начало** каскада (шаг #0, перед ногой ①), гейт — наличие топлива. Источник — **server-only** (решение владельца; LAN-peer = PR-3). **Любой промах/сбой → молчаливый проход в существующий каскад** (примитив `tryServerDeltaDownload` уже прод-обкатан в ноге ⑥). Состояние UI ставится только в `onProgress` (нет ложного мелькания при отсутствии топлива).

**Верификация на РЕАЛЬНЫХ данных (2026-06-15):**
- **Реконструкция byte-exact:** реальный v1201 installer полностью собран из реального v108 + 8.78 МиБ (8.0%) delta продакшн-движком (`parseBlockmap`+`computeDeltaPlan`+`assembleFromPlan`). `sha256(reconstructed) == sha256(v1201)` точно; `plan.totalSize == 115001216` (реальный размер v1201 → гард `totalSize!=meta.size` проходит); 11 range-fetch, 100.9 МиБ переиспользовано copy-операциями.
- **Backend Range:** `routes/updates.ts:/file/:name` (код) — `Accept-Ranges: bytes`, парс Range, ответ **206** + `Content-Range` + потоковый срез точных байтов, для `.exe` и `.blockmap`. Ровно то, что ждёт `downloadRange` (`res.status===206`).
- **Вывод:** весь delta-data-path проверен (план → byte-exact реконструкция → серверный Range 206 → integrity-гард по sha). Гейты: typecheck+lint зелёные.
- **Остаётся для полного GUI-e2e (опц., dedicated-сессия):** прогон через живой Electron-клиент (занизить версию → засеять топливо → триггер checkForUpdates → наблюдать UI-стадии). Не закрыто: verifier-electron не умеет update-flow + нет prod-schema dump-предусловий на этой машине. Тонкая обёртка (sha-guard/fetchServerBlockmap/queue/installNow) — прод-обкатанный glue; первый реальный CalVer delta-релиз = финальное живое доказательство.

### PR-3 — LAN-peer как источник Range-диапазонов ✅ ЗАВЕРШЕНО 2026-06-15
delta-first сперва ищет LAN-пир с целевой версией (`pickDeltaRangePeer` → `listLanPeers`) и тянет изменившиеся блоки у него (`tryServerDeltaDownload(..., { rangeBaseUrl: 'http://ip:port' })`); при любом сбое — фолбэк на server-delta, затем полный каскад. blockmap+meta всегда с сервера (пир раздаёт только `.exe`; клиентский `lanUpdateService` уже отвечает Range 206 — доработка сервера не понадобилась). Гард: при выключенном `MATRICA_UPDATE_LAN_ENABLED` пир не ищется → поведение = чистый server-delta (нулевой регресс). Лог `delta plan … source=lan-peer|server`. Гейты зелёные. Не релизился — поедет со следующим `/reliz`.

### PR-4 — Наблюдаемость delta в окне ✅ ЗАВЕРШЕНО 2026-06-15, PR [#408](https://github.com/Valstan/MatricaRMZ/pull/408)
**Найдена и закрыта дыра PR-2:** delta-first гнал прогресс только в легаси `setUpdateState`, богатое окно висело на «Проверка» во время delta-докачки. Теперь delta-first зовёт `setUpdateUi` как остальные ноги: `stage=downloading`, `transferredBytes/totalBytes` = **дельта** (не полный ~110 МиБ) → размер/бар/скорость про маленькую докачку; сообщение «Догружаем только изменения…». Новое поле `UpdateUiViewState.deltaFullBytes` → окно показывает бейдж «Лёгкое обновление — загрузка только изменений: ~N МБ вместо ~M МБ» (только в delta-режиме, гард по stage+наличию). Dev-sim переведён на delta (`MATRICA_SIMULATE_UPDATE=happy` = 9 vs 110 МБ). Лог hit/miss уже был в `tryServerDeltaDownload` (`delta ok: downloaded Xb instead of Yb`). Мокап одобрен владельцем. Гейты зелёные. **Серверная телеметрия (диагностика/крит-событие delta-hit) — НЕ делалась** (намеренно: поле подтвердится клиент-логом + видимым бейджем; добавить отдельным мелким PR, если понадобится агрегат).
**Сопутствующий фикс (из фидбэка владельца):** мельтешение скорости/ETA в окне — скорость теперь средняя за окно ~1с + EMA, прогресс-пуши коалесцируются до окна (PR [#407](https://github.com/Valstan/MatricaRMZ/pull/407), `setUpdateUi`).

### PR-5 — Delta-first в foreground `runAutoUpdateFlow` ✅ ЗАВЕРШЕНО 2026-06-17 (owner-batch-2 #3)
**Остаточная дыра, обнаруженная после архивации плана:** PR-2/PR-3 приземлили delta-first только в **background-поллер** (`startBackgroundUpdatePolling.tick`), а на старте **первым** синхронно выполняется **foreground** `runAutoUpdateFlow({reason:'startup'})` ([index.ts:437](../../../electron-app/src/main/index.ts)) → нашёл апдейт → `app.quit()` **раньше** поллера. У foreground delta-first не было → типичный клиент качал полный installer (~110 МиБ) через ногу LAN/torrent и выходил; реализованная delta в поле почти не срабатывала. Вторая дыра: foreground-ноги (torrent-local/LAN/torrent-any) не звали `cacheDeltaFuel` → топливо для следующей дельты не копилось (server-нога кэширует сама внутри `downloadUpdateFromServer`).
**Фикс (зеркало background, аддитивно):** (1) шаг 0 delta-first в `runAutoUpdateFlow` перед ногой 1 — LAN-peer ranges → фолбэк server-delta → при `ok`: queue + `cacheDeltaFuel` + `installNow`; (2) `cacheDeltaFuel(serverMeta)` перед `installNow` на ногах torrent-local/LAN/torrent-any. **Уточнение vs background:** дешёвый гард `readCachedInstallerSidecar()` ПЕРЕД LAN-discovery — на свежем клиенте без топлива не добавляем сетевой вызов в каждый старт (в background задержка неважна, в foreground — критична). Любой промах delta → молча в полный каскад (нулевой регресс). Гейты: typecheck · lint · blockmapDelta 15/15 · backend 261/261 — зелёные. **Верификация:** GUI-e2e delta-флоу локально невозможен (verifier-electron не умеет update-flow) — доказательство = код-ревью + гейты + byte-exact-замеры движка (PR-0/PR-2); финальное живое подтверждение = первый CalVer delta-релиз после раската этого фикса.

## Критерий «готово»
- Клиент на vN с накопленным топливом, обновляясь до vN+1, качает **≪ 85 МиБ** (единицы МБ), .exe собирается корректно, integrity проходит.
- При отсутствии топлива / любом сбое delta — каскад работает ровно как сейчас (нулевой регресс).
- В поле подтверждены сэкономленные байты (телеметрия/лог).

## Вне scope
- Стратегия cross-version миграций (Drizzle), версионирование sync-протокола.
- Архитектура torrent-tracker, переход на electron-updater.
- F-находки `refactor-updater-2026-05.md` (уже закрыты в v1.32.x).
