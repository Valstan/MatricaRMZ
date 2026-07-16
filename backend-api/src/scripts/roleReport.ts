import 'dotenv/config';

import { pool } from '../database/db.js';
import { listEmployeesAuth, normalizeRole } from '../services/employeeAuthService.js';
import { SYSTEM_ROLE_CATALOG, systemRoleTitleRu } from '@matricarmz/shared';

// Read-only count-by-role report (security-hardening-2026-06 H7 step "а").
//
// Purpose: give the owner the numbers needed to decide the legacy-role
// migration (step "б": reassign live `user` accounts to explicit roles) and the
// fail-closed default flip (step "в"). Today only a per-user list exists
// (`/admin/users`) — there is no aggregate count surface.
//
// The `user` bucket tracks the legacy full-access tier plus role anomalies.
// Since H7 step (в) `normalizeRole` is fail-closed: only an EXPLICIT `user`
// role resolves to `user` (bypassing per-operation ledger authz — the
// ledgerAuthzGuard `!operatorScoped` branch); an UNKNOWN/typo/empty role now
// resolves to no-access `employee`. Unknown raw roles are still surfaced
// loudly — a typo no longer grants rights, but it silently REVOKES them.
//
// Usage (safe to run on prod — read-only):
//   pnpm -F @matricarmz/backend-api security:role-report
//   pnpm -F @matricarmz/backend-api security:role-report -- --json
//   pnpm -F @matricarmz/backend-api security:role-report -- --worklist 500

export type EmployeeAuthLike = {
  id: string;
  login: string;
  fullName?: string | null;
  systemRole?: string | null;
  accessEnabled: boolean;
};

export type RoleCount = { role: string; titleRu: string; active: number; disabled: number; total: number };

export type UserBucketEntry = {
  rawValue: string; // 'user' | '(empty)' | the unknown raw role string
  kind: 'legacy-user' | 'empty' | 'unknown';
  active: number;
  disabled: number;
  total: number;
};

export type WorklistRow = {
  id: string;
  login: string;
  fullName: string | null;
  rawRole: string;
  kind: 'legacy-user' | 'empty' | 'unknown';
};

export type RoleReport = {
  totalEmployees: number;
  byRole: RoleCount[];
  userBucket: {
    activeTotal: number; // live accounts in the bucket: explicit legacy `user` + fail-closed anomalies
    disabledTotal: number;
    breakdown: UserBucketEntry[];
    unknownRawRoles: string[]; // distinct unknown raw roles (fail-closed → employee, no access)
    worklist: WorklistRow[]; // live `user` accounts, for per-login migration (step б)
  };
};

const KNOWN_ROLE_ORDER = SYSTEM_ROLE_CATALOG.map((m) => m.key);

function rawRoleOf(row: EmployeeAuthLike): string {
  return String(row.systemRole ?? '').trim().toLowerCase();
}

function userBucketKind(rawRole: string): 'legacy-user' | 'empty' | 'unknown' {
  if (rawRole === '') return 'empty';
  if (rawRole === 'user') return 'legacy-user';
  return 'unknown';
}

/**
 * Pure aggregation over employee-auth rows. `worklistLimit` caps the per-user
 * worklist (live `user` accounts); the counts are never truncated.
 */
export function buildRoleReport(rows: EmployeeAuthLike[], worklistLimit = 1000): RoleReport {
  const counts = new Map<string, { active: number; disabled: number }>();
  const userBreakdown = new Map<string, { kind: 'legacy-user' | 'empty' | 'unknown'; active: number; disabled: number }>();
  const unknownRawRoles = new Set<string>();
  const worklist: WorklistRow[] = [];
  let userActive = 0;
  let userDisabled = 0;

  for (const row of rows) {
    const normalized = normalizeRole(row.login, row.systemRole);
    const active = row.accessEnabled === true;
    const bucket = counts.get(normalized) ?? { active: 0, disabled: 0 };
    if (active) bucket.active += 1;
    else bucket.disabled += 1;
    counts.set(normalized, bucket);

    // Bucket membership: explicit legacy `user` (still full access) plus
    // fail-closed anomalies — rows whose raw role is unknown/empty and only
    // resolve to `employee` via the normalizeRole default.
    const rawRole = rawRoleOf(row);
    const inBucket =
      normalized === 'user' || (normalized === 'employee' && rawRole !== 'employee');
    if (!inBucket) continue;

    const kind = userBucketKind(rawRole);
    const breakdownKey = kind === 'unknown' ? rawRole : kind === 'empty' ? '(empty)' : 'user';
    const b = userBreakdown.get(breakdownKey) ?? { kind, active: 0, disabled: 0 };
    if (active) b.active += 1;
    else b.disabled += 1;
    userBreakdown.set(breakdownKey, b);

    if (kind === 'unknown') unknownRawRoles.add(rawRole);
    if (active) {
      userActive += 1;
      if (worklist.length < worklistLimit) {
        worklist.push({
          id: row.id,
          login: row.login,
          fullName: row.fullName?.trim() ? row.fullName.trim() : null,
          rawRole: kind === 'empty' ? '(empty)' : rawRole,
          kind,
        });
      }
    } else {
      userDisabled += 1;
    }
  }

  // All catalog roles first (in catalog order), then any stray normalized role
  // not in the catalog (defensive — should not happen).
  const seen = new Set(counts.keys());
  const orderedRoles = [
    ...KNOWN_ROLE_ORDER.filter((r) => counts.has(r)),
    ...[...seen].filter((r) => !KNOWN_ROLE_ORDER.includes(r as (typeof KNOWN_ROLE_ORDER)[number])).sort(),
  ];
  const byRole: RoleCount[] = orderedRoles.map((role) => {
    const c = counts.get(role) ?? { active: 0, disabled: 0 };
    return { role, titleRu: systemRoleTitleRu(role), active: c.active, disabled: c.disabled, total: c.active + c.disabled };
  });

  const breakdown: UserBucketEntry[] = [...userBreakdown.entries()]
    .map(([rawValue, v]) => ({ rawValue, kind: v.kind, active: v.active, disabled: v.disabled, total: v.active + v.disabled }))
    // unknown first (most urgent), then legacy-user, then empty; by count desc
    .sort((a, z) => {
      const rank = (k: UserBucketEntry['kind']) => (k === 'unknown' ? 0 : k === 'legacy-user' ? 1 : 2);
      return rank(a.kind) - rank(z.kind) || z.total - a.total;
    });

  return {
    totalEmployees: rows.length,
    byRole,
    userBucket: {
      activeTotal: userActive,
      disabledTotal: userDisabled,
      breakdown,
      unknownRawRoles: [...unknownRawRoles].sort(),
      worklist,
    },
  };
}

