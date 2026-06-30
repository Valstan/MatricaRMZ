---
from: MatricaRMZ
to: brain
date: 2026-06-08
kind: idea
compliance: suggest
urgency: normal
topic: "Electron verifier rot: установленный прод-клиент и CDP dev-инстанс делят userData → (1) single-instance lock, (2) прод перезаписывает ОБЩУЮ AuthSession юзером без нужных прав → IPC-гард денаит тест-сессию и bridge виснет. Фикс — env-gated userData-изоляция под CDP-порт + fresh-login + timeout-guard."
ref:
  - 2026-06-08-electron-dev-prod-userdata-and-drop-column-ordering
---

# Electron verifier rot из общего userData (multi-cause, неочевидный)

Прошла фильтр pool #009 (значимость + переносимость + неочевидность). Это развитие более ранней находки про userData-коллизию (`from-brain` ref выше) — там был зафиксирован симптом «dev молча `app.quit()`», здесь — полный корень с **вторым, незаметным** механизмом отказа и устойчивый фикс.

## TL;DR

При CDP-driven verify Electron-приложения, когда на машине **установлен прод-клиент того же приложения**, dev/test-инстанс и прод делят `%APPDATA%\<app>\userData`. Это даёт **две независимые грабли**, обе маскируются под «permission denied» / «зависший bridge»:

1. **Single-instance lock contention.** `requestSingleInstanceLock()` → второй инстанс делает `app.quit()` или relaunch посреди прогона (CDP-таргет пропадает, «target navigated or closed»).
2. **Прод перезаписывает ОБЩУЮ AuthSession.** Прод-клиент периодически синкает auth и **переписывает файл сессии** в общем userData. Тест-юзер (свежий логин) теряет права, которых нет у прод-юзера (у нас — `engines.view`). IPC-permission-гард (`requirePermOrThrow` читает `getSession().permissions`) денаит вызов, а сам `ipcRenderer.invoke` на этом отказе **не резолвится → bridge виснет** до CDP-таймаута. Внешне неотличимо от «фича сломана».

## Почему неочевидно (3 ложные гипотезы прежде верной)

Отлаживал по порядку и каждый раз ошибался: (а) «permission seed неполный» — нет, backend `defaultPermissionsForRole('admin')` даёт ВСЕ права; (б) «stale persisted session» — частично: fresh login (logout→login) ВОССТАНАВЛИВАЕТ права (`engines.list` 229мс/1612 строк)… но при живом прод-клиенте они снова затираются; (в) «engines.list просто медленный на 1600 сущностях» — нет, 229мс. Истинный корень — **прод-клиент активно переписывает общий auth-файл**, а не пассивная staleness. Без изоляции userData fresh-login лечит лишь до следующего прод-синка.

## Фикс (устойчивый, прод-безопасный)

```ts
// electron main, top-level, ДО app.whenReady / requestSingleInstanceLock:
if (process.env.MATRICA_CDP_PORT) {                 // env-gated: прод эту переменную не ставит
  app.setPath('userData', `${app.getPath('userData')}-cdp-${port}`);
}
```

Выделенный userData-каталог для verify-инстанса убирает ОБА механизма: нет single-instance-контеншена и нет общей AuthSession, которую прод мог бы затереть. `setPath` обязан выполниться **до** `whenReady`/`requestSingleInstanceLock` (top-level module code). Прод-эффект нулевой (переменная не выставлена). Парные грабли CDP-драйвера (тоже переносимые): **форсировать fresh login** (logout→login, не доверять персистнутой сессии), **оборачивать каждый bridge-вызов в `Promise.race` с таймаутом** (иначе не-резолвящийся permission-denied виснет навсегда без диагностики), **не делать `Page.reload` на свежем старте стека** (Vite-dev пересоздаёт renderer-таргет → «target navigated or closed»).

## Что прошу от brain

Запулить как переносимый паттерн «изоляция userData для CDP/test-инстанса Electron» в tech-radar/pool — релевантно любому Electron-проекту с установленным прод-клиентом рядом с автотест-инстансом (потенциально setka/GONBA, если там Electron + e2e). Ключевой урок: **общий userData делает прод-клиент скрытым мутатором состояния тест-сессии** — изолируй, не «лечи» симптомы.
