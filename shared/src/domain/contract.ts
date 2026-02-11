// Contract sections structure (stored in contract.attributes.contract_sections as JSON).

export type ContractEngineBrandRow = {
  engineBrandId: string;
  qty: number;
  unitPrice: number;
};

export type ContractPartRow = {
  partId: string;
  qty: number;
  unitPrice: number;
};

export type ContractPrimarySection = {
  number: string;
  signedAt: number | null;
  dueAt: number | null;
  internalNumber: string;
  customerId: string | null;
  engineBrands: ContractEngineBrandRow[];
  parts: ContractPartRow[];
};

export type ContractAddonSection = {
  number: string;
  signedAt: number | null;
  dueAt: number | null;
  engineBrands: ContractEngineBrandRow[];
  parts: ContractPartRow[];
};

export type ContractSections = {
  primary: ContractPrimarySection;
  addons: ContractAddonSection[];
};

export const STATUS_CODES = [
  'status_rework_sent',
  'status_storage_received',
  'status_repair_started',
  'status_repaired',
  'status_customer_sent',
  'status_rejected',
] as const;

export type StatusCode = (typeof STATUS_CODES)[number];

export const STATUS_LABELS: Record<StatusCode, string> = {
  status_rework_sent: 'Отправлен заказчику на перекомплектацию',
  status_storage_received: 'Принят на хранение',
  status_repair_started: 'Начат ремонт',
  status_repaired: 'Отремонтирован',
  status_customer_sent: 'Отправлен заказчику',
  status_rejected: 'Забракован',
};

export function statusProgressPct(code: StatusCode | null | undefined): number {
  if (!code) return 0;
  switch (code) {
    case 'status_customer_sent':
    case 'status_rejected':
      return 100;
    case 'status_repaired':
      return 70;
    case 'status_repair_started':
      return 40;
    case 'status_storage_received':
      return 20;
    case 'status_rework_sent':
      return 10;
    default:
      return 0;
  }
}

export function computeObjectProgress(flags: Partial<Record<StatusCode, boolean>>): number {
  let max = 0;
  for (const code of STATUS_CODES) {
    if (flags[code]) {
      const p = statusProgressPct(code);
      if (p > max) max = p;
    }
  }
  return max;
}

export type ProgressLinkedItem = {
  contractId?: string | null;
  statusFlags?: Partial<Record<StatusCode, boolean>> | null;
};

export type ProgressAggregate = {
  sumStages: number;
  count: number;
  progress01: number | null;
  progressPct: number | null;
};

export function aggregateProgress(items: Array<Pick<ProgressLinkedItem, 'statusFlags'>>): ProgressAggregate {
  let sumStages = 0;
  let count = 0;
  for (const item of items) {
    if (!item.statusFlags) continue;
    sumStages += computeObjectProgress(item.statusFlags);
    count += 1;
  }
  return {
    sumStages,
    count,
    progress01: count > 0 ? sumStages / (count * 100) : null,
    progressPct: count > 0 ? sumStages / count : null,
  };
}

export function aggregateProgressByContract(items: ProgressLinkedItem[]): Record<string, ProgressAggregate> {
  const grouped: Record<string, Array<Pick<ProgressLinkedItem, 'statusFlags'>>> = {};
  for (const item of items) {
    const contractId = item.contractId ? String(item.contractId) : '';
    if (!contractId) continue;
    if (!grouped[contractId]) grouped[contractId] = [];
    grouped[contractId].push({ statusFlags: item.statusFlags ?? null });
  }

  const out: Record<string, ProgressAggregate> = {};
  for (const [contractId, group] of Object.entries(grouped)) {
    out[contractId] = aggregateProgress(group);
  }
  return out;
}

const defaultPrimary: ContractPrimarySection = {
  number: '',
  signedAt: null,
  dueAt: null,
  internalNumber: '',
  customerId: null,
  engineBrands: [],
  parts: [],
};

const defaultAddon: () => ContractAddonSection = () => ({
  number: '',
  signedAt: null,
  dueAt: null,
  engineBrands: [],
  parts: [],
});

export function parseContractSections(attrs: Record<string, unknown>): ContractSections {
  const raw = attrs.contract_sections;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const primary = obj.primary as ContractPrimarySection | undefined;
    const addons = Array.isArray(obj.addons) ? obj.addons : [];
    return {
      primary: primary && typeof primary.number === 'string'
        ? {
            number: String(primary.number),
            signedAt: typeof primary.signedAt === 'number' ? primary.signedAt : null,
            dueAt: typeof primary.dueAt === 'number' ? primary.dueAt : null,
            internalNumber: String(primary.internalNumber ?? primary.number ?? ''),
            customerId: primary.customerId != null ? String(primary.customerId) : null,
            engineBrands: Array.isArray(primary.engineBrands) ? primary.engineBrands.filter((r) => r && typeof r.engineBrandId === 'string') : [],
            parts: Array.isArray(primary.parts) ? primary.parts.filter((p) => p && typeof p.partId === 'string') : [],
          }
        : { ...defaultPrimary },
      addons: addons.map((a: unknown) => {
        const add = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
        return {
          number: String(add.number ?? ''),
          signedAt: typeof add.signedAt === 'number' ? add.signedAt : null,
          dueAt: typeof add.dueAt === 'number' ? add.dueAt : null,
          engineBrands: Array.isArray(add.engineBrands) ? (add.engineBrands as ContractEngineBrandRow[]).filter((r) => r && typeof r.engineBrandId === 'string') : [],
          parts: Array.isArray(add.parts) ? (add.parts as ContractPartRow[]).filter((p) => p && typeof p.partId === 'string') : [],
        };
      }),
    };
  }
  const primary: ContractPrimarySection = {
    ...defaultPrimary,
    number: String(attrs.number ?? ''),
    signedAt: typeof attrs.date === 'number' ? attrs.date : null,
    dueAt: typeof attrs.due_date === 'number' ? attrs.due_date : null,
    internalNumber: String(attrs.internal_number ?? ''),
    customerId: attrs.customer_id != null ? String(attrs.customer_id) : null,
  };
  return { primary, addons: [] };
}

export function contractSectionsToLegacy(sections: ContractSections): { number: string; internal_number: string; date: number | null } {
  const p = sections.primary;
  return {
    number: p.number,
    internal_number: p.internalNumber,
    date: p.signedAt,
  };
}
