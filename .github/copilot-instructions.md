## MatricaRMZ — Copilot / AI agent quick instructions

This file contains targeted, discoverable guidance for an AI coding agent working in this repository. Read `docs/README.md` before doing anything invasive.

1. Start-up checklist (must do)
   - Read `docs/README.md` (session protocol) and `docs/PROJECT_STATE.md`.
   - Run `git status --branch --short` and `git fetch origin --prune`. Do not overwrite local work.
   - Use corepack+pnpm for commands (examples below).

2. Fast setup / dev commands
   - Install & prepare: `corepack pnpm run setup:dev` (root)
   - Build shared types: `corepack pnpm run build:shared`
   - Run DB migrations: `corepack pnpm run db:migrate`
   - Start services (parallel work):
     - Backend: `corepack pnpm run dev:backend`
     - Electron: `corepack pnpm run dev:electron`
     - Web admin: `corepack pnpm run dev:web-admin`

3. Architecture snapshot (what to read)
   - Workspaces: `backend-api/`, `electron-app/`, `shared/`, `ledger/` (see root `package.json`).
   - Shared domain & contracts: `shared/src/domain/*`, IPC types `shared/src/ipc/types.ts`, sync DTOs `shared/src/sync/*`.
   - Backend API: `backend-api/src` (entry `index.ts`), routes in `backend-api/src/routes/`.
   - Electron client: main/preload/renderer under `electron-app/src/` (sync/update services: `main/services/*`).
   - Ledger integration: releases, sync and client updates go through ledger and ledger endpoints — do not change sync to bypass ledger.

4. Project-specific conventions & patterns
   - Type & DTO canonical source: `@matricarmz/shared` (build this first when types change).
   - DB migrations: `backend-api/drizzle/` (SQL), `drizzle.config.ts` present in packages; migration runner: `backend-api/src/database/migrate.ts`.
   - Releases and auto-updates: must be published to the ledger with valid `version`, `fileName`, `size`, `sha256` (see `docs/OPERATIONS.md`).
   - Prebuild step: some packages (`electron-app`, `backend-api`) call `../ledger build` during `prebuild` — ledger must build first if changing its shape.
   - Tests: vitest used across workspaces (`pnpm -r test` / package scripts `test`).

5. Important files to inspect when changing behavior
   - `backend-api/env.example.txt` — canonical ENV keys
   - `shared/src/domain/releaseWelcome.ts` — release welcome text used in client releases
   - `electron-app/src/main/services/updateService.ts` and `syncService.ts` — update/sync flows
   - `backend-api/src/routes/*` and `backend-api/src/services/*` — server-side invariants

6. Safety & agent rules (strict)
   - Never commit secrets or `.env` contents. Respect `backend-api/env.example.txt` only as schema.
   - Follow `docs/README.md` git safety steps: report dirty trees and ask before destructive actions (force-push, reset, overwrite).
   - Do not change ledger-based sync/release mechanisms without explicit human approval.

7. Quick examples (where to make small changes)
   - Add a new shared DTO: edit `shared/src/sync/dto.ts`, run `corepack pnpm --filter @matricarmz/shared build` and rebuild dependents.
   - Add a DB column: add SQL migration under `backend-api/drizzle/`, then run `corepack pnpm --filter @matricarmz/backend-api db:migrate`.

8. Where to look for further instructions
   - Operational runbook: `docs/OPERATIONS.md`.
   - Release flow: `docs/RELEASE.md`.
   - Troubleshooting / sync incidents: `docs/TROUBLESHOOTING.md`.

If anything above is unclear or you need more examples (small PRs, tests, or a checklist for releases), tell me which section to expand and I will iterate.
