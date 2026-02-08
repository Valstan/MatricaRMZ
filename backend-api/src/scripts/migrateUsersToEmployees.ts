import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { and, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { users } from '../database/schema.js';
import {
  createEmployeeEntity,
  ensureEmployeeAuthDefs,
  getEmployeeAuthByLogin,
  getEmployeeTypeId,
  setEmployeeAuth,
} from '../services/employeeAuthService.js';
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

async function ensureEmployeeEntity() {
  const id = randomUUID();
  const created = await createEmployeeEntity(id, nowMs());
  if (!created.ok) {
    throw new Error(created.error);
  }
  return id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const valstanPassword = String(args['valstan-password'] ?? '').trim();

  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) {
    console.error('Employee entity type not found');
    process.exit(1);
  }

  await ensureEmployeeAuthDefs();

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      passwordHash: users.passwordHash,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(and(isNull(users.deletedAt)))
    .limit(50_000);

  for (const u of rows as any[]) {
    const login = String(u.username || '').trim().toLowerCase();
    if (!login) continue;
    const existing = await getEmployeeAuthByLogin(login);
    const employeeId = existing?.id ?? (await ensureEmployeeEntity());
    await setEmployeeAuth(employeeId, {
      login,
      passwordHash: String(u.passwordHash ?? ''),
      systemRole: String(u.role ?? 'user').trim().toLowerCase(),
      accessEnabled: Boolean(u.isActive),
    });
    if (!existing) {
      console.log(`Created employee for login=${login} (id=${employeeId})`);
    } else {
      console.log(`Updated employee for login=${login} (id=${employeeId})`);
    }
  }

  const valstan = await getEmployeeAuthByLogin('valstan');
  if (!valstan) {
    const employeeId = await ensureEmployeeEntity();
    const passwordHash = valstanPassword ? await hashPassword(valstanPassword) : '';
    await setEmployeeAuth(employeeId, {
      login: 'valstan',
      passwordHash,
      systemRole: 'admin',
      accessEnabled: true,
    });
    console.log(`Created superadmin login=valstan (id=${employeeId})`);
  } else {
    const patch: { passwordHash?: string; systemRole?: string; accessEnabled?: boolean } = {
      systemRole: 'admin',
      accessEnabled: true,
    };
    if (!valstan.passwordHash && valstanPassword) {
      patch.passwordHash = await hashPassword(valstanPassword);
    }
    await setEmployeeAuth(valstan.id, patch);
    console.log(`Ensured superadmin login=valstan (id=${valstan.id})`);
  }

}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
