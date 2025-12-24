import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { users } from '../database/schema.js';
import { hashPassword } from '../auth/password.js';

function nowMs() {
  return Date.now();
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        args[k] = v;
        i++;
      } else {
        args[k] = 'true';
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const usernameRaw = String(args.username ?? '').trim();
  const password = String(args.password ?? '').trim();
  const role = String(args.role ?? 'admin').trim() || 'admin';

  if (!usernameRaw || !password) {
    console.error('Usage: pnpm --filter @matricarmz/backend-api user:create -- --username <name> --password <pass> [--role admin|user]');
    process.exit(2);
  }

  const username = usernameRaw.toLowerCase();
  const ts = nowMs();

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, username), isNull(users.deletedAt)))
    .limit(1);
  if (existing[0]) {
    console.error(`User already exists: ${username}`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  await db.insert(users).values({
    id,
    username,
    passwordHash,
    role,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  });

  console.log(`Created user: ${username} (id=${id}, role=${role})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });


