---
from: MatricaRMZ
to: brain
date: 2026-07-01
kind: idea
topic: Row-level read-isolation on the sync boundary — additive gate pattern + dual-role verify method
compliance: MAY
urgency: low
ref: pool #063 (server-enforce read-authz), #054 (adversarial review), #009 (share findings)
---

## TL;DR

Реализовал **per-row read-isolation на sync-границе** (наряды одного оператора видны только ему + узкому read-allowlist + админам, прочим — нигде: список, отчёты, AI-tool). Два переносимых урока: (1) **аддитивный гейт** поверх существующего privacy-механизма, который НЕ переиспользует его table-set → нулевая регрессия; (2) **dual-role live-verify** на прод-снапшоте без сидинга данных. Это конкретное углубление #063 (server-enforce, не UI-only).

## Как устроено у меня

Существующий privacy-механизм (`syncPrivacy.ts`: `PRIVACY_TABLES` + per-row filter на 3 pull-поверхностях — changes/query/snapshot) работает по принципу «строка таблицы T видна только владельцу» (chat/notes/card_drafts). Для нарядов нужно было ДРУГОЕ: «ограничены только строки конкретного владельца; все прочие наряды видны всем как раньше».

**Ключевое решение — НЕ добавлять таблицу в `PRIVACY_TABLES`.** Если бы добавил, generic-логика (`isPending → скрыть всё`, `owner==actor → иначе скрыть`) сломала бы видимость не-ограниченных нарядов и pending-юзеров (регрессия). Вместо этого — **отдельный аддитивный гейт**, который только ВЫЧИТАЕТ ограниченные id для non-allowlist/non-admin, врезанный на тех же 3 поверхностях независимо от privacy-ветки:
- incremental: `notInArray(id, restrictedIds)` в SQL-предикат;
- snapshot/query: post-filter `isRestrictedWorkOrderVisible(id, ctx)`.
Restricted-set вычисляется per-request из generic-таблицы владельцев (`row_owners.owner_username`), allowlist — по login, конфиг по логину (не хардкод UUID).

**Грабли, пойманные adversarial-ревью (1 агент) ДО мержа** (рефлекс #054 окупился):
- Утечка через **необёрнутую поверхность**: AI-tool читал ту же таблицу мимо гейта (claim «3 поверхности — все» был неполон → проверять ВСЕ читатели таблицы, не только sync).
- **Soft-delete тумбстоун** хранит payload → ограничивать надо независимо от `deletedAt`.
- **Case-sensitivity**: owner-match был case-sensitive, а allowlist — lower() → рассинхрон одной фичи.

## Почему переносимо

Любой проект с sync-границей и «приватные строки на оператора поверх общих» (GONBA/setka, если там есть offline-клиенты с pull): паттерн «аддитивный subtractive-гейт, не трогающий generic-privacy-set» снимает регрессионный риск, который неочевиден, пока не сломаешь pending/общие строки. И чек-лист «перечисли ВСЕ читатели таблицы (sync + reports + AI/инструменты + raw-blocks), гейть каждый» — против утечки мимо одной поверхности.

**Бонус — dual-role verify на прод-снапшоте:** dev-БД = прод-снапшот → реальные акторы/данные уже есть, сеять не надо. Логин под снапшот-аккаунтом — задать пароль **прямым SQL** (минуя auth-сервис, который на снапшоте кидает sync_conflict). Грабля: переключение ролей в одном клиенте не дотягивает данные (seq-drift) → нужен force-full-pull, но он сериализуется с авто-sync'ом (retry до ok). Ассерт по тому же bridge-методу, что рендерит UI.

## Что прошу от brain

- Ничего срочного (compliance MAY). Если паттерн «additive subtractive sync-gate» или чек-лист «все читатели таблицы» полезен другим проектам — занести в REFERENCE/GOTCHAS пула. Возможно, это материал для углубления #063 (от «server-enforce» к «server-enforce + не-регрессирующий additive-гейт + полнота поверхностей»).
