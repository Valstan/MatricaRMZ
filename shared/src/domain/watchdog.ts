import { compareCalver } from './calver.js';

// The external watchdog (recovery agent) ships in every client build AFTER this
// version — it was merged right after the 2026.622.1241 release, and since then
// every installer registers the watchdog Scheduled Task. A `reinstall` command
// only makes sense for a client that actually has a watchdog to consume it
// (otherwise it sits unacked in the client's single sync-request slot forever).
// Both the admin UI and the server gate the command on the client reporting a
// build newer than this. Single source of truth for that boundary.
export const WATCHDOG_ROLLOUT_AFTER_VERSION = '2026.622.1241';

// Whether the client's last reported version is new enough to carry the watchdog.
// A non-CalVer or absent version (old build, never seen) → treated as no watchdog.
export function clientHasWatchdog(lastVersion: string | null | undefined): boolean {
  const cmp = compareCalver(String(lastVersion ?? ''), WATCHDOG_ROLLOUT_AFTER_VERSION);
  return cmp !== null && cmp > 0;
}
