import 'dotenv/config';

import { db, pool } from '../database/db.js';
import { permissions } from '../database/schema.js';
import { PermissionCode } from '../auth/permissions.js';

async function main() {
  const ts = Date.now();
  const codes = Object.values(PermissionCode);
  for (const code of codes) {
    await db
      .insert(permissions)
      .values({ code, description: code, createdAt: ts })
      .onConflictDoNothing();
  }
  console.log(`[perm:seed] ok count=${codes.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });


