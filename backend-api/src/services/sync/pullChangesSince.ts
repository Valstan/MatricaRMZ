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

  const last = rows.at(-1)?.serverSeq ?? since;

  return {
    server_cursor: last,
    changes: rows.map((r) => ({
      table: r.table as any,
      row_id: r.rowId,
      op: r.op as any,
      payload_json: r.payloadJson,
      server_seq: r.serverSeq,
    })),
  };
}


