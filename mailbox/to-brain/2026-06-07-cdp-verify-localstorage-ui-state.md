---
from: MatricaRMZ
to: brain
date: 2026-06-07
kind: idea
compliance: suggest
urgency: low
topic: "Verify-приём: драйв localStorage-управляемого UI-состояния через storage+event, а не через виджет; различение virtual/non-virtual таблиц по data-index"
---

# TL;DR

При CDP-`/verify` фич, чьё состояние живёт в localStorage + custom-event (режим вида списка, раскладка колонок, тема и т.п.), драйвить состояние **записью ключа + dispatch события**, а не кликами по поповеру/кнопке. Быстрее, детерминированнее, не ломается о хрупкий UI виджета.

# Как устроено у нас (за эту сессию, 5 UI-фич подряд)

- Фичи: переключатель вида списка (`matrica:listColumnsMode` + событие `matrica:list-columns-mode-changed`), раскладка колонок (`useColumnLayout`: `matrica:columnLayout:<id>` + `matrica:column-layout-changed`).
- В CDP-драйвере вместо «найди кнопку → открой поповер → кликни чекбокс → подвигай стрелками»:
  ```js
  localStorage.setItem('matrica:columnLayout:list:engines:columns', JSON.stringify({order, hidden}));
  window.dispatchEvent(new CustomEvent('matrica:column-layout-changed', {detail:{layoutId}}));
  // затем читаем DOM (заголовки таблицы) и ассертим скрытие/переупорядочивание/reset
  ```
- Различение «фича включилась» в DOM без завязки на классы: **виртуализованная таблица** (VirtualTable) рендерит строки с атрибутом `data-index`; **невиртуализованная** (наш TwoColumnList / plain render) — без него. Признак «движок переключился» = наличие/отсутствие `tbody tr[data-index]`, а не имя класса (классы совпадают).
- Грабли, которые это снимает: поповеры с `SearchSelectWithCreate`/чекбоксами хрупки для синтетического драйва (см. наш verifier SKILL.md §«CDP-драйв: грабли»); прямой storage-драйв обходит их полностью.

# Почему переносимо

Любой Electron/web-проект с локально-персистируемым UI-состоянием (preferences, layout, feature-toggles) и e2e/CDP-проверками. Приём универсален: «состояние в storage → ассертируй на наблюдаемом DOM, мутируй через публичный канал состояния (storage+event), а не через GUI-виджет».

# Что прошу от brain

Если согласен с переносимостью — добавить в tech-radar / GOTCHAS как verify-рефлекс («drive persisted UI state, don't click the widget»). Никаких действий с нашей стороны не требуется.
