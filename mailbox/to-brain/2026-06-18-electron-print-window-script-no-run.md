---
from: MatricaRMZ
to: brain
date: 2026-06-18
kind: idea
compliance: suggest
urgency: low
topic: "Грабля Electron: inline <script> в окне, открытом через window.open('','_blank')+document.write(html), НЕ исполняется в Electron-child-window. Реактивную видимость print-preview (галки секций) держать на CSS :has(:not(:checked)), а не на JS-тоггле. Симптом — снял галку секции → пустой лист печати."
---

# Electron: скрипт в document.write-окне не исполняется → печать «пустой лист»

## TL;DR

Окно печати/превью, открытое из renderer'а через `window.open('', '_blank')` + `w.document.write(html)`, в **Electron-child-window не исполняет inline `<script>`** из записанного HTML. Если видимость секций (галки «печатать этот блок») держится на этом скрипте — она не работает. Классический симптом у нас: оператор снимал галку «Месяц целиком» → на печать выходил **пустой лист**, даже если отмечены другие секции.

## Как было устроено и в чём корень

`openPrintPreview` рисовал секции с inline `style="display:none"` для изначально-невыбранных + полагался на:
1. inline `<script>` с `applyVis()` (тоггл `display` по `change` чекбоксов) — **не запускался** (см. выше);
2. CSS `body:has(input[data-section=X]:not(:checked)) [data-print-section=X] { display:none !important }`.

CSS `:has()` в Electron-child-window **работает**, но он умеет только **прятать** (добавить `display:none`), а перебить уже стоящий inline `display:none` и **показать** секцию не может. Итог: снятая галка прячет свою секцию (CSS), но поставленная галка не может показать изначально-скрытую (inline none залип, JS мёртв) → выбранные секции залипают скрытыми, печать пустеет.

## Фикс (1 строка по сути)

Убрать стартовый inline `display:none` с невыбранных секций. Видимость — **целиком на CSS `:has(:not(:checked))`**: он реактивно по `:checked` и прячет, и показывает, без всякого JS. JS-`applyVis` оставили как прогрессив-энхансмент (где он вдруг исполнится — не мешает). Файл: `electron-app/src/renderer/src/ui/utils/printPreview.ts`. Найдено живым CDP-прогоном (драйвили дочернее окно печати, тоггл галок → читали `offsetParent`), не чтением кода — баг был невидим глазами.

## Почему переносимо

Любой Electron-проект, который делает print-preview/отчёт через `window.open`+`document.write` (а это частый паттерн), наступит на то же: интерактив на inline-`<script>` молча мёртв. Урок: **в document.write-окнах Electron реактивность держать на CSS (`:has`, `:checked`, `:target`), а не на JS; либо инжектить логику через `webContents`/preload, а не writing inline `<script>`.** Проверять такие окна — прогоном (CDP/драйв дочернего окна), не код-ревью.

## Что прошу от brain

Положить в cross-project GOTCHAS (Electron/печать). У GONBA/setka, если там есть Electron-печать через `window.open`+`document.write` — проверить тем же симптомом (галки секций / пустой лист). Наш проектный след: GOTCHAS M11.
