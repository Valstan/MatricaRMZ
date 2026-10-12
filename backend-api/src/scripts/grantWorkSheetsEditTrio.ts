import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { userPermissions } from '../database/schema.js';
import { PermissionCode } from '../auth/permissions.js';
import { isSuperadminLogin, listEmployeesAuth } from '../services/employeeAuthService.js';

/**
 * Выдать `work_sheets.edit` узкому кругу (план favorites-work-stages-defaults-2026-10,
 * PR-6, решение владельца 12.10.2026): valstan, sapegin, fatyhova. У остальных —
 * отобрать (явный override `allowed=false`, как в revoke 15.09.2026: виден в админке
 * как «настроено вручную» и держится независимо от будущих правок ролей).
 *
 * valstan — супер-админ: overrides на него не читаются вовсе (право и так есть
 * по роли), строка ему не пишется, в отчёте он идёт отдельной строкой.
 *
 *   corepack pnpm -F @matricarmz/backend-api perm:grant-worksheets-trio          # dry-run
 *   corepack pnpm -F @matricarmz/backend-api perm:grant-worksheets-trio:apply    # запись
 */
const TRIO = ['valstan', 'sapegin', 'fatyhova'];

async function main() {
  const apply = process.argv.includes('--apply');
  const list = await listEmployeesAuth();
  if (!list.ok) {
    console.error(list.error || 'не удалось загрузить сотрудников');
    process.exit(1);
  }

  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const rows = list.rows as Array<{ id: unknown; login: unknown }>;
  const byLogin = new Map(rows.map((r) => [norm(r.login), r]));
  const missing = TRIO.filter((login) => !byLogin.has(login));
  if (missing.length > 0) {
    console.error(`логины не найдены в базе: ${missing.join(', ')} — ничего не записано`);
    process.exit(1);
  }

  const existing = await db
    .select({ userId: userPermissions.userId, allowed: userPermissions.allowed })
    .from(userPermissions)
    .where(and(eq(userPermissions.permCode, PermissionCode.WorkSheetsEdit as any)));
  const current = new Map(existing.map((r) => [String(r.userId), !!r.allowed]));

  const ts = Date.now();
  let granted = 0;
  let revoked = 0;
  let alreadyOk = 0;
  const superadmins: string[] = [];

  for (const row of rows) {
    const login = String((row as { login: unknown }).login ?? '');
    const id = String((row as { id: unknown }).id ?? '');
    if (!id) continue;
    if (isSuperadminLogin(login)) {
      superadmins.push(login);
      continue;
    }
    const want = TRIO.includes(norm(login));
    const has = current.get(id) === true;
    if (want && has) {
      alreadyOk += 1;
      continue;
    }
    if (!want && !has) continue;
    if (want) granted += 1;
    else revoked += 1;
    if (!apply) continue;
    await db
      .insert(userPermissions)
      .values({ id: randomUUID(), userId: id as any, permCode: PermissionCode.WorkSheetsEdit as any, allowed: want, createdAt: ts })
      .onConflictDoUpdate({
        target: [userPermissions.userId, userPermissions.permCode],
        set: { allowed: want, createdAt: ts },
      });
  }

  console.log(
    `[этапы: доступ] ${apply ? 'записано' : 'dry-run, будет записано'}: выдать=${granted}, отобрать=${revoked}, уже верно=${alreadyOk} ` +
      `(суперадмин мимо overrides: ${superadmins.join(', ') || '—'})${apply ? '' : ' — запуск с --apply пишет'}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
