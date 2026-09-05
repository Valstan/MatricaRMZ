import { createHash } from 'node:crypto';
import type { LedgerTxPayload } from './types.js';
import { canonicalizeTxPayload } from './types.js';

/** Стабильный id транзакции журнала — хэш канонической формы полезной нагрузки. */
export function hashTxPayload(payload: LedgerTxPayload): string {
  return createHash('sha256').update(canonicalizeTxPayload(payload)).digest('hex');
}
