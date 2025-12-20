import { desc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { auditLog } from '../database/schema.js';

export async function listAudit(db: BetterSQLite3Database) {
  return db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(500);
}


