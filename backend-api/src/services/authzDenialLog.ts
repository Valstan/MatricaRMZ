/**
 * Authorization deny-log (RBAC #474, M3).
 *
 * Records permission denials as warn-level server critical events
 * (code `server.authz.denied`) so they land in the existing diagnostics store
 * (critical-events.ndjson + viewer + retention). This is the empirical loop:
 * during rollout we watch who got blocked "по ходу пьесы" and widen roles where
 * a legitimate scenario was missed. Login is stored; ФИО is resolved on read
 * (client-display rule). Dedup keeps a repeated denial from flooding.
 */
import { ingestServerCriticalEvent } from './criticalEventsService.js';

type Actor = { id: string; username?: string | null | undefined; role?: string | null | undefined };

const EVENT_CODE = 'server.authz.denied';
const TITLE = 'Отказ доступа оператору (RBAC)';

/** Ledger write-gate denials (one summary event per submit batch). */
export function recordLedgerAuthzDenial(actor: Actor, denied: Array<{ reason: string }>): void {
  if (denied.length === 0) return;
  const login = actor.username || actor.id;
  const types = [...new Set(denied.map((d) => d.reason.replace(/^forbidden:/, '')))].sort();
  ingestServerCriticalEvent({
    eventCode: EVENT_CODE,
    title: TITLE,
    humanMessage: `${login} (роль ${actor.role ?? '?'}) — запись отклонена: ${types.join(', ')} (${denied.length})`,
    category: 'auth',
    severity: 'warn',
    aiDetails: {
      source: 'ledger',
      login,
      actorId: actor.id,
      role: actor.role ?? null,
      deniedTypes: types,
      count: denied.length,
    },
    dedupMessage: `ledger:${login}:${types.join(',')}`,
  });
}

/** REST `requirePermission` 403 denials. */
export function recordRestAuthzDenial(actor: Actor, permCode: string, endpoint: string): void {
  const login = actor.username || actor.id;
  ingestServerCriticalEvent({
    eventCode: EVENT_CODE,
    title: TITLE,
    humanMessage: `${login} (роль ${actor.role ?? '?'}) — нет права ${permCode} на ${endpoint}`,
    category: 'auth',
    severity: 'warn',
    aiDetails: {
      source: 'rest',
      login,
      actorId: actor.id,
      role: actor.role ?? null,
      permCode,
      endpoint,
    },
    dedupMessage: `rest:${login}:${permCode}:${endpoint}`,
  });
}
