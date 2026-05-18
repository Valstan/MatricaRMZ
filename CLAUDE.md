# MatricaRMZ — Claude Code instructions

## Language
All final messages, summaries, explanations, and recommendations to the user must be in **Russian**.
Internal reasoning, code comments, commit messages, identifiers — in English (as used in the project).

## Project overview
MatricaRMZ is an Electron + Node.js desktop application for engine repair plant management.
Monorepo structure:
- `electron-app/` — Electron desktop client (React + TypeScript)
- `backend-api/` — Express REST API + SQLite via Drizzle ORM
- `shared/` — shared types and domain logic (TypeScript)
- `web-admin/` — web admin panel
- `scripts/` — release automation scripts

## TypeScript config
`exactOptionalPropertyTypes: true` is enabled. **Never assign `undefined` to optional fields.**
Use conditional spread instead: `...(x.val ? { field: String(x.val) } : {})`

## EAV system
Entity attributes are stored in the `attribute_values` table (EAV pattern).
No DDL migrations needed when adding a new attribute — use `setAttr(entityId, attrName, value)`.
New attributes must be registered in `ensureAttributeDefs` inside `SimpleMasterdataDetailsPage.tsx`.

## Release process
1. `node scripts/bump-version.mjs --set X.Y.Z` — bumps version in all package.json files
2. Add entry to `shared/src/domain/releaseWelcome.ts` (prepend to `RELEASE_WELCOME_HISTORY`)
3. Commit + tag: `git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`
4. On prod server: `git pull --ff-only && pnpm install && build shared/backend-api/web-admin && restart services`
5. After GitHub Action builds .exe: `gh release download vX.Y.Z --pattern "*.exe" -D /opt/matricarmz/updates --skip-existing`
6. `corepack pnpm release:ledger-publish X.Y.Z`

## Prod server
SSH: `ssh valstan@<server>` — fail2ban is active (aggressive mode), repeated failed attempts cause temporary ban.
Services: `matricarmz-backend-primary.service` and `matricarmz-backend-secondary.service`
Updates dir: `/opt/matricarmz/updates/`
Health check: `curl -fsk https://127.0.0.1/health`
Updates status: `curl -fsSk https://127.0.0.1/updates/status`

## Key architecture decisions
- Services (услуги) belong to the Supply (Снабжение) menu group
- `engine_brand_ids` attribute on services: JSON array of engine brand entity IDs, stored via EAV
- Service card origin tracking: `serviceOriginTab` state in App.tsx — close returns to opening tab
- Work order service dropdown filtered by selected engine's brand; universal services (no brands) always shown
- BOM ↔ engine brands: M:N junction table `bom_engine_brands`
- Ledger encryption: keyring format (enc:v2) with multiple keys, backward-compat with enc:v1

## Code style
- No comments unless the WHY is non-obvious
- No error handling for impossible cases
- No abstractions beyond what the task requires
- Prefer editing existing files to creating new ones
