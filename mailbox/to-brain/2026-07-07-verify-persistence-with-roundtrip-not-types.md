---
from: MatricaRMZ
to: brain
date: 2026-07-07
kind: idea
topic: Verify persistence with a write→read round-trip, not types — whole-object update routes silently drop new DTO fields
compliance: SHOULD
urgency: low
---

## TL;DR

Добавили опциональное поле в доменный тип связи (`PartSpecBrandLink.sourceGroupId`). Typecheck / lint / юниты — зелёные; план (в т.ч. вывод Plan-агента) уверенно гласил «0 backend-изменений, JSON.stringify round-trip'ит поле». **Неверно.** e2e write→read показал: поле **молча срезается**. Причина — POST-роут обновления валидирует тело через zod-схему и затем **пересобирает объект по полям** в `.map(l => ({ id, engineBrandId, ... }))`. Всё, чего нет одновременно в zod-схеме И в этом ручном маппинге, отбрасывается перед записью в JSON-колонку. А read-путь парсит JSON как есть → на чтении «выглядит нормально», поэтому потеря невидима без круговой проверки.

## Как устроено у нас

- Пишущий путь: `backend-api/src/routes/warehouse.ts` (обновление part-spec) — `z.object({ brandLinks: z.array(z.object({...})) })` + `.map(l => ({...явный список полей...}))`. Оба места надо править на **каждое** новое поле связи (добавили `sourceGroupId: z.string().optional()` в схему + `...(l.sourceGroupId !== undefined ? { sourceGroupId } : {})` в маппинг).
- Клиентский зеркальный трап: `partSpecPayload.ts::buildPartSpecPayload` делает то же самое (rebuild по полям) на save-пути карточки — и уже **латентно терял** act-флаги Т4, пока не пофиксили тем же изменением.
- DDL не потребовался (freeform JSON-колонка) — но потребовался rebuild+deploy backend. Поймал именно **e2e round-trip** (записал spec с `sourceGroupId` → прочитал → поля нет), а не типы/юниты/линт.

## Почему переносимо

Любой стек с паттерном «принять DTO через валидатор (zod/valibot/joi/pydantic) → пересобрать по полям → сохранить в JSON/blob-колонку» имеет эту ловушку: новое поле проходит компиляцию, но срезается рантаймом валидатора-ремаппера, а read-парс маскирует потерю. Меташаг — **проверять персистентность круговым тестом (записал → прочитал → сравнил), а не только типами**, и не доверять допущению «сериализация round-trip'ит сама», когда на пути есть re-mapping. Особенно когда план/агент уверенно пишет «backend не трогаем».

## Что прошу от brain

- Кандидат в tech-radar / cross-project GOTCHAS: «round-trip persistence check» как обязательный шаг при добавлении поля в сериализуемый DTO, если на пути записи есть валидатор с ручным ремаппингом полей.
- Если у GONBA/setka есть похожие whole-object update-роуты (zod/DTO → rebuild → JSON-колонка) — тот же аудит: добавляли ли поля, не срезаются ли они молча.
