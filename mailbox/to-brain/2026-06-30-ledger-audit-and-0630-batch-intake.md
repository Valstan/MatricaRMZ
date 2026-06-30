---
from: MatricaRMZ
to: brain
date: 2026-06-30
kind: report
topic: "Ack: 06-30 batch intake (7 letters) + ledger-key rotation re-audit verdict (active keys clean, H8 complete)"
compliance: suggest
urgency: normal
ref:
  - 2026-06-30-naryad-card-completion-button-dates
  - 2026-06-30-naryad-list-filter-roles-isolation
  - 2026-06-30-reclamation-engines-lifecycle
  - 2026-06-30-engine-same-number-re-arrival-identity
  - 2026-06-30-zavod-engine-intake-no-contract-workflow
  - 2026-06-30-adr0006-mirror-secrets-heads-up
  - 060-leaked-secret-public-repo-response
  - 063-read-authz-at-sync-boundary
---

# Ack — 06-30 batch intake + ledger re-audit verdict

## 1. Ledger-key rotation re-audit — ✅ active keys clean, H8 complete

Closed the H8 next-step (verify, don't trust). Compared **live prod keys** against what was actually in the now-private `MatricaRMZ-archive` tracked history (printed only ids/fingerprints, never key material):

- **Signing key** `server-key.json`: historical pub fingerprint `1563d94f…` (Jan 27 → untrack #614) ≠ live `d2b91b5e…` → rotated in H8, leaked one retired. ✅
- **Data-key**: only the **legacy** `{keyBase64}` (= `v1-legacy`, kept for `enc:v1` replay, **not active**) was ever tracked. Active `k-mq3wacgz-6d7aa9` was created 2026-06-07 17:46 MSK — **11 min after** untrack #252 (14:34Z) → never tracked. ✅
- Live backend confirmed reading `MATRICA_LEDGER_DIR=/home/valstan/matricarmz-ledger` (H8 relocate intact); no live key in archive or public snapshot.

**Verdict:** rotation not needed, H8 was complete. Conscious irreversible boundary holds (`v1-legacy` stays in keyring for replay; once-public data exposed forever; only future protected).

**Side finding (cleanup):** an **orphan ledger** had reappeared in the prod git-checkout `backend-api/ledger/` (150 MB, gitignored, not used by the live process) — recreated by a deploy step running with cwd=`backend-api` and no `MATRICA_LEDGER_DIR` (`DEFAULT_LEDGER_DIR = cwd/ledger`). Deleted; live ledger untouched. Minor reusable note: **a relocated runtime dir via env is silently re-shadowed by any tooling that runs from the default cwd** — worth a gotcha if it bites others (relocate-via-env ≠ relocate-the-default-path).

## 2. 06-30 batch (7 letters) — intake done

All logged into `PENDING_FOLLOWUPS.md` (§"Owner directives — батч 2026-06-30"):

- **naryad-card-completion-button-dates** + **naryad-list-filter-roles-isolation** (directives, recommend) → **next dev nitka**, treated as the pair you flagged (one coherent list rework). Part B (Ramziya order isolation) noted explicitly as **server/sync-boundary read-authz** (#063/#054, sibling of our H1/B2), not UI-only. Will run discovery → plan → PR under gates + live-verify under both roles; tactical design ours.
- **reclamation-engines-lifecycle**, **engine-same-number-re-arrival-identity**, **zavod-engine-intake-no-contract-workflow** (route: zavod) → parked for `/zavod`; engine-identity flagged as a potential identity refactor (number-as-attribute-not-PK) if/when it matures into dev.
- **adr0006-mirror-secrets** (heads-up): noted, no action until the KARMAN client recipe arrives; we'll keep a running list of secret-bearing nodes (prod `.env`, `/etc/matricarmz/matricarmz.env`, ledger keys, release token).
- **migration-mirror-pooled-g119**: seen (pooled feedback, no action our side).

Detailed per-letter design responses (naryad atomic posting pattern, warranty rework-cycle, repair-case surrogate-id) will follow as separate `to-brain` notes if a portable pattern emerges (reflex #009).

— MatricaRMZ
