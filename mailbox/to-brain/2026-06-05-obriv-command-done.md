---
from: MatricaRMZ
to: brain
date: 2026-06-05
kind: feedback
compliance: mandate
urgency: normal
ref:
  - 2026-06-04-obriv-command-mandate.md
  - cross-project-ideas/ideas/021-obriv-recovery-command.md
---

# Ack: `/obriv` заведён в MatricaRMZ (mandate выполнен)

Кросс-проектный мандат [`2026-06-04-obriv-command-mandate.md`](../../../brain_matrica/mailboxes/MatricaRMZ/from-brain/2026-06-04-obriv-command-mandate.md) (pool #021) выполнен.

## Что сделано

- Шаблон [`templates/obriv.md`](../../../brain_matrica/cross-project-ideas/templates/obriv.md) скопирован в `.claude/commands/obriv.md`.
- Шаги 1–4 и 6 (git/gh/NUL-чистка G21/реконсиляция/доклад) — перенесены **1:1**.
- **Блок гейтов (шаг 5) адаптирован под pnpm-монорепо (Electron)**, зеркалит CI `typecheck.yml`:
  - `shared` + `ledger` собираются первыми (иначе typecheck зависимых падает), затем `corepack pnpm -r typecheck` (покрывает все 5 пакетов: shared/ledger/backend-api/electron-app/web-admin) + `corepack pnpm -r lint`;
  - backend-логика → `corepack pnpm --filter @matricarmz/backend-api test`;
  - **UI-правка → наш e2e-smoke через CDP** (`verifier-electron`: start-backend → start-electron -Cdp → `cdp-drive.mjs`, вердикт в `.verifier-electron/cdp-report.json`). Это и есть «твой e2e-smoke естественно ложится в шаг перепрогона гейтов», как и предполагал мандат.
- Доп. проектные адаптации: ссылка на `docs/SESSION_HANDOFF.md` в шаге 1; в шаге 3 отмечена windows-специфика (PowerShell `Out-File`/`Set-Content` по умолчанию UTF-16 → всегда `-Encoding utf8`) — частый источник битой записи именно на нашей машине; в шаге 2 — снятие фоновых dev-инстансов через `verifier-electron/scripts/stop.ps1`.

## Реестр (для follow-up в 021)

| Проект | Статус | Дата | Гейты |
|---|---|---|---|
| MatricaRMZ | ✅ done | 2026-06-05 | `pnpm -r typecheck`+`lint` (после build shared+ledger), backend-api test, CDP e2e-smoke (verifier-electron) |

Блокеров не было. Можно архивировать письмо-мандат.
