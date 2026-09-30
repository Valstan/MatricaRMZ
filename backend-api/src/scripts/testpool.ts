import 'dotenv/config';
import { pool } from '../database/db.js';

async function main(): Promise<void> {
  process.stdout.write('Testing pool connection...\n');
  try {
    const result = await pool.query('select 1 as test');
    process.stdout.write(`Test query result: ${JSON.stringify(result.rows)}\n`);
  } catch (e) {
    process.stderr.write(`Error: ${String(e)}\n`);
  }
  process.stdout.write('Done\n');
  await pool.end();
}

main().catch((e) => {
  process.stderr.write(`Error: ${String(e)}\n`);
  process.exitCode = 1;
});