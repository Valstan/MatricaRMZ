/**
 * Sync module barrel export.
 *
 * Re-exports the public API that was previously in the monolithic syncService.ts.
 * Internal modules (pushCollector, pullApplicator, etc.) are not re-exported.
 */

// Re-export public API from the original syncService (orchestrator)
export { runSync, resetSyncState, resetLocalDatabase } from '../syncService.js';

// Re-export types
export type { SyncProgressEvent, RunSyncOptions, PendingPack } from './types.js';

// Re-export sub-modules for advanced usage
export { collectAllPending } from './pushCollector.js';
export { upsertPulledRows, payloadToDbRow } from './pullApplicator.js';
export { buildDiagnosticsSnapshot, sendDiagnosticsSnapshot } from './diagnosticsReporter.js';
export { createProgressEmitter, nowMs, yieldToEventLoop } from './progressEmitter.js';
export {
  markPendingError,
  dropPendingChatReads,
  isChatReadsDuplicateError,
  isDependencyMissingError,
  isConflictError,
  isInvalidRowError,
  isNotFoundSyncError,
} from './errorRecovery.js';
export { encryptRowSensitive, decryptRowSensitive, isE2eEnabled, getE2eKeys } from './e2eCrypto.js';