function parseArgs(argv: string[]): { json: boolean; worklist: number; help: boolean } {
  const out = { json: false, worklist: 200, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--worklist') {
      const next = Number(argv[i + 1]);
      if (Number.isFinite(next) && next >= 0) {
        out.worklist = Math.trunc(next);
        i += 1;
      }
    } else if (arg.startsWith('--worklist=')) {
      const next = Number(arg.slice('--worklist='.length));
      if (Number.isFinite(next) && next >= 0) out.worklist = Math.trunc(next);
    }
  }
  return out;
}

function printHelp() {
  console.log(
    [
      'Usage: tsx src/scripts/roleReport.ts [--json] [--worklist N]',
      '',
      '  --json         Emit machine-readable JSON instead of a human report.',
      '  --worklist N   Cap the printed per-user migration worklist (default 200; counts are never capped).',
      '',
      'Read-only. Safe to run on prod. Reports how many live accounts resolve to each',
      'system role, with the `user` (legacy full-access) bucket broken down by raw stored value.',
    ].join('\n'),
  );
}

function printHumanReport(report: RoleReport): void {
  console.log(`Employees (active + disabled, excl. soft-deleted): ${report.totalEmployees}`);
  console.log('');
  console.log('Count by normalized role (as the runtime resolves it):');
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`  ${pad('role', 14)} ${pad('active', 8)} ${pad('disabled', 9)} total`);
  for (const r of report.byRole) {
    console.log(`  ${pad(r.role, 14)} ${pad(String(r.active), 8)} ${pad(String(r.disabled), 9)} ${r.total}   ${r.titleRu}`);
  }
  console.log('');

  const ub = report.userBucket;
  console.log(`Legacy/anomaly bucket — explicit \`user\` (full access) + unknown/empty roles (fail-closed, no access):`);
  console.log(`  live: ${ub.activeTotal}   disabled: ${ub.disabledTotal}`);
  if (ub.breakdown.length > 0) {
    console.log('  breakdown by raw stored system_role:');
    for (const b of ub.breakdown) {
      const tag = b.kind === 'unknown' ? '  ⚠ UNKNOWN (fail-closed → employee, no access)' : b.kind === 'empty' ? '  (no role attr, fail-closed)' : '  (explicit legacy user, full access)';
      console.log(`    "${b.rawValue}"  live=${b.active} disabled=${b.disabled} total=${b.total}${tag}`);
    }
  }
  if (ub.unknownRawRoles.length > 0) {
    console.log('');
    console.log(`  ⚠ ${ub.unknownRawRoles.length} unknown raw role value(s) — fail-closed to no access, fix the stored role: ${ub.unknownRawRoles.map((r) => `"${r}"`).join(', ')}`);
  }
  console.log('');

  if (ub.worklist.length > 0) {
    console.log(`Migration worklist — live bucket accounts to reassign, showing ${ub.worklist.length} of ${ub.activeTotal}:`);
    for (const w of ub.worklist) {
      const mark = w.kind === 'unknown' ? ' ⚠' : '';
      console.log(`  - ${w.login}  "${w.fullName ?? ''}"  raw=${w.rawRole}${mark}  (${w.id})`);
    }
  } else {
    console.log('Migration worklist: empty — no live account in the legacy/anomaly bucket.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    await pool.end();
    return;
  }
  try {
    const list = await listEmployeesAuth();
    if (!list.ok) {
      console.error(`failed to load employees: ${list.error}`);
      process.exitCode = 2;
      return;
    }
    const report = buildRoleReport(list.rows, args.worklist);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(report);
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('roleReport.ts');
if (isDirectRun) {
  void main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(2);
  });
}
