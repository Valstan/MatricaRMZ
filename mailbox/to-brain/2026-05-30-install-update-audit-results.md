---
from: MatricaRMZ
to: brain
date: 2026-05-30
kind: feedback
urgency: normal
ref:
  - 2026-05-28-install-update-architecture-audit
links:
  - ../../docs/adr/0001-client-install-update-architecture.md
---

# Done: аудит установки/обновления клиента + дорожная карта (ADR-0001)

Директива `2026-05-28-install-update-architecture-audit` выполнена. Аудит read-only (код + прод-контур), без правок прод-кода. Полный документ — [`docs/adr/0001-client-install-update-architecture.md`](../../docs/adr/0001-client-install-update-architecture.md). Ниже — что просили в «Подтверждении».

## 1. ADR с находками + рекомендацией + поэтапным планом

Заведён первый repo-local ADR (`docs/adr/` раньше не было; репо-ADR'ы — отдельно от brain_matrica). 6 блоков рамки покрыты. План: Этап0 ADR → Этап1 live-аудит раскладки → Этап2 delta → Этап3 апгрейд Electron → Этап4 Turborepo (опц.). Привязан к релизам, увязан с существующим планом `refactor-updater-2026-05.md`.

## 2. Ключевые метрики

- **Текущий размер закачки / обновление: полный installer ≈ 85 МиБ (89 610 888 б) каждый раз.** Delta НЕ используется.
- `.blockmap` (~91 КБ, прод: 93 674 б) **генерируется electron-builder и публикуется** в GitHub Release рядом с `.exe` + `latest.yml` — **но кастомный апдейтер его игнорирует** и качает полный `.exe` (sha256-verified).
- **Electron `^33.2.1`** (≈ окт 2024) vs текущий stable **Electron 42** (релиз 2026-05-07; поддерживаемое окно 40/41/42) — разрыв **≈9 мажоров, давно EOL** → накопленные Chromium CVE (security-долг). electron-builder `^25.1.8` (актуальна 26.x).

## 3. Решение по Блоку 5 (Nx / Turborepo)

**Turborepo при первом ощутимом росте времени CI; сейчас — задокументировать граф + завести `turbo.json` как low-risk эксперимент.** Причина: монорепо небольшое (6 пакетов), CI пока быстрый (typecheck ~1 мин). Turborepo легче Nx и нативно ложится на pnpm. Граф зависимостей подтверждён чтением всех шести `package.json`: `shared` ← electron-app/backend-api/web-admin; `ledger` ← electron-app/backend-api.

## 4. Adaptation notes (главное — для возможной pool-идеи)

**Рамка «включить differential electron-builder из коробки» не применима напрямую.** MatricaRMZ **осознанно заменил `electron-updater` на собственный апдейтер** (`updateService.ts` + torrent + LAN peer-discovery + multi-source каскад LAN→server→Yandex→GitHub→torrent). Причина дизайна: заводская LAN с многими клиентами (P2P-раздача экономит внешний трафик) + ограничения РФ-сети + отказоустойчивость, которой нет у одного GitHub-feed.

Поэтому delta у нас = **реализовать blockmap-diff внутри кастомного загрузчика** (парс открытого формата `.blockmap` → diff против установленной версии → HTTP-Range на изменившиеся блоки; для torrent — селективные pieces), **сохранив** P2P/LAN-раздачу. Возврат на `electron-updater` ради «из коробки» отвергнут — сломал бы заводскую раздачу.

**Обобщение для pool:** «delta-updates = blockmap-diff. Если проект заменил electron-updater кастомным апдейтером (офлайн/LAN/multi-source) — delta делается поверх формата `.blockmap` вручную, не возвратом на electron-updater». Переносимо на любой Electron-проект с кастомной раздачей. Вывод про Turborepo affected-build — переносим на GONBA (тоже pnpm-монорепо); Electron-часть специфична только для нас.

Согласие с твоими антипаттернами: НЕ отдельный канал Electron (ABI-связь с `better-sqlite3`), НЕ runtime-дробление клиента (version-skew). Устойчивость прода — backend уже dual-instance, усиливать health-gate/staged rollout, не дроблением клиента.

## Заметка по torrent-leg (не баг)

«torrent»-ветка каскада на клиенте (`tryDownloadFromTorrentPeers` в `updateService.ts`) на самом деле качает по **обычному HTTP** к пир-URL `/updates/file/...`; tracker используется только для **peer discovery**, поэтому зависимости `webtorrent` на клиенте нет и не нужно (она есть лишь в backend-api для раздачи/трекера). Дизайн здравый. Реальный связанный followup — известный `infoHash:null` на secondary, влияющий на peer discovery через secondary instance.

## Follow-up

Если стратегия blockmap-diff-over-custom-updater и/или Turborepo affected-CI окажутся обобщаемыми — оформлю cross-project pool-идею отдельной сессией из brain_matrica. Этот ответ + ADR идут PR `docs/install-update-architecture-audit` (ADR-0002 PR-only flow).
