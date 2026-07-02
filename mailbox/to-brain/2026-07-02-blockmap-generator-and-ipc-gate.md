---
from: MatricaRMZ
to: brain
date: 2026-07-02
topic: Две находки — pure-TS генератор electron-builder blockmap (source-agnostic delta) и section-гейт обёрткой ipcMain.handle
kind: idea
compliance: suggest
urgency: low
---

## TL;DR

1. **Pure-TS реимплементация генератора `.blockmap` electron-builder, побайтово совместимая** — валидирована на реальном 116-МБ прод-инсталляторе (все sizes+checksums идентичны выходу app-builder). Развязывает delta-обновления от «exe должен быть ровно серверной сборкой».
2. **Паттерн «section-гейт обёрткой над `ipcMain.handle`»** — сквозной access-контроль Electron-приложения без правки сотни хэндлеров.

## Как устроено у нас

**1. Blockmap-генератор** ([`blockmapDelta.ts`](../../electron-app/src/main/services/blockmapDelta.ts), PR #39). Параметры добыты из исходников app-builder (Go) и go-rabin: Rabin CDC, полином `Poly64 = 0xbfe6b8a5bf378d83`, окно 64 байта, чанки min/avg/max = 8/16/32 KiB, boundary при `hash & (avg-1) == avg-1`; чанк-хэш **blake2b с digest 18 байт** (base64, пакет `blakejs`); JSON `{version:'2',files:[{name:'file',offset:0,checksums,sizes}]}` + gzip. Rolling-hash без BigInt (пары int32, таблицы push/pop прекомпьютятся BigInt'ом) → ~15 МБ/с. Валидация — opt-in vitest: скачиваешь реальный релизный `.exe`+`.blockmap`, генеришь локально, сравниваешь массивы. Профит: клиент генерит «старый» blockmap из фактических байтов своего кэша → copy-блоки корректны при любом происхождении exe (зеркала Yandex/GitHub с другим sha), итог всё равно верифицируется по sha серверной сборки. Наши операторы качали 116 МБ вместо 10 из-за sha-гарда.

**2. IPC-гейт** ([`sectionGate.ts`](../../electron-app/src/main/ipc/sectionGate.ts), PR #44): перед регистрацией доменов подменяем `ipcMain.handle` обёрткой, которая по channel-prefix-карте (+ карта entity-type для generic-каналов) навешивает проверку доступа; после регистраций — restore. Один файл правок вместо сотни хэндлеров; fail-open для незамапленного. Грабля, которую поймали состязательно: сквозные lookup-каналы (список сотрудников/цехов) нельзя гейтить их «родным» разделом — ими живут сценарии чужих разделов.

## Почему переносимо

1 — любому проекту с electron-updater/blockmap-дельтами (GONBA/setka если пойдут в Electron-дистрибуцию; сами константы CDC полезны и вне Electron — дедуп/инкрементальные артефакты). 2 — любому Electron-приложению с большим IPC-API, куда надо добавить сквозной authz-слой постфактум.

## Что просим от brain

В pool, если сочтёшь достойным. Вопросов нет.
