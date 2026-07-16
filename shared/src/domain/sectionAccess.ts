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
  /**
   * Подписи уровней для разделов с НЕСТАНДАРТНОЙ семантикой (инцидент fatyhova 2026-07-10:
   * владелец «расширял доступ», выдав editor «Нарядов закрытых», а editor там означает
   * «ограниченный владелец — видит ТОЛЬКО свои наряды»). Рендерятся в обоих редакторах
   * доступов; для обычных разделов не задаются (действует общая легенда наблюдатель/редактор).
   */
  levelHintsRu?: { viewer: string; editor: string };
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
    levelHintsRu: {
      viewer: 'читает закрытые наряды всех ограниченных владельцев (напр., бухгалтерия)',
      editor:
        '⚠️ ограниченный ВЛАДЕЛЕЦ: его наряды скрыты от остальных, и сам он видит ТОЛЬКО свои наряды — это НЕ «больше доступа»',
    },
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
    menuTabs: ['reports', 'custom_reports', 'workshop_stats'],
  },
  {
    id: AccessSection.Directories,
    titleRu: 'Справочники',
    menuTabs: ['masterdata', 'workshops', 'warehouses_admin', 'empty_cards'],
  },
  {
    id: AccessSection.Administration,
    titleRu: 'Администрирование',
    // «Изменения» (changes) и «Черновики» (drafts) сознательно ВНЕ разделов: ими
    // пользуются все роли сегодня — гейтить их значило бы менять поведение в день засева.
    menuTabs: ['audit', 'admin'],
    restrictedAssign: true,
  },
] as const;

const SECTION_IDS = new Set<string>(ACCESS_SECTION_CATALOG.map((s) => s.id));

export function accessSectionMeta(id: string): AccessSectionMeta | null {
  return ACCESS_SECTION_CATALOG.find((s) => s.id === id) ?? null;
}

/**
 * Тема H (owner-батч 2026-07-10): статическая карта «раздел X требует ещё раздел Y для
 * полноценной работы». Источник — фактические сквозные lookup'ы, гейтящиеся по entity-типу
 * чужого раздела (sectionGate ENTITY_TYPE_SECTION / PREFIX_RULES): карточка двигателя тянет
 * контракты (production→contracts), наряды — двигатели (work_orders→production), карточка
 * договора — двигатели/марки (contracts→production), заявка — номенклатуру (supply→warehouse).
 * Уровня `viewer` достаточно (гейт чтения требует только viewer). Подсказка предлагается при
 * ВЫДАЧЕ раздела; решение за оператором (можно отказаться — данные, требующие Y, он не заполнит).
 *
 * ⚠️ Держать в синхроне с sectionGate.ts (ENTITY_TYPE_SECTION / PREFIX_RULES): при изменении
 * гейтящихся lookup'ов обновлять эту карту.
 */
export type SectionDependency = { section: AccessSection; level: SectionAccessLevel; reasonRu: string };

export const SECTION_DEPENDENCIES: Readonly<Partial<Record<AccessSection, ReadonlyArray<SectionDependency>>>> = {
  [AccessSection.Production]: [
    { section: AccessSection.Contracts, level: 'viewer', reasonRu: 'в карточке двигателя поле «Контракт» ищет договоры' },
  ],
  [AccessSection.WorkOrders]: [
    { section: AccessSection.Production, level: 'viewer', reasonRu: 'в наряде выбирается двигатель из справочника' },
  ],
  [AccessSection.Contracts]: [
    { section: AccessSection.Production, level: 'viewer', reasonRu: 'в карточке договора видны двигатели и марки' },
  ],
  [AccessSection.Supply]: [
    { section: AccessSection.Warehouse, level: 'viewer', reasonRu: 'в заявке подбирается номенклатура склада' },
  ],
};

/**
 * Недостающие зависимости для раздела, которому ВЫДАЮТ доступ: элементы SECTION_DEPENDENCIES[sectionId],
 * которых ещё нет в membership (viewer покрывается и editor'ом). Пусто → подсказывать нечего.
 */
