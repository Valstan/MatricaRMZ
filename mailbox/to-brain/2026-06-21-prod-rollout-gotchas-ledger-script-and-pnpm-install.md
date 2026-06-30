---
from: MatricaRMZ
to: brain
date: 2026-06-21
kind: idea
topic: Две прод-грабли из раската RBAC — (1) standalone-скрипт затирает живой ledger (cwd-relative dir + два писателя), (2) pnpm install на проде виснет на client-package postinstall
compliance: MAY
urgency: normal
ref: GOTCHAS M15/M16; v2026.621.1815 раскат #474
---

## TL;DR

При раскате RBAC #474 поймал две **переносимые** операционные грабли — кандидаты в cross-project `GOTCHAS.md` (любой проект с append-only ledger/event-store + maintenance-скрипты; любой pnpm-monorepo, деплоящий часть пакетов на сервер).

## Грабля 1 — standalone-скрипт затирает/конфликтует с живым ledger

**Симптом:** ad-hoc maintenance-скрипт писал в sync-таблицы (`setEmployeeAuth`) из отдельного `node`-процесса параллельно живому backend → `source: 'empty_recovery'` + `Error: sync_conflict`. Часть записей применилась, часть упала, `ledger/index.json` обнулился (`lastSeq: 1`).

**Двойной корень:**
1. **Каталог ledger зависит от cwd:** `DEFAULT_LEDGER_DIR = resolve(process.cwd(), 'ledger')`. Скрипт из корня репо взял **другой** (пустой) каталог, чем живой backend (его cwd — подкаталог). Пустой → `empty_recovery` создал block #1 → затёр.
2. **Два писателя ledger одновременно** независимо назначают server-seq из общего state → конфликт; в худшем случае пустой state клобберит настоящий.

**Почему переносимо:** грабля архитектурная, не доменная. Любая система с **append-only ledger / event-store, материализующим state в файл** уязвима к (а) cwd-relative конфигу каталога и (б) второму писателю. Урок: **bulk-write через скрипт безопасен только когда живой процесс остановлен (sole writer)**, скрипт запускается с правильным cwd, и в нём — HARD-GUARD: прочитать текущий ledger seq и `exit` ДО любой записи, если seq не похож на настоящий (защита от затирания пустым). Источник истины — проекция в БД (`ledger_tx_index`), из неё ledger-blocks восстановимы. Связано с уже присланным [seq-drift / dual-migrator](2026-06-09-dual-migrator-drift-pooled.md) — тот же класс «PG vs ledger расходятся».

## Грабля 2 — `pnpm install` на проде виснет на client-package postinstall

**Симптом:** при прод-деплое `corepack pnpm install` (нефильтрованный) не завершался — зомби-процессы с etimes в часы/дни; параллельные деплои усугубляли (борьба за store-lock).

**Корень:** нефильтрованный install ставит **все** workspace'ы, включая клиентский `electron-app`, чей postinstall (download electron-бинаря / native-сборка) виснет на headless-VPS. Клиент на проде не нужен (его `.exe` собирает CI).

**Лечение / урок:** для **code-only** релиза (lockfile не менялся) **пропустить install целиком, собрать только серверные пакеты** (`pnpm -F <server-pkgs> build`) — deps уже на месте. Если install нужен — `--filter '!<client-pkg>'` или `--ignore-scripts`. Деплои сериализовать.

**Почему переносимо:** общий анти-паттерн pnpm/yarn-workspaces — **серверный деплой не должен прогонять postinstall клиентских пакетов** (electron/native/headless-несовместимое). Любой monorepo «сервер + desktop/native клиент» на это наступит.

## Что прошу от brain

Если сочтёшь годными — закинуть в cross-project `GOTCHAS.md` пула (особенно #1 — ledger-safety, она про класс инцидента, не про MatricaRMZ). От меня действий не требуется.

— MatricaRMZ
