# Шифрование локальной клиентской SQLite (SQLCipher-класс) — 2026-07

**Задание владельца (2026-07-04):** закрыть последний крупный medium security-аудита — локальная база клиента (`%APPDATA%\@matricarmz\...\matricarmz.sqlite`) лежит плейнтекстом: украденный ноутбук = полная копия производственных данных.

## Решения

- **Движок:** `better-sqlite3-multiple-ciphers@12.11.1` (drop-in форк better-sqlite3 той же версии 12.11.1, SQLite3MultipleCiphers, дефолтный шифр ChaCha20-Poly1305, `PRAGMA key/rekey`, prebuilds под Electron). Подмена только в **рантайме клиента** (`db.ts`); юнит-тесты остаются на чистом better-sqlite3 `:memory:`.
- **Ключ:** 32 случайных байта, файл `db-key.json` в userData, обёртка `{enc,data}` через `safeStorage` — тот же паттерн, что E2E-ключ (#607, `e2eKeyService`). Ключ per-machine/per-user (DPAPI): база нечитаема с другого аккаунта/машины.
- **Миграция существующих баз:** при старте пробуем открыть с ключом; NOTADB → пробуем без ключа (легаси-плейнтекст) → `wal_checkpoint(TRUNCATE)` + `PRAGMA rekey` (in-place, SQLite3MC умеет плейнтекст→шифр). Прозрачно для оператора.
- **safeStorage недоступен** (нет OS-keyring): работаем плейнтекстом + громкая строка в лог (availability > шифрование на таких хостах; на Windows DPAPI есть всегда).
- **Ключ потерян / база нечитаема обоими путями:** существующий self-heal контур (rename `.corrupted-*` → свежая база → полный pull с сервера) — клиентская база это кэш, потеря локальной копии не теряет данные.
- **Плейнтекст-остатки:** `PRAGMA rekey` перешифровывает все страницы основного файла; WAL чекпойнтится до rekey. Старые `.corrupted-*` бэкапы прошлых лет остаются плейнтекстом — зачистка по желанию владельца отдельно (это аварийные копии).

## Точки кода

- `electron-app/src/main/database/db.ts` — `openSqlite`/`openSqliteReadonly` принимают ключ, «key → probe → legacy-rekey» логика.
- `electron-app/src/main/services/dbKeyService.ts` — новый (по образу `e2eKeyService`).
- `electron-app/src/main/index.ts` — прокинуть ключ в `openMigrateSeed`; self-heal не трогаем.
- `.npmrc` — `only-built-dependencies[]=better-sqlite3-multiple-ciphers`.

## Статус

- [x] Реализация + гейты (typecheck/lint, 193/193 electron-тестов)
- [x] Dev-stand verify 2026-07-04: легаси-плейнтекст база (1582 двигателя) зашифрована **in-place** rekey'ем — заголовок стал случайными байтами; функциональный smoke 7/7 (логин, списки, deep-поиск); рестарт открывает без self-heal; `db-key.json` создан
- [ ] Релиз (клиентская фича — едет инсталлером; CI соберёт better-sqlite3-multiple-ciphers как обычный native dep)

## Известные остатки (вне scope)

- Кэш-снапшоты серверных бэкапов (просмотрщик бэкапов) хранятся плейнтекстом — отдельный заход при желании.
- Старые `.corrupted-*` копии базы у операторов остаются плейнтекстом (аварийные бэкапы прошлых инцидентов).
