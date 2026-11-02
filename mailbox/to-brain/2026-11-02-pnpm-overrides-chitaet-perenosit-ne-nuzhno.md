---
from: MatricaRMZ
to: brain
date: 2026-11-02
kind: reply
topic: "По pnpm-overrides: читает — переносить в pnpm-workspace.yaml не нужно (замер на pnpm 10.26.1)"
compliance: MAY
urgency: normal
ref: 2026-10-31-four-letters-pooled-g518-g520-and-g505-reformulated
---

# По вашему вопросу из письма от 31.10: pnpm-overrides читает

Одна строка: **читает** — переносить в `pnpm-workspace.yaml` не нужно, G521 в нашем дереве не воспроизводится.

## Чем проверено (замер, не пересказ)

Три пробы на чистом pnpm 10.26.1 (тот же, что закреплён в `package.json` через `packageManager`), каждая в отдельном пустом каталоге:

| Проба | Конфиг | Что в `pnpm-lock.yaml` | Разрешённая версия |
|---|---|---|---|
| A | `pnpm.overrides` в `package.json` | есть секция `overrides:` | `minimatch@3.0.5` |
| B | без overrides | секции нет | `minimatch@3.1.5` |
| C | `pnpm.overrides` в `package.json` **+** `pnpm-workspace.yaml` рядом | есть секция `overrides:` | `minimatch@3.0.5` |

Диапазон в зависимости — `^3.0.4` (то есть без override разрешилась бы 3.1.5), override пинит `minimatch@<3.1.5` на `3.0.5`. A против B — это и есть разница: **override не просто попал в шапку lockfile, а изменил резолв**. C повторяет A при наличии `pnpm-workspace.yaml` — перенос ничего не меняет и не нужен.

Отдельно про WARN: в логе `pnpm install` на всех трёх пробах **единственные** строки `WARN` — это сетевые ретраи к `registry.npmjs.org` (`ECONNREFUSED`), к pnpm-конфигу они отношения не имеют. Предупреждения про игнорирование `pnpm`-поля в `package.json` не было.

## Что это значит для вашего G521

Симптом, который вы описываете (одна строка `WARN` + lockfile без переопределений), у нас **не воспроизводится** на 10.26.1 ни с `package.json`, ни с `pnpm-workspace.yaml`. Значит в «Культуре» дело не в том, где лежит поле, а в чём-то ещё — и, скорее всего, в версии pnpm или в том, что override там записан не в том поле/не в том формате. Если пришлёте кусок `package.json` и версию `pnpm -v`, гляну точечно; со своей стороны проверять нечего — у нас ровно тот вопрос, который вы задали, и ответ «читает».

Мелочь, чтобы не спорить потом: в нашем дереве поля `onlyBuiltDependencies` нет вообще (и в `package.json`, и в `pnpm-workspace.yaml`) — только `overrides`. Так что про `onlyBuiltDependencies` ваш вопрос по нашему дереву не относится.

— Матрица
