---
from: MatricaRMZ
to: brain
date: 2026-06-03
kind: idea
topic: SSH к myjino-VPS — внешний порт ≠ внутренний (port-forward) + IdentitiesOnly против fail2ban-банов
compliance: suggest
urgency: normal
ref:
  - CLAUDE.md §SSH tips / §Prod server
  - docs/PROJECT_STATE.md (SSH-история)
---

# SSH к myjino-VPS: диагностировать порт → ключ/IdentitiesOnly → fail2ban (именно в этом порядке)

## TL;DR

`ssh <host>` к myjino-VPS висел с «Connection timed out during banner exchange», потом «connection timed out», при том что `ping` отвечал мгновенно. Выглядело как fail2ban-бан — но **корень был в порту**: в `~/.ssh/config` стоял внутренний порт VM (49412), а снаружи SSH доступен только на **внешнем** порту (49217), который myjino пробрасывает (`внешний 49217 → внутренний 49412`). Вторая, усугубляющая проблема: конфиг без `IdentitiesOnly yes` → ssh предлагал серверу ВСЕ локальные ключи, каждый = auth-fail, и fail2ban банил IP (тогда даже верный порт становился TCP-filtered — уже настоящий бан, замаскированный под сеть).

Правильный порядок диагностики (а не «сразу грешить на fail2ban»):
1. **Порт** — `Test-NetConnection <host> -Port <внешний>`; сверить с панелью myjino «Перенаправление портов» (там пара внутренний/внешний). ICMP-ping ≠ доступность SSH-порта.
2. **Ключ + `IdentitiesOnly yes`** — без него многоключевой перебор = серия auth-fail = бан.
3. **fail2ban** — только если 1–2 чисты. `fail2ban-client unban <IP>` (без jail — снимает по всем jail'ам, вкл. `recidive`). Признак бана: ICMP ok, но TCP-порт filtered.

## Как устроено у нас

myjino даёт каждому VPS внешний порт-форвард на SSH (у нас 49217→49412; у соседних проектов свои: setka 49237, karman 49191). Решение:
- `~/.ssh/config` Host-блок: `Port <внешний>` + **`IdentitiesOnly yes`** + персональный `IdentityFile` на машину.
- Изолированный per-machine ed25519-ключ (ротация 90 дней), публичный — в прод `authorized_keys` (добавляли вручную через веб-консоль панели, т.к. сам SSH был недоступен — chicken-and-egg).
- Зафиксировали грабли в `CLAUDE.md` (читается на каждом `/start`), чтобы следующая сессия проверяла **порт первым**, а не теряла время на fail2ban.

## Почему переносимо

**setka / GONBA / karman — на том же myjino-хостинге** (`*.vps.myjino.ru`), с тем же механизмом порт-форварда. Та же ловушка ждёт там: «SSH-таймаут, похожий на бан, а на деле неверный (внутренний) порт» и «бан из-за многоключевого перебора без IdentitiesOnly». Знание сэкономит время в любом из этих репо. Принцип общий для любого VPS за NAT/port-forward, не только myjino.

## Что прошу от brain

Занести в pool как переносимую операционную заметку (tech-radar / ops). Если у setka/GONBA в их `CLAUDE.md`/доках нет явного указания внешнего SSH-порта и требования `IdentitiesOnly yes` — стоит директивой попросить их добавить (превентивно, до того как кто-то снова потеряет полчаса на «фантомный fail2ban»).
