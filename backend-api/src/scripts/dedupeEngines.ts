// CLI wrapper around engineDedupeService (owner batch task 1).
//
// Dry-run by default; --apply to mutate, --prefer-newer to resolve attr
// conflicts toward the most recently created record, --actor=<login>.
//
// ⚠ When applying against a database whose backend services are RUNNING,
// prefer the in-process periodic job (startEngineDedupeJob) — a standalone
// process races the services for LedgerStore files (no file locking, see
// PENDING_FOLLOWUPS). Manual --apply is safe only with services stopped.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api masterdata:dedupe-engines
//   corepack pnpm -F @matricarmz/backend-api masterdata:dedupe-engines -- --apply --prefer-newer
import { runEngineDedupePass } from '../services/engineDedupeService.js';

const APPLY = process.argv.includes('--apply');
const PREFER_NEWER = process.argv.includes('--prefer-newer');
const ACTOR_LOGIN = (process.argv.find((a) => a.startsWith('--actor='))?.slice('--actor='.length) ?? 'valstan').trim();

async function main() {
  const res = await runEngineDedupePass({ apply: APPLY, preferNewer: PREFER_NEWER, actorLogin: ACTOR_LOGIN });
  for (const line of res.log) console.log(line);
  console.log(`\n--- summary (${APPLY ? 'APPLIED' : 'dry-run'}) ---`);
  console.log(`duplicate groups: ${res.groups}`);
  console.log(`operations repointed: ${res.opsRepointed}`);
  console.log(`stray operations repointed: ${res.strayOpsRepointed}`);
  console.log(`attributes filled on survivors: ${res.attrsFilled}`);
  console.log(`losers soft-deleted: ${res.losersDeleted}${APPLY ? '' : ' (planned)'}`);
  if (res.conflicts.length) {
    console.log(`\nCONFLICTS:`);
    for (const c of res.conflicts) console.log(`  ${c}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
