import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { db, pool } from '../database/db.js';
import { userPermissions } from '../database/schema.js';
import { PermissionCode } from '../auth/permissions.js';
import { listEmployeesAuth, normalizeRole } from '../services/employeeAuthService.js';

function nowMs() {
  return Date.now();
}

async function main() {
  const list = await listEmployeesAuth();
  if (!list.ok) {
    console.error(list.error || 'failed to load employees');
    process.exit(1);
  }

  const targets = [PermissionCode.ChatAdminView, PermissionCode.ChatExport];
  const ts = nowMs();

  let updated = 0;
  for (const row of list.rows) {
    const role = normalizeRole(row.login, row.systemRole);
    const isAdmin = role === 'admin' || role === 'superadmin';
    for (const permCode of targets) {
      const allowed = isAdmin;
      await db
        .insert(userPermissions)
        .values({ id: randomUUID(), userId: row.id, permCode, allowed, createdAt: ts })
        .onConflictDoUpdate({
          target: [userPermissions.userId, userPermissions.permCode],
          set: { allowed, createdAt: ts },
        });
      updated += 1;
    }
  }

  console.log(`chat permissions updated: ${updated}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