export function missingSectionDependencies(membership: SectionMembership, sectionId: AccessSection): SectionDependency[] {
  const deps = SECTION_DEPENDENCIES[sectionId];
  if (!deps || deps.length === 0) return [];
  return deps.filter((dep) => {
    const current = membership[dep.section];
    // Любой уровень (viewer/editor) удовлетворяет требование viewer.
    return !current;
  });
}

/**
 * Tolerant parse of the `section_access` attribute value: object, JSON string,
 * or DOUBLE-encoded JSON string (setEntityAttribute JSON.stringify's the already
 * serialized membership — prod backfill 2026-07-03 stores it that way).
 */
export function parseSectionMembership(raw: unknown): SectionMembership {
  let obj: unknown = raw;
  for (let depth = 0; typeof obj === 'string' && depth < 2; depth += 1) {
    try {
      obj = JSON.parse(obj);
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

/**
 * Ф3 write-gate: which section OWNS a ledger write, keyed by the resolved
 * entity_type code (entities / attribute_values rows). Mirrors the Ф2 client
 * IPC map (sectionGate.ts PREFIX_RULES). Deliberately NOT mapped (fail-open):
 * tool/tool_property/tool_catalog (one namespace shared by production and
 * supply), workshop/section/department/store/link_field_rule (already
 * superadmin-only in ledgerAuthz), and social/per-owner rows.
 */
export const LEDGER_SECTION_BY_ENTITY_TYPE: Readonly<Record<string, AccessSection>> = {
  engine: AccessSection.Production,
  engine_node: AccessSection.Production,
  part: AccessSection.Production,
  part_template: AccessSection.Production,
  part_engine_brand: AccessSection.Production,
  engine_brand: AccessSection.Production,
  nomenclature: AccessSection.Warehouse,
  service: AccessSection.Supply,
  contract: AccessSection.Contracts,
  customer: AccessSection.Contracts,
  employee: AccessSection.People,
  product: AccessSection.Directories,
  category: AccessSection.Directories,
  unit: AccessSection.Directories,
};

/** operations rows: supply requests → supply; everything else is engine-flow work. */
export const LEDGER_SECTION_BY_OPERATION_TYPE: Readonly<Record<string, AccessSection>> = {
  supply_request: AccessSection.Supply,
  work_order: AccessSection.WorkOrders,
};
const LEDGER_DEFAULT_OPERATION_SECTION: AccessSection = AccessSection.Production;

/** Non-EAV synced tables owned by one section (ERP warehouse/production tables). */
export const LEDGER_SECTION_BY_TABLE: Readonly<Record<string, AccessSection>> = {
  erp_nomenclature: AccessSection.Warehouse,
  // erp_reg_* NOT mapped: server-computed registers ('open' in ledgerAuthz) — stay fail-open.
  erp_engine_assembly_bom: AccessSection.Production,
  erp_engine_assembly_bom_lines: AccessSection.Production,
  erp_engine_assembly_bom_brand_links: AccessSection.Production,
  erp_engine_instances: AccessSection.Production,
};

/**
 * Section owning a single ledger write, or null when the write is outside the
 * section model (social rows, schema metadata, unmapped types — fail-open).
 * Same discriminator logic as ledgerWriteRequirement.
 */
export function sectionForLedgerWrite(args: {
  table: string;
  entityTypeCode?: string | null;
  operationType?: string | null;
}): AccessSection | null {
  if (args.table === 'entities' || args.table === 'attribute_values') {
    const code = (args.entityTypeCode ?? '').trim();
    return code ? (LEDGER_SECTION_BY_ENTITY_TYPE[code] ?? null) : null;
  }
  if (args.table === 'operations') {
    const op = (args.operationType ?? '').trim();
    if (!op) return LEDGER_DEFAULT_OPERATION_SECTION;
    return LEDGER_SECTION_BY_OPERATION_TYPE[op] ?? LEDGER_DEFAULT_OPERATION_SECTION;
  }
  return LEDGER_SECTION_BY_TABLE[args.table] ?? null;
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
