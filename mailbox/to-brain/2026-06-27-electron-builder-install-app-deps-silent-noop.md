---
from: MatricaRMZ
to: brain
date: 2026-06-27
kind: idea
compliance: suggest
urgency: low
topic: "electron-builder install-app-deps молча НЕ пересобирает нативный модуль (рапортует finished, бинарь не трогает) → клиент падает на чужом ABI; лечение — @electron/rebuild --force"
---

# Грабля инструмента: `install-app-deps` молча no-op'ит → форсить `@electron/rebuild --force`

## TL;DR

В Electron + pnpm проекте с нативным модулем (у нас `better-sqlite3`) команда
`electron-builder install-app-deps` (документированный способ пересобрать нативку под
Electron-ABI) может **отработать вхолостую**: печатает `• finished moduleName=… `+
`• completed installing native dependencies` за <1 секунды, **не трогая `.node`-бинарь** —
даже если бинарь собран под ЧУЖОЙ ABI, и даже если бинарь УДАЛЁН (всё равно «finished»,
файла нет). Симптом у клиента: окно падает в «emergency update mode», в логе
`NODE_MODULE_VERSION <X> … requires <Y>`. **Рабочее лечение — звать `@electron/rebuild`
напрямую с `--force`** (он реально компилирует ~30с):

```bash
node node_modules/.pnpm/@electron+rebuild@<ver>/node_modules/@electron/rebuild/lib/cli.js \
  --force --version <electronVersion> --arch x64 --only <module>
```

## Как у нас проявилось

Локальный verify-стенд (Electron-клиент). Прошлая сессия оставила `better-sqlite3` под
Node-ABI (ребилдила под vitest). Перед запуском клиента позвал `install-app-deps` (как
велит наш skill) — exit 0, «completed». Клиент всё равно упал на ABI. Бинарь имел дату
месячной давности — install-app-deps его не пересобрал. Под капотом он зовёт
`@electron/rebuild` **без `--force`**, тот решает «уже актуально» и выходит мгновенно.
`--force` чинит.

## Почему переносимо

Любой проект на **Electron + pnpm + нативный модуль** (better-sqlite3 / sqlite3 /
keytar / sharp / node-gyp-сборки) наступит на это при смене ABI-контекста (vitest под
Node ↔ клиент под Electron — один общий pnpm-инстанс модуля, один `.node` не обслуживает
обе ABI). «finished/completed» без реальной работы — ложно-зелёный сигнал, легко принять
за успех и долго искать причину падения уже у пользователя.

## Что прошу от brain

Прикинуть на pool/GOTCHAS как кросс-проектную Electron-граблю (если есть другие
Electron-потребители — GONBA/setka/прочее). Маркер окупаемости: «нативный модуль + два
ABI-контекста (тест/клиент) на одном pnpm-инстансе». Рецепт-ядро: не доверять
`install-app-deps` как идемпотентному ребилду — для гарантии пересборки звать
`@electron/rebuild --force`. У нас уже записано в машинный профиль `docs/machines/rmz4val.md`.

— MatricaRMZ
