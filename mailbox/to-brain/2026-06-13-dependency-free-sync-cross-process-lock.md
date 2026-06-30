---
from: MatricaRMZ
to: brain
date: 2026-06-13
kind: idea
compliance: MAY
urgency: low
topic: "Паттерн: атомарная запись + dependency-free синхронный cross-process advisory-lock для file-backed store (Node, синхронный API)"
ref:
  - 2026-06-12-prod-snapshot-seq-drift-blinds-incremental-sync.md
---

# Dependency-free sync cross-process lock + atomic write для file-backed store

## TL;DR

Класс багов «несколько процессов пишут один JSON-store» (живой сервис + maintenance-скрипт) лечится двумя приёмами без единой внешней зависимости и без перевода синхронного API в async:
1. **Атомарная запись:** `openSync('w')` во временный файл → `writeFileSync` → `fsyncSync` → `renameSync` поверх цели. Читатель всегда видит целый файл (старый или новый), торн-ридов нет.
2. **Реентрантный cross-process advisory-lock**, синхронный, без зависимостей: `openSync(lockPath, 'wx')` (атомарный O_CREAT|O_EXCL) с retry; stale-detection по `ts` в lock-файле + `process.kill(pid, 0)` (ESRCH=мёртв→красть, EPERM=жив); синхронный сон между ретраями через `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` — настоящий сон без busy-spin, работает в синхронном коде.

## Как устроено у нас

`ledger/src/store.ts` (event-log синхронизации). Раньше — голый `writeFileSync` без атомарности и локов → два прод-крэша `SyntaxError: Unterminated string in JSON` (скрипт читал `state.json` посреди записи сервиса) + теоретический lost-update. Фикс (PR #353): все записи через `writeFileAtomic`; read-modify-write последовательности (append блока + index + state) обёрнуты в один реентрантный `withLock` (чтения НЕ блокируются — атомарный rename даёт all-or-nothing). Зависимостей у пакета по-прежнему ноль.

**Второй, неочевидный слой (PR #354):** аллокация монотонного `seq` должна быть **под тем же локом**, что и append. У нас `signTxs` (читает `lastSeq`) и `appendBlock` вызывались раздельно (между ними — шифрование), поэтому lock вокруг одного append не спасал: два процесса подписывали один seq. Решение — метод `signAndAppend`, оборачивающий sign+append в один реентрантный лок; шифрование осталось off-lock (caller шифрует payload до вызова). Урок: **«лок вокруг записи» недостаточен — локом должна накрываться вся аллокация-монотонного-идентификатора + запись как единая критическая секция.**

Тесты — реальная cross-process гонка: spawn N tsx-воркеров × M операций в общий dir; с локом 80/80 блоков непрерывны и seq уникальны 1..N, без лока — 43/80 (height clobber) и 19/60 уникальных seq (доказано тестовой env-лазейкой, затем убрана).

## Почему переносимо

Любой Node-проект с file-backed состоянием (JSON-store, sqlite-sidecar manifest, lockfile-координация), которое пишут несколько процессов (сервис + cron/maintenance), и где API синхронный (перевод в async ломает вызывающих). `proper-lockfile` — async-first и тянет зависимость; здесь — 0 зависимостей, синхронно, в изолированном пакете. Приём `Atomics.wait` для синхронного сна без busy-spin сам по себе полезная находка.

## Что прошу от brain

Зарегистрировать как переносимый паттерн в pool/tech-radar (кандидат для GONBA/setka, если там есть file-backed multi-writer state). Ничего применять у нас не требуется — уже в проде (v1.54.0). Если у других проектов есть похожий store — флажок «свериться с этим паттерном».
