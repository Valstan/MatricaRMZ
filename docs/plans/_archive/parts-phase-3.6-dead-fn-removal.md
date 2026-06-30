# План Phase 3.6: снос мёртвых service-fn legacy parts + dual-write мост

> Часть master-плана [`parts-nomenclature-phase3.md`](parts-nomenclature-phase3.md). **Исполнять ПОСЛЕ деплоя Stage H** (blanket 410 на `/parts/*` data-routes). Анализ — read-only разведка 2026-06-05 (callers по всему репо).

## Контекст

Stage H повесил `410 Gone` на legacy `/parts/*` data-routes (роуты не дёргают хендлеры). Теперь часть exported service-fn в `partsService.ts` недостижима через API. Phase 3.6 = убрать гарантированно мёртвое; снос script-зависимых fn и dual-write моста — отдельным шагом (3.7) после решения о судьбе legacy-скриптов.

## Tier 1 — снести сразу (0 вызовов, роут 410, самодостаточны)

| Функция | partsService.ts | Внешние вызовы | Внутренние | Вердикт |
|---|---|---|---|---|
| `getPart` | ~1525 | нет | нет | ✅ удалить |
| `createPartAttributeDef` | ~1093 | нет | нет | ✅ удалить |
| `createPartFromTemplate` | ~1881 | нет | зовёт `getPartTemplate`/`createPart` (живые, односторонне) | ✅ удалить саму fn |

- Сопутствующе: подчистить `backend-api/src/tests/parts.gone.test.ts` от ссылок на удаляемые (если есть).
- `*/parts/templates/*` CRUD (`createPartTemplate`/`listPartTemplates`/`getPartTemplate`/`updatePartTemplateAttribute`/`deletePartTemplate`) — **живые, НЕ трогать** (шаблоны не депрекированы).

## Tier 2 — отложить до Phase 3.7 (зависит от решения по legacy-скриптам)

Эти exported, роут 410, но зовутся **data-скриптами** (seed/import/migrate), не API:
`createPart`, `listParts`, `updatePartAttribute`, `deletePart`, `upsertPartBrandLink`, `deletePartBrandLink`, `listPartBrandLinks`.

Скрипты-потребители: `seedDevFixtures.ts`, `importEngineBrandPartMatrix.ts`, `importEnginesFromCompletenessCsv.ts`, `applyCompletenessClarifications.ts`, `fixPartsAssemblyAndName.ts`, `restoreEngineChecklistParts.ts`, `mergeDuplicatePart.ts`.

**Dual-write мост** (private, best-effort, не throw):
- `mirrorPartFieldsToDirectory` (~1971) — EAV part-атрибуты → `directory_parts` (spec-колонки + metadata). Зовётся из `createPart` (~2550) и `updatePartAttribute` (~2777).
- `mirrorPartBrandLinksToDirectory` (~1941) — `part_engine_brand` → `directory_parts.brandLinksJson`. Зовётся из `upsertPartBrandLink` (~2262), `deletePartBrandLink` (~2351).

`directory_parts` **читается** в `warehouseService.ts` (≈7 мест). Значит пока кто-то пишет в parts через скрипты, мост нужен (иначе `directory_parts` рассинхронится).

## Открытое решение для Phase 3.7

Судьба legacy data-скриптов: **депрекировать** (переписать на nomenclature/directory напрямую) → тогда снести Tier 2 + dual-write мост; либо **оставить** → мост и Tier 2 живут. Это решение принимать на сошедшейся модели (после Stage H + первичной эксплуатации). До решения — Tier 2 не трогаем.

## Порядок исполнения (после деплоя Stage H)

1. Удалить 3 fn Tier 1 + почистить тест. Гейт: `pnpm -r typecheck`/`lint` + `backend-api test`.
2. PR (backend-only, без миграций). 
3. Phase 3.7 (отдельно): решить судьбу скриптов → снести Tier 2 + мост, или зафиксировать «оставляем».
