/**
 * Section-based access (owner decision 2026-07-02, plan docs/plans/section-access-2026-07.md).
 *
 * The program is split into SECTIONS. Each section carries two user lists:
 * viewers (see everything, change nothing) and editors (full CRUD). A user not
 * listed in a section does not have that section at all — no menu tile, no
 * pulled data (Ф2), no writes (Ф3). Roles remain onboarding templates
 * (seedMembershipForRole); the section lists are the final word.
 *
 * Membership is stored per employee as the EAV attribute `section_access`:
 * a JSON object { [sectionId]: 'viewer' | 'editor' }. Absent key = no access.
 * Superadmin bypasses sections entirely (consistent with the rest of RBAC).
 */

export const SECTION_ACCESS_ATTR = 'section_access';

export const AccessSection = {
  Production: 'production',
  WorkOrders: 'work_orders',
  /** Ramzia's private work orders — generalization of workOrderAccess.ts hardcode (Ф3). */
  RestrictedWorkOrders: 'restricted_work_orders',
  Supply: 'supply',
  Warehouse: 'warehouse',
  Contracts: 'contracts',
  People: 'people',
  Reports: 'reports',
  /** Справочники (masterdata) — split from Administration so a technolog can keep editing them. */
  Directories: 'directories',
  /** Audit/admin pages — only the owner assigns people here. */
  Administration: 'administration',
} as const;
export type AccessSection = (typeof AccessSection)[keyof typeof AccessSection];

export type SectionAccessLevel = 'viewer' | 'editor';
export type SectionMembership = Partial<Record<AccessSection, SectionAccessLevel>>;

export type AccessSectionMeta = {
  id: AccessSection;
  titleRu: string;
  /** Menu tabs (Tabs.tsx MenuTabId) gated by this section — the Ф1 UI map. */
  menuTabs: readonly string[];
  /** Only the owner (superadmin) may add people to this section. */
  restrictedAssign?: boolean;
};

export const ACCESS_SECTION_CATALOG: readonly AccessSectionMeta[] = [
  {
    id: AccessSection.Production,
    titleRu: 'Производство',
    menuTabs: ['engines', 'assembly_forecast', 'engine_brands', 'parts', 'engine_assembly_bom', 'tools'],
  },
  {
    id: AccessSection.WorkOrders,
    titleRu: 'Наряды',
    menuTabs: ['work_orders', 'work_order_templates'],
  },
  {
    id: AccessSection.RestrictedWorkOrders,
    titleRu: 'Наряды закрытые (Рамзии)',
    menuTabs: [], // подмножество work_orders по owner-логину, не отдельный таб
    restrictedAssign: true,
  },
  {
    id: AccessSection.Supply,
    titleRu: 'Снабжение',
    menuTabs: ['requests', 'services', 'services_by_brand', 'tool_accounting'],
  },
  {
    id: AccessSection.Warehouse,
    titleRu: 'Склад',
    menuTabs: [
      'nomenclature',
      'parts_dedupe',
      'stock_balances',
      'warehouse_locations',
      'stock_documents',
      'stock_receipts',
      'stock_issues',
      'stock_transfers',
      'stock_inventory',
      'repair_fund_audit',
      'warehouse_analytics',
    ],
  },
  {
    id: AccessSection.Contracts,
    titleRu: 'Договоры и контрагенты',
    menuTabs: ['contracts', 'counterparties'],
  },
  {
    id: AccessSection.People,
    titleRu: 'Персонал',
    menuTabs: ['employees', 'timesheets'],
  },
  {
    id: AccessSection.Reports,
    titleRu: 'Отчёты и аналитика',
    menuTabs: ['reports', 'workshop_stats'],
  },
  {
    id: AccessSection.Directories,
    titleRu: 'Справочники',
    menuTabs: ['masterdata', 'workshops', 'warehouses_admin'],
  },
  {
    id: AccessSection.Administration,
    titleRu: 'Администрирование',
    menuTabs: ['audit', 'changes', 'admin', 'empty_cards', 'drafts'],
    restrictedAssign: true,
  },
] as const;

const SECTION_IDS = new Set<string>(ACCESS_SECTION_CATALOG.map((s) => s.id));

export function accessSectionMeta(id: string): AccessSectionMeta | null {
  return ACCESS_SECTION_CATALOG.find((s) => s.id === id) ?? null;
}

/** Tolerant parse of the `section_access` attribute value (JSON string or object). */
export function parseSectionMembership(raw: unknown): SectionMembership {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: SectionMembership = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (!SECTION_IDS.has(key)) continue;
    if (value === 'viewer' || value === 'editor') out[key as AccessSection] = value;
  }
  return out;
}

export function serializeSectionMembership(membership: SectionMembership): string {
  const out: Record<string, SectionAccessLevel> = {};
  for (const section of ACCESS_SECTION_CATALOG) {
    const level = membership[section.id];
    if (level) out[section.id] = level;
  }
  return JSON.stringify(out);
}

/**
 * Effective level in a section. Superadmin is editor everywhere (bypass);
 * everyone else — strictly by membership (roles only matter via seeding).
 */
export function sectionLevelFor(args: {
  membership: SectionMembership;
  role: string | null | undefined;
  sectionId: AccessSection;
}): SectionAccessLevel | null {
  if (String(args.role ?? '').trim().toLowerCase() === 'superadmin') return 'editor';
  return args.membership[args.sectionId] ?? null;
}

export function canViewSection(args: {
  membership: SectionMembership;
  role: string | null | undefined;
  sectionId: AccessSection;
}): boolean {
  return sectionLevelFor(args) != null;
}

export function canEditSection(args: {
  membership: SectionMembership;
  role: string | null | undefined;
  sectionId: AccessSection;
}): boolean {
  return sectionLevelFor(args) === 'editor';
}

const ALL_REGULAR_SECTIONS: readonly AccessSection[] = ACCESS_SECTION_CATALOG.filter(
  (s) => !s.restrictedAssign,
).map((s) => s.id);

function seedAll(level: SectionAccessLevel, overrides: SectionMembership = {}): SectionMembership {
  const out: SectionMembership = {};
  for (const id of ALL_REGULAR_SECTIONS) out[id] = level;
  return { ...out, ...overrides };
}

/**
 * Role → default membership: the auto-seed rule (day-one behavior must not
 * change for anyone) and the onboarding template for new users. Mirrors
 * today's factual footprint (OPERATOR_BASE_PERMISSIONS: broad view;
 * OPERATOR_ROLE_EDIT: edit in the role's work area). Restricted sections
 * (Ramzia orders, Administration) are never seeded by role — the backfill
 * script special-cases them by login/admin tier.
 */
export function seedMembershipForRole(role: string | null | undefined): SectionMembership {
  const r = String(role ?? '').trim().toLowerCase();
  switch (r) {
    case 'superadmin':
    case 'admin':
      return { ...seedAll('editor'), administration: 'editor' };
    case 'user': // legacy full-access tier — keep working as before
      return seedAll('editor');
    case 'engineer':
      return seedAll('viewer', { production: 'editor' });
    case 'technolog':
      return seedAll('viewer', { production: 'editor', directories: 'editor' });
    case 'master':
      return seedAll('viewer', { work_orders: 'editor', supply: 'editor' });
    case 'supply':
      return seedAll('viewer', { supply: 'editor' });
    case 'timekeeper':
      return seedAll('viewer', { people: 'editor' });
    case 'viewer':
      return seedAll('viewer');
    default: // pending / employee / unknown — no sections
      return {};
  }
}
