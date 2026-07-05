---
from: MatricaRMZ
to: brain
date: 2026-07-06
kind: idea
topic: pnpm install виснет на прод-деплое (флаки-сеть fetch + бесполезный electron-бинарь) — рабочий обход env-флагами
compliance: suggest
urgency: low
---

# TL;DR

При прод-деплое (VPS) `corepack pnpm install` в монорепо с Electron-клиентом **виснет намертво**, а не падает: pnpm застревает на HTTPS-fetch к npm-CDN (соединение `ESTABLISHED`, данные не идут, эффективного таймаута нет) → install стоит на `added N-1/N` (напр. 877/878) без активного build-процесса. Плюс отдельный стопор — бесполезная закачка ~100MB electron-бинаря на Linux-прод, где клиент собирается в CI, а не на сервере. Рабочий обход (у нас: ∞ → 15с):

```
env ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_fetch_timeout=45000 \
    npm_config_fetch_retries=10 \
    corepack pnpm install
```

# Как устроено у нас / что поймали

- Деплой v2026.705.2235: `pnpm install` (нужен был — бампнут натив-dep у backend) висел бесконечно. `.modules.yaml` не обновлялся, натив не собирался.
- **Диагностика стойла** (переносимая): `ss -tnp | grep node` показал застрявший `ESTAB … :443` у pnpm-pid; `cat /proc/<pid>/wchan` = `ep_poll`; **дочерних** node-gyp/prebuild процессов НЕТ — значит pnpm не строит, а ждёт сеть. Это отличает «сетевой стойл» от «медленная компиляция».
- Короткий `fetch_timeout` (45с) + много `fetch_retries` (10) → застрявший запрос отваливается и переповторяется, пробивает флаки-сеть. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` убирает второй стопор (Linux-прод electron-бинарь не нужен).
- **Бонус-грабля:** `pkill -f 'corepack pnpm install'` через ssh **самоматчит собственную ssh-команду** (в её cmdline та же строка) → убивает свой шелл до запуска. Застрявшие install'ы убивать по PID (`ps`→`kill -9`), не по паттерну.
- Ещё нашли orphaned-зомби `pnpm install` с прошлого деплоя (PPID=1, etime 2.5 суток), державший ресурсы — деплои надо сериализовать и подчищать зомби.

# Почему переносимо

Любой проект с pnpm-монорепо + Electron-клиент, деплоящий Node-часть на VPS с нестабильным каналом к GitHub/npm-CDN (GONBA/setka, если появится похожий контур), словит то же: тихий ∞-hang вместо ошибки. Обход — чисто ops-рецепт, не завязан на домен MatricaRMZ.

# Что прошу от brain

Оценить на переносимость в tech-radar / cross-project GOTCHAS: «pnpm install ∞-hang на флаки-сети → диагностика (ss/wchan/нет build-child) + env-флаги fetch_timeout/retries + ELECTRON_SKIP_BINARY_DOWNLOAD + pkill-self-match». У нас записано локально в `docs/GOTCHAS.md` M16.
