// Pure helpers for picking the right recovery strategy when a cached
// installer fails integrity check. Boot-path module: no Electron imports.
//
// Background (F2 in the updater refactor plan): the previous flow always
// did `resume → recheck → full re-download`, even when the cached file's
// size already matched the expected size. In that case the file is fully
// downloaded but its content differs from what the server says is the
// current installer — a "stale cache" — and `Range: <size>-<size>` resume
// returns zero bytes, so resume wastes ~30 seconds before giving up and
// triggering the full re-download anyway.
//
// This classifier lets the caller skip resume when it can't help.

export type IntegrityFailureKind =
  | 'stale' // Size matches expected, but content differs — full re-download.
  | 'partial' // Actual size < expected — resume is meaningful.
  | 'oversize' // Actual size > expected — corrupted, full re-download.
  | 'unknown'; // Either size unknown — safest default is full re-download.

export type IntegrityRecoveryDecision = {
  kind: IntegrityFailureKind;
  shouldTryResume: boolean;
  shouldFullRedownload: boolean;
  logHint: string;
};

/**
 * Decide what to do after `validateInstallerBeforeLaunch` reported a
 * mismatch.
 *
 * The decision is based only on file sizes — content/sha check is the
 * caller's job and already produced the failure. We don't try to recover
 * from anything beyond size mismatches here; for opaque failures the
 * safest path is a full re-download.
 */
export function classifyIntegrityFailure(
  actualSize: number | null | undefined,
  expectedSize: number | null | undefined,
): IntegrityRecoveryDecision {
  const a = Number.isFinite(actualSize) ? Number(actualSize) : null;
  const e = Number.isFinite(expectedSize) ? Number(expectedSize) : null;

  if (a === null || e === null || a < 0 || e <= 0) {
    return {
      kind: 'unknown',
      shouldTryResume: false,
      shouldFullRedownload: true,
      logHint: `size unknown (actual=${a ?? 'n/a'} expected=${e ?? 'n/a'})`,
    };
  }

  if (a === e) {
    return {
      kind: 'stale',
      shouldTryResume: false,
      shouldFullRedownload: true,
      logHint: `cache stale (size matches ${a} but content differs) — skipping resume, full re-download`,
    };
  }

  if (a < e) {
    return {
      kind: 'partial',
      shouldTryResume: true,
      shouldFullRedownload: true, // fall back to full if resume fails
      logHint: `partial download (actual=${a} expected=${e}) — resume will be attempted`,
    };
  }

  return {
    kind: 'oversize',
    shouldTryResume: false,
    shouldFullRedownload: true,
    logHint: `oversize file (actual=${a} expected=${e}) — discarding and full re-download`,
  };
}
