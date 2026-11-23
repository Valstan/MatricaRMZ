import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { and, eq, isNull, lte } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { permissionDelegations, userPermissions } from '../database/schema.js';
import { PermissionCode } from '../auth/permissions.js';
import { isSuperadminLogin, listEmployeesAuth } from '../services/employeeAuthService.js';

/**
 * Выдать `work_sheets.edit` узкому кругу (план favorites-work-stages-defaults-2026-10,
 * PR-6, решение владельца 12.10.2026): круг из трёх, названных владельцем вне
 * репозитория. У остальных — отобрать (явный override `allowed=false`, как в revoke
 * 15.09.2026: виден в админке как «настроено вручную» и держится независимо от
 * будущих правок ролей).
 *
 * Суперадмин — исключение: overrides на него не читаются вовсе (право и так есть
 * по роли), строка ему не пишется, в отчёте он идёт отдельной строкой.
 *
 * Логины — только аргументом запуска: в репозитории их быть не может (D-041).
 *
 *   corepack pnpm -F @matricarmz/backend-api perm:grant-worksheets-trio -- --editors=<логин1,логин2,логин3>
 *   corepack pnpm -F @matricarmz/backend-api perm:grant-worksheets-trio:apply -- --editors=...
 */
const PERM = PermissionCode.WorkSheetsEdit as any;

function editorsFromArg(flag: string): ReadonlySet<string> {
  const raw = process.argv.find((a) => a.startsWith(`${flag}=`));
  const list = (raw ? raw.slice(flag.length + 1) : '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) {
    console.error(`Нужен ${flag}=<логины через запятую> — состав круга в репозитории не хранится (D-041).`);
    process.exit(2);
  }
  return new Set(list);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const editors = editorsFromArg('--editors');
  const list = await listEmployeesAuth();
  if (!list.ok) {
    console.error(list.error || 'не удалось загрузить сотрудников');
    process.exit(1);
  }

  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const rows = list.rows as Array<{ id: unknown; login: unknown }>;
  const byLogin = new Map(rows.map((r) => [norm(r.login), r]));
  const missing = [...editors].filter((login) => !byLogin.has(login));
  if (missing.length > 0) {
    console.error(`логины не найдены в базе: ${missing.join(', ')} — ничего не записано`);
    process.exit(1);
  }

  const existing = await db
    .select({ userId: userPermissions.userId, allowed: userPermissions.allowed })
    .from(userPermissions)
    .where(and(eq(userPermissions.permCode, PERM)));
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
    const want = editors.has(norm(login));
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
      .values({ id: randomUUID(), userId: id as any, permCode: PERM, allowed: want, createdAt: ts })
      .onConflictDoUpdate({
        target: [userPermissions.userId, userPermissions.permCode],
        set: { allowed: want, createdAt: ts },
      });
  }

  console.log(
    `[этапы: доступ] ${apply ? 'записано' : 'dry-run, будет записано'}: выдать=${granted}, отобрать=${revoked}, уже верно=${alreadyOk} ` +
      `(суперадмин мимо overrides: ${superadmins.join(', ') || '—'})${apply ? '' : ' — запуск с --apply пишет'}`,
  );

  // Временные делегирования — второй путь к праву, мимо overrides. Только отчёт:
  // замещение на время отпуска авто-отзывом ломать нельзя, решение — за владельцем.
  const activeDelegations = await db
    .select({ toUserId: permissionDelegations.toUserId, endsAt: permissionDelegations.endsAt })
    .from(permissionDelegations)
    .where(
      and(
        eq(permissionDelegations.permCode, PERM),
        isNull(permissionDelegations.revokedAt),
        lte(permissionDelegations.startsAt, ts as any),
      ),
    );
  const loginById = new Map(rows.map((r) => [String((r as { id: unknown }).id ?? ''), String((r as { login: unknown }).login ?? '')]));
  const live = activeDelegations.filter((d) => Number(d.endsAt) >= ts);
  if (live.length === 0) {
    console.log('[этапы: доступ] активных делегирований work_sheets.edit нет');
  } else {
    for (const d of live) {
      const login = loginById.get(String(d.toUserId)) || String(d.toUserId).slice(0, 8);
      console.log(`[этапы: доступ] ДЕЛЕГИРОВАНО: ${login} до ${new Date(Number(d.endsAt)).toISOString().slice(0, 10)}`);
    }
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
