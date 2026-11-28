# Случай: дубли общих модулей — разведка участка — 2026-11-28

**Что советовал (разведчик).** Собрать факты по названному участку: лестницы «где двигатель сейчас»
и `escapeHtml` — где они, чем отличаются, где настоящие копии.

**Что вышло.**

1. **Ранжирование общее**: `repairStageRank` (`shared/src/domain/repairStages.ts:220`),
   `compareStageRecency` (`:252`), `resolveStageCode` (`:189`), `isServiceStageCode` (`:62`).
2. **Настоящий дубль — пороги**, а не функции: «обкатка = готов» написан в `payments.ts:715` и
   `engineFactoryStage.ts:201`; порог «в ремонте» — `engineFactoryStage.ts:202`.
3. **«2 копии в main» — неточность**: `engineService.ts:29,33` и `repairStageService.ts:18` —
   **импорты**; собственных определений лестниц в `main` нет.
4. **`escapeHtml` — 11 копий** (renderer 6, main 3, web-admin 2), общего в `shared/src` **нет**;
   поведение по апострофу **разное** (`printPreview.ts:93` экранирует, `photoPrint.ts:116` — нет).
5. **Пункт PENDING устарел** в части печати картинок: `photosPrint` (`fileService.ts:1051`) и
   `photosPrintLocalPaths` (`:1075`) обе зовут общий `printPhotos`.

**Вывод.** «Дубль» и «использование» — не одно и то же: сторож перечислял **потребителей**, а не
копии. Разведчик обязан отличать **копию кода** от **продублированного правила** — лечится дешевле
всего.

**След:** [`docs/council/2026-11-28-dubli-obshchih-modulev/10-scout.md`](../../../../council/2026-11-28-dubli-obshchih-modulev/10-scout.md)
