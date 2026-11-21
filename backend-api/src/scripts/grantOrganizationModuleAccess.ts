import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { inArray } from 'drizzle-orm';

import { ACCESS_SECTION_CATALOG, AccessSection, PermissionCode } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { userPermissions } from '../database/schema.js';
import { setEmployeeSectionAccessOne } from '../services/employeeAuthService.js';

/**
 * Доступ к организационному модулю и к «Детям» (задание владельца 21.11.2026).
 *
 * - **Организационный отдел** (мероприятия, журнал выдачи подарков, призов, грамот)
 *   видят ВСЕ, кто работает в программе, но вести его может только хозяин модуля;
 * - **«Дети»** и данные о детях видит только суперадмин и хозяин модуля.
 *
 * Что делает скрипт:
 * 1. якоря разделов в `access_sections` (без них запись в `user_section_access` падает
 *    по FK, а раздел не выдаётся никогда);
 * 2. права: кругу — личные override'ы `children.view`, `children.edit`,
 *    `organization.edit`; у остальных личные выдачи этих прав отбираются;
 * 3. раздел `organization` — всем живым аккаунтам с заданным membership (viewer, кругу —
 *    editor), раздел `children` — только кругу (editor), у остальных он снимается.
 *
 * Запись разделов идёт канонической дверью `setEmployeeSectionAccessOne`: база и запись
 * — в строгой `user_section_access`, клиент читает membership оттуда (триггеры зеркала
 * EAV→strict сняты на R4b, EAV-запись до парка не доедет).
 *
 * Логины круга — только аргументом запуска (D-041: в репозитории их быть не может).
 *
 *   corepack pnpm -F @matricarmz/backend-api access:grant-org -- --logins=<логин1,логин2>
 *   corepack pnpm -F @matricarmz/backend-api access:grant-org:apply -- --logins=...
 */
const PERMISSION_GRANTS = [PermissionCode.ChildrenView, PermissionCode.ChildrenEdit, PermissionCode.OrganizationEdit];
const SECTION_ORGANIZATION = AccessSection.Organization;
const SECTION_CHILDREN = AccessSection.Children;

export type SectionLevel = 'viewer' | 'editor' | null;

export type AccessPlan = {
  /** Уровень раздела: null = снять раздел. */
  sections: Record<string, SectionLevel>;
  /** Права круга: true = выдать, false = отобрать. */
  permissions: Record<string, boolean>;
  isOwner: boolean;
};

/**
 * Чистая часть: что должно быть у аккаунта. `owner` — хозяин модуля: он ведёт и
 * организационный отдел, и «Дети»; остальные видят организационный отдел и не видят
 * «Детей».
 */
export function planForLogin(login: string, owners: ReadonlySet<string>): AccessPlan {
  const isOwner = owners.has(String(login ?? '').trim().toLowerCase());
  return {
    isOwner,
    permissions: Object.fromEntries(PERMISSION_GRANTS.map((code) => [code, isOwner])),
    sections: {
      [SECTION_ORGANIZATION]: isOwner ? 'editor' : 'viewer',
      [SECTION_CHILDREN]: isOwner ? 'editor' : null,
    },
  };
}

function log(...args: unknown[]) {
  console.log(...args);
}

