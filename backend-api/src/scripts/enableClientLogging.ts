import { db } from '../database/db.js';
import { clientSettings } from '../database/schema.js';

async function main() {
  const ts = Date.now();
  await db
    .update(clientSettings)
    .set({ loggingEnabled: true, loggingMode: 'dev', updatedAt: ts });
  const rows = await db.select().from(clientSettings);
  const total = rows.length;
  const enabled = rows.filter((r) => r.loggingEnabled === true).length;
  const dev = rows.filter((r) => String(r.loggingMode) === 'dev').length;
  console.log(JSON.stringify({ ok: true, total, enabled, dev }));
}

main().catch((e) => {
  console.error(`enableClientLogging failed: ${String(e)}`);
  process.exit(1);
});
