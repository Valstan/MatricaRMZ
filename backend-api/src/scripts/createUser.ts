import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { db, pool } from '../database/db.js';
import { entities } from '../database/schema.js';
import { hashPassword } from '../auth/password.js';
import { ensureEmployeeAuthDefs, getEmployeeAuthByLogin, getEmployeeTypeId, setEmployeeAuth, setEmployeeFullName } from '../services/employeeAuthService.js';

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
  const fullName = String(args.fullName ?? '').trim();

  if (!usernameRaw || !password) {
    console.error(
      'Usage: pnpm --filter @matricarmz/backend-api user:create -- --username <login> --password <pass> [--role admin|user] [--fullName "Name"]',
    );
    process.exit(2);
  }

  const login = usernameRaw.toLowerCase();
  const ts = nowMs();
  await ensureEmployeeAuthDefs();

  const passwordHash = await hashPassword(password);
  const existing = await getEmployeeAuthByLogin(login);
  if (existing) {
    await setEmployeeAuth(existing.id, { passwordHash, systemRole: role, accessEnabled: true, login });
    if (fullName) await setEmployeeFullName(existing.id, fullName);
    console.log(`Updated employee login: ${login} (id=${existing.id}, role=${role})`);
    return;
  }

  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) {
    console.error('Employee entity type not found');
    process.exit(1);
  }

  const id = randomUUID();
  await db.insert(entities).values({ id, typeId: employeeTypeId, createdAt: ts, updatedAt: ts, deletedAt: null, syncStatus: 'synced' });
  await setEmployeeAuth(id, { login, passwordHash, systemRole: role, accessEnabled: true });
  if (fullName) await setEmployeeFullName(id, fullName);

  console.log(`Created employee login: ${login} (id=${id}, role=${role})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });


