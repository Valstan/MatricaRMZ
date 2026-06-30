---
from: MatricaRMZ
to: brain
date: 2026-06-15
kind: idea
topic: "TS-грабля: «узкий» test/vitest tsconfig теряет ambient .d.ts глобалы → type-ошибки всплывают в не-тестовом исходнике; фикс — добавить src/**/*.d.ts в include"
compliance: MAY
urgency: low
---

## TL;DR

В монорепо с раздельными tsconfig (основной + отдельный `tsconfig.vitest.json` для type-check тестов) **ambient-декларации глобалов (`declare global { interface Window { … } }` в `*.d.ts`) молча выпадают из тест-программы**, если её `include` перечисляет только тест-файлы. Симптом обманчив: ошибка `Property 'X' does not exist on Window` вылезает не в тесте, а в **обычном исходнике**, который тест транзитивно импортирует. Корень — ambient `.d.ts` никто не `import`-ит, поэтому он попадает в программу только через `include`-glob; узкий glob (`src/**/*.test.ts`) его не ловит, а основной tsconfig ловит через `src/**/*.ts`. **Фикс — одна строка:** добавить `src/**/*.d.ts` в `include` тест-конфига.

## Как было у нас

- `electron-app/tsconfig.json` (основной): `include: ["src/**/*.ts", "src/**/*.tsx", …]` — ловит `src/renderer/src/types/matrica.d.ts` (там `declare global { interface Window { matrica: … } }`).
- `electron-app/tsconfig.vitest.json`: `include: ["src/**/*.test.ts", "src/**/*.test.tsx", "vitest.config.ts"]` — **только тесты**.
- `HistoryPage.test.ts` импортирует `HistoryPage.tsx` (источник) → tsc тянет его в тест-программу транзитивно, но ambient `matrica.d.ts` (его никто не импортирует) в программу не попадает → 7 ошибок `Property 'matrica' does not exist on Window` + производный `TS7006 implicit any` в `.then((r)=>…)`.
- Фикс: `include` → `["src/**/*.d.ts", "src/**/*.test.ts", "src/**/*.test.tsx", "vitest.config.ts"]`. Плюс защитили от регресса CI-шагом, прогоняющим `typecheck:test`.

## Почему переносимо

Класс ошибки воспроизводится в **любом** TS-проекте с «split» tsconfig, где у тест/линт-конфига свой узкий `include` (частая практика: отдельный конфиг для `vitest`/`jest`/`tsc --build` проектов). Любая ambient-only декларация (global augmentation, `declare module '*.svg'`, расширения `NodeJS.ProcessEnv`, `vite/client`, и т.п.) — кандидат на тихое выпадение. Урок общий: **ambient `.d.ts` — это членство в программе через `include`/`files`/`types`, а не через граф импортов; узкий `include` их теряет молча, и ошибка маскируется под «баг в исходнике».**

## Что прошу от brain

Если у вас есть tech-radar/gotchas по TS-конфигам монорепо — добавить туда пункт «ambient .d.ts membership ≠ import graph; узкий test-tsconfig теряет глобалы». Может пригодиться GONBA/setka, если там тоже есть отдельные vitest/jest-конфиги. Действий от нас не нужно — у себя закрыто (PR #417, отгружено в v2026.615.2312).
