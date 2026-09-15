import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { db, pool } from '../database/db.js';
import { userPermissions } from '../database/schema.js';
import { PermissionCode } from '../auth/permissions.js';
import { isSuperadminLogin, listEmployeesAuth } from '../services/employeeAuthService.js';

/**
 * Снять у всех пользователей права на ведомости работ (решение владельца 15.09.2026):
 * заполнение строк (`work_sheets.edit`) и ведение видов работ (`work_sheet_types.edit`).
 * Дальше владелец выдаёт их поимённо в web-admin. Просмотр не трогаем — он сидит на
 * `operations.view`.
 *
 * Пишем ЯВНЫЙ override `allowed=false` каждому, а не удаляем строки: роль admin /
 * легаси `user` после этого релиза права и так не даёт, но явный отказ виден в
 * админке как «настроено вручную» и держится независимо от будущих правок ролей.
 * Суперадмин-логин пропускается: для него overrides не читаются вовсе.
 *
 * Порядок на проде: сначала деплой backend (сидер при старте заводит новый код в
 * `permissions`, на него FK `user_permissions.perm_code`), потом этот скрипт.
 *
 *   corepack pnpm -F @matricarmz/backend-api perm:revoke-work-sheets          # dry-run
 *   corepack pnpm -F @matricarmz/backend-api perm:revoke-work-sheets:apply    # запись
 */
async function main() {
  const apply = process.argv.includes('--apply');
  const list = await listEmployeesAuth();
  if (!list.ok) {
    console.error(list.error || 'не удалось загрузить сотрудников');
    process.exit(1);
  }

  const targets = [PermissionCode.WorkSheetsEdit, PermissionCode.WorkSheetTypesEdit];
  const ts = Date.now();

  let planned = 0;
  let skippedSuperadmin = 0;
  for (const row of list.rows) {
    if (isSuperadminLogin(row.login)) {
      skippedSuperadmin += 1;
      continue;
    }
    for (const permCode of targets) {
      planned += 1;
      if (!apply) continue;
      await db
        .insert(userPermissions)
        .values({ id: randomUUID(), userId: row.id, permCode, allowed: false, createdAt: ts })
        .onConflictDoUpdate({
          target: [userPermissions.userId, userPermissions.permCode],
          set: { allowed: false, createdAt: ts },
        });
    }
  }

  const users = list.rows.length - skippedSuperadmin;
  console.log(
    `[ведомости: права] ${apply ? 'записано' : 'dry-run, будет записано'} отказов=${planned} (пользователей=${users}, суперадмин пропущен=${skippedSuperadmin})${apply ? '' : ' — запуск с --apply пишет'}`,
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
