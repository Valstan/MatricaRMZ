/**
 * Справочники карточки наряда: сотрудники, услуги, двигатели, номенклатура.
 *
 * Одни и те же для всех карточек, а грузились при каждом открытии заново — и услуги вдобавок
 * поштучно (на проде 368 сущностей → 368 IPC-вызовов). Здесь они читаются один раз на процесс
 * и переиспользуются, пока не придёт свежая порция данных из синхронизации.
 *
 * Инвалидация: sync-пульс с `pulled > 0` (значит серверные данные поменялись) и TTL.
 * Локальные правки справочников идут через свои карточки — они дёргают `invalidateWorkOrderRefs`.
 */
import { subscribeLiveDataPulse } from './liveDataService.js';

import type { NomenclatureItemType } from '@matricarmz/shared';
import { NOMENCLATURE_ITEM_TYPE_HAS_STOCK } from '@matricarmz/shared';

export type ServiceInfo = {
  id: string;
  name: string;
  unit: string;
  priceRub: number;
  partIds: string[];
  engineBrandIds: string[];
};
export type EmployeeInfo = {
  id: string;
  displayName: string;
  fullName?: string;
  lastName?: string;
  firstName?: string;
  middleName?: string;
  personnelNumber?: string | null;
  departmentName?: string | null;
  workshopId?: string | null;
  position?: string | null;
  employmentStatus?: string | null;
};
export type EngineInfo = {
  id: string;
  engineNumber?: string;
  engineInternalNumber?: string;
  engineBrandId?: string | null;
  engineBrandName?: string;
  contractId?: string | null;
  customerId?: string | null;
};
export type PartInfo = { id: string; name: string; article?: string; sku?: string; itemType?: NomenclatureItemType };

export type WorkOrderRefs = {
  employees: EmployeeInfo[];
  services: ServiceInfo[];
  engines: EngineInfo[];
  parts: PartInfo[];
};

const EMPTY: WorkOrderRefs = { employees: [], services: [], engines: [], parts: [] };
const TTL_MS = 120_000;

let cached: { at: number; refs: WorkOrderRefs } | null = null;
let inflight: Promise<WorkOrderRefs> | null = null;

export function invalidateWorkOrderRefs(): void {
  cached = null;
}

subscribeLiveDataPulse((pulse) => {
  if (pulse.reason === 'sync_done' && Number(pulse.pulled ?? 0) > 0) invalidateWorkOrderRefs();
});

function safeNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}

async function loadEmployees(): Promise<EmployeeInfo[]> {
  const list = await window.matrica.employees.list().catch(() => [] as any[]);
  return (list as any[]).map((x): EmployeeInfo => ({
    id: String(x.id),
    displayName: String(x.displayName || x.fullName || x.id),
    ...(x.fullName ? { fullName: String(x.fullName) } : {}),
    ...(x.lastName ? { lastName: String(x.lastName) } : {}),
    ...(x.firstName ? { firstName: String(x.firstName) } : {}),
    ...(x.middleName ? { middleName: String(x.middleName) } : {}),
    personnelNumber: x.personnelNumber ? String(x.personnelNumber) : null,
    departmentName: x.departmentName ? String(x.departmentName) : null,
    workshopId: x.workshopId ? String(x.workshopId) : null,
    position: x.position ? String(x.position) : null,
    employmentStatus: x.employmentStatus ? String(x.employmentStatus) : null,
  }));
}

async function loadServices(): Promise<ServiceInfo[]> {
  const types = await window.matrica.admin.entityTypes.list().catch(() => [] as any[]);
  const serviceType = (types as any[]).find((x) => String(x.code) === 'service');
  if (!serviceType?.id) return [];
  const rows = await window.matrica.admin.entities
    .listByEntityTypeWithAttrs(String(serviceType.id))
    .catch(() => [] as Array<{ id: string; attributes: Record<string, unknown> }>);
  return rows
    .map((row): ServiceInfo => {
      const attrs = row.attributes ?? {};
      return {
        id: String(row.id),
        name: String(attrs.name ?? '').trim() || String(row.id),
        unit: String(attrs.unit || 'шт'),
        priceRub: Math.max(0, safeNum(attrs.price, 0)),
        partIds: normalizeStringArray(attrs.part_ids),
        engineBrandIds: normalizeStringArray(attrs.engine_brand_ids),
      };
    })
    .filter((x) => x.name.trim().length > 0 && x.name !== x.id);
}

async function loadEngines(): Promise<EngineInfo[]> {
  const list = await window.matrica.engines.list().catch(() => [] as any[]);
  return (list as any[]).map((e): EngineInfo => ({
    id: String(e.id),
    engineNumber: String(e.engineNumber ?? ''),
    engineInternalNumber: String(e.internalNumberFull ?? ''),
    engineBrandId: e.engineBrandId ? String(e.engineBrandId) : null,
    engineBrandName: String(e.engineBrand ?? ''),
    contractId: e.contractId ? String(e.contractId) : null,
    customerId: e.customerId ? String(e.customerId) : null,
  }));
}

/**
 * Изделия — из складской номенклатуры (единый источник истины): всё, у чего есть остатки,
 * т.е. всё кроме услуг. Сюда попадают и зеркала старых деталей (тот же UUID), и позиции,
 * забитые в номенклатуру напрямую.
 */
async function loadParts(): Promise<PartInfo[]> {
  const result = await window.matrica.warehouse.nomenclatureList({ limit: 5000 }).catch(() => null);
  if (!result || !result.ok || !Array.isArray(result.rows)) return [];
  return result.rows
    .filter((row: Record<string, unknown>) => {
      const itemType = String(row.itemType ?? '') as NomenclatureItemType;
      return Boolean(NOMENCLATURE_ITEM_TYPE_HAS_STOCK[itemType]) && Boolean(row.isActive ?? true);
    })
    .map((row: Record<string, unknown>): PartInfo => {
      const itemType = String(row.itemType ?? '') as NomenclatureItemType;
      // Реальный человеческий артикул — `code` (напр. 411-00-35А). `sku` у мигрированных зеркал —
      // авто-код вида DET-<id>, поэтому показываем/ищем по code, а sku оставляем только в поиске.
      const code = row.code ? String(row.code) : '';
      const sku = row.sku ? String(row.sku) : '';
      const article = code || sku;
      return {
        id: String(row.id),
        name: String(row.name ?? '').trim() || String(row.id),
        ...(article ? { article } : {}),
        ...(sku && sku !== article ? { sku } : {}),
        ...(itemType ? { itemType } : {}),
      };
    })
    .filter((p) => p.name.trim().length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export async function getWorkOrderRefs(opts?: { force?: boolean }): Promise<WorkOrderRefs> {
  if (opts?.force) invalidateWorkOrderRefs();
  const fresh = cached && Date.now() - cached.at < TTL_MS;
  if (fresh && cached) return cached.refs;
  // Две карточки, открытые подряд, ждут ОДНУ загрузку, а не запускают по своей.
  if (!inflight) {
    inflight = (async () => {
      const [employees, services, engines, parts] = await Promise.all([
        loadEmployees(),
        loadServices(),
        loadEngines(),
        loadParts(),
      ]);
      const refs: WorkOrderRefs = { employees, services, engines, parts };
      cached = { at: Date.now(), refs };
      return refs;
    })()
      .catch(() => EMPTY)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