function loginsFromArg(flag: string): ReadonlySet<string> {
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

type Account = {
  id: string;
  login: string;
  role: string;
  hasAnySection: boolean;
  /** Текущие уровни разделов (канон — строгая таблица). */
  sections: Map<string, string>;
  /** Текущие личные override'ы прав: код → allowed. */
  permissions: Map<string, boolean>;
};

async function loadAccounts(): Promise<Account[]> {
  const r = await pool.query(
    `select u.id::text as id,
            u.login,
            u.system_role as role,
            (select count(*)::int from user_section_access any_s
              where any_s.user_id = u.id and any_s.deleted_at is null) as section_count
       from users u
      where u.deleted_at is null
      order by u.login`,
  );
  const accounts: Account[] = r.rows.map((row: any) => ({
    id: String(row.id),
    login: String(row.login ?? '').trim(),
    role: String(row.role ?? '').trim(),
    hasAnySection: Number(row.section_count ?? 0) > 0,
    sections: new Map(),
    permissions: new Map(),
  }));
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const sections = await pool.query(
    `select user_id::text as user_id, section_id, level from user_section_access
      where deleted_at is null and section_id = any($1)`,
    [[SECTION_ORGANIZATION, SECTION_CHILDREN]],
  );
  for (const row of sections.rows as any[]) {
    byId.get(String(row.user_id))?.sections.set(String(row.section_id), String(row.level));
  }

  const perms = await db
    .select({ userId: userPermissions.userId, permCode: userPermissions.permCode, allowed: userPermissions.allowed })
    .from(userPermissions)
    .where(inArray(userPermissions.permCode, PERMISSION_GRANTS as any));
  for (const row of perms as any[]) {
    byId.get(String(row.userId))?.permissions.set(String(row.permCode), row.allowed === true);
  }

  return accounts;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const owners = loginsFromArg('--logins');

  const accounts = await loadAccounts();
  const missing = [...owners].filter((login) => !accounts.some((a) => a.login.toLowerCase() === login));
  if (missing.length > 0) {
    console.error(`логины не найдены в базе: ${missing.join(', ')} — ничего не записано`);
    process.exit(1);
  }
  log(`хозяева модуля: ${[...owners].join(', ')}`);

  // Якоря разделов: без строки в `access_sections` запись в `user_section_access`
  // падает по FK (а зеркало EAV выбрасывало бы раздел молча). Новый раздел = INSERT,
  // а не миграция схемы (0086).
  const anchor = await pool.query('select id from access_sections', []);
  const anchored = new Set(anchor.rows.map((r: any) => String(r.id)));
  const missingAnchors = ACCESS_SECTION_CATALOG.map((s) => s.id).filter((id) => !anchored.has(id));
  if (missingAnchors.length > 0) {
    if (apply) {
      for (const id of missingAnchors) {
        await pool.query('insert into access_sections (id) values ($1) on conflict (id) do nothing', [id]);
      }
      log(`+ якоря разделов в access_sections созданы: ${missingAnchors.join(', ')}`);
    } else {
      log(`(dry-run) якоря разделов в access_sections отсутствуют и будут созданы при --apply: ${missingAnchors.join(', ')}`);
    }
  } else {
    log('якоря всех разделов каталога на месте');
  }

  const ts = Date.now();
  let granted = 0;
  let revoked = 0;
  let sectionsSet = 0;
  let failed = 0;

  for (const acc of accounts) {
    const plan = planForLogin(acc.login, owners);
    const isSuperadmin = acc.role === 'superadmin';
    const login = acc.login;

    // Права: суперадмину не пишем (overrides на него не читаются — право и так есть).
    if (!isSuperadmin) {
      for (const [code, want] of Object.entries(plan.permissions)) {
        const current = acc.permissions.get(code) === true;
        if (want === current) continue;
        if (want) granted += 1;
        else revoked += 1;
        log(`   ${login}: право ${code} → ${want ? 'выдать' : 'отобрать'}`);
        if (!apply) continue;
        await db
          .insert(userPermissions)
          .values({ id: randomUUID(), userId: acc.id as any, permCode: code as any, allowed: want, createdAt: ts })
          .onConflictDoUpdate({
            target: [userPermissions.userId, userPermissions.permCode],
            set: { allowed: want, createdAt: ts },
          });
      }
    }

    // Разделы: organizational — всем с заданным membership, children — только кругу.
    // Суперадмин обходит разделы по роли; аккаунт без membership читается как fail-open.
    if (isSuperadmin) continue;
    if (!acc.hasAnySection) continue;
    for (const [sectionId, level] of Object.entries(plan.sections)) {
      const current = acc.sections.get(sectionId) ?? null;
      if (current === level) continue;
      sectionsSet += 1;
      log(`   ${login}: раздел ${sectionId} → ${level ?? 'снять'}`);
      if (!apply) continue;
      const res = await setEmployeeSectionAccessOne(acc.id, sectionId, level);
      if (!res.ok) {
        failed += 1;
        log(`   ✗ ${login} [${sectionId}]: ${(res as any).error}`);
        continue;
      }
    }
  }

  log(
    `\n${apply ? 'ЗАПИСАНО' : 'DRY-RUN'}: прав выдано=${granted}, прав отобрано=${revoked}, разделов изменено=${sectionsSet}, ошибок=${failed}`,
  );
  if (!apply) log('(dry-run — записей не было; повторите с --apply)');
  await pool.end();
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('grantOrganizationModuleAccess.ts');
if (isDirectRun) {
  main().catch(async (e) => {
    console.error('FATAL:', e);
    try {
      await pool.end();
    } catch {
      // ignore
    }
    process.exit(1);
  });
}
