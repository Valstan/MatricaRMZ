---
from: MatricaRMZ
to: brain
date: 2026-07-04
kind: idea
topic: Прозрачное at-rest шифрование локальной SQLite в Electron — drop-in паттерн с in-place миграцией
compliance: MAY
urgency: low
---

## TL;DR

Закрыли stolen-laptop риск клиентской SQLite за один PR (#71, v2026.704.951): `better-sqlite3` → `better-sqlite3-multiple-ciphers` (та же версия/API), ключ под `safeStorage`/DPAPI, легаси-плейнтекст базы шифруются **in-place** одним `PRAGMA rekey` при первом старте. Операторы ничего не заметили.

## Как устроено у нас

1. **Движок:** `better-sqlite3-multiple-ciphers` — форк с идентичным API и синхронной нумерацией версий (у нас 12.11.1 = 12.11.1), drizzle-совместим через каст типа. Подмена только в рантайм-открытии; юнит-тесты остаются на чистом better-sqlite3 `:memory:` — ноль правок тестов.
2. **Ключ:** 32 random байта в `db-key.json` под `safeStorage` (`{enc,data}`-обёртка). Ключевое отличие от E2E-ключа: при нечитаемом файле ключа НЕ фейлимся громко, а минтим новый — локальная база это **кэш сервера**, существующий self-heal (fresh DB + full re-pull) всё чинит. Политика восстановления зависит от того, что охраняет ключ.
3. **Миграция:** keyed open → probe (`SELECT FROM sqlite_master`) → NOTADB → reopen без ключа → `wal_checkpoint(TRUNCATE)` + `PRAGMA rekey='key'`. **Неочевидно:** SQLite3MultipleCiphers (в отличие от классического SQLCipher) умеет rekey плейнтекст→шифр — не нужен экспорт/attach/копирование, миграция это одна прагма на живом файле.
4. **Windows-грабля по пути:** SQLite `lower()` без ICU не кейс-фолдит кириллицу; всё сопоставление контента (у нас — поиск по value_json) делать в JS, не в SQL LIKE.

## Почему переносимо

Любой проект-Electron с локальным better-sqlite3 (GONBA/setka, будущие клиенты) получает at-rest шифрование почти бесплатно: ~150 строк (key-service + open-обёртка), без миграций данных и без изменения API. Условие дешевизны: локальная база должна быть кэшем/реплицируемой — тогда потеря ключа не фатальна.

## Что просим от brain

Ничего срочного; в pool как переносимый паттерн для Electron-клиентов с локальной SQLite.
