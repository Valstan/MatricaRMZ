import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { db, pool } from './db.js';

async function main() {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[backend-api] migrations applied');
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});


