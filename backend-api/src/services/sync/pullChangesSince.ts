import type { SyncPullResponse } from '@matricarmz/shared';
import { gt, asc } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { changeLog } from '../../database/schema.js';

export async function pullChangesSince(since: number): Promise<SyncPullResponse> {
  const rows = await db
    .select({
      table: changeLog.tableName,
      rowId: changeLog.rowId,
      op: changeLog.op,
      payloadJson: changeLog.payloadJson,
      serverSeq: changeLog.serverSeq,
    })
    .from(changeLog)
    .where(gt(changeLog.serverSeq, since))
    .orderBy(asc(changeLog.serverSeq))
    .limit(5000);

  // Filter out test/bulk artifacts (historical bench data) so new clients don't pull them.
  // We keep this logic server-side to protect all clients uniformly.
  function isBulkEntityTypePayload(payloadJson: string): boolean {
    try {
      const p = JSON.parse(payloadJson) as any;
      const code = String(p?.code ?? '');
      const name = String(p?.name ?? '');
      if (code.startsWith('t_bulk_')) return true;
      if (name.startsWith('Type Bulk ')) return true;
      return false;
    } catch {
      return false;
    }
  }

  const filtered = rows.filter((r) => {
    if (String(r.table) !== 'entity_types') return true;
    return !isBulkEntityTypePayload(String(r.payloadJson ?? ''));
  });

  // IMPORTANT: cursor must reflect the real last server_seq we observed,
  // even if we filtered some changes out, otherwise clients will "loop".
  const last = rows.at(-1)?.serverSeq ?? since;

  return {
    server_cursor: last,
    changes: filtered.map((r) => ({
      table: r.table as any,
      row_id: r.rowId,
      op: r.op as any,
      payload_json: r.payloadJson,
      server_seq: r.serverSeq,
    })),
  };
}


