import { apiJson } from './client.js';

const RAW_READ_SOURCE = String((import.meta as any).env?.VITE_MASTERDATA_READ_SOURCE ?? 'server').toLowerCase();
const USE_LEDGER_READ = RAW_READ_SOURCE === 'ledger';
export const MASTERDATA_READ_SOURCE = (USE_LEDGER_READ ? 'ledger' : 'server') as 'ledger' | 'server';

function parseValueJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toQuery(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function ledgerQuery(args: {
  table: string;
  filter?: Record<string, string>;
  orFilter?: Array<Record<string, string>>;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  includeDeleted?: boolean;
}) {
  const qs = toQuery({
    table: args.table,
    ...(args.filter ? { filter: JSON.stringify(args.filter) } : {}),
    ...(args.orFilter && args.orFilter.length > 0 ? { or_filter: JSON.stringify(args.orFilter) } : {}),
    ...(args.sortBy ? { sort_by: args.sortBy } : {}),
    ...(args.sortDir ? { sort_dir: args.sortDir } : {}),
    ...(args.limit != null ? { limit: args.limit } : {}),
    ...(args.includeDeleted != null ? { include_deleted: args.includeDeleted ? 'true' : 'false' } : {}),
  });
  return await apiJson(`/ledger/state/query${qs}`, { method: 'GET' });
}

export function listEntityTypes() {
  if (!USE_LEDGER_READ) {
    return apiJson('/admin/masterdata/entity-types', { method: 'GET' });
  }
  return (async () => {
    const r = await ledgerQuery({
      table: 'entity_types',
      sortBy: 'code',
      sortDir: 'asc',
      includeDeleted: false,
      limit: 20000,
    });
    if (!(r as any)?.ok) return await apiJson('/admin/masterdata/entity-types', { method: 'GET' });
    const rows = Array.isArray((r as any).rows) ? (r as any).rows : [];
    return {
      ok: true as const,
      rows: rows.map((x: any) => ({
        id: String(x.id),
        code: String(x.code ?? ''),
        name: String(x.name ?? ''),
        updatedAt: Number(x.updated_at ?? 0),
        deletedAt: x.deleted_at == null ? null : Number(x.deleted_at),
      })),
      source: MASTERDATA_READ_SOURCE,
    };
  })();
}

export function upsertEntityType(args: { id?: string; code: string; name: string }) {
  return apiJson('/admin/masterdata/entity-types', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function getEntityTypeDeleteInfo(id: string) {
  return apiJson(`/admin/masterdata/entity-types/${encodeURIComponent(id)}/delete-info`, { method: 'GET' });
}

export function deleteEntityType(id: string, args: { deleteEntities: boolean; deleteDefs: boolean }) {
  return apiJson(`/admin/masterdata/entity-types/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function listAttributeDefs(entityTypeId: string) {
  if (!USE_LEDGER_READ) {
    return apiJson(`/admin/masterdata/attribute-defs?entityTypeId=${encodeURIComponent(entityTypeId)}`, { method: 'GET' });
  }
  return (async () => {
    const r = await ledgerQuery({
      table: 'attribute_defs',
      filter: { entity_type_id: String(entityTypeId) },
      sortBy: 'sort_order',
      sortDir: 'asc',
      includeDeleted: false,
      limit: 20000,
    });
    if (!(r as any)?.ok) {
      return await apiJson(`/admin/masterdata/attribute-defs?entityTypeId=${encodeURIComponent(entityTypeId)}`, { method: 'GET' });
    }
    const rows = Array.isArray((r as any).rows) ? (r as any).rows : [];
    return {
      ok: true as const,
      rows: rows.map((x: any) => ({
        id: String(x.id),
        entityTypeId: String(x.entity_type_id),
        code: String(x.code ?? ''),
        name: String(x.name ?? ''),
        dataType: String(x.data_type ?? 'text'),
        isRequired: !!x.is_required,
        sortOrder: Number(x.sort_order ?? 0),
        metaJson: x.meta_json == null ? null : String(x.meta_json),
        updatedAt: Number(x.updated_at ?? 0),
        deletedAt: x.deleted_at == null ? null : Number(x.deleted_at),
      })),
      source: MASTERDATA_READ_SOURCE,
    };
  })();
}

export function upsertAttributeDef(args: {
  id?: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  isRequired?: boolean;
  sortOrder?: number;
  metaJson?: string | null;
}) {
  return apiJson('/admin/masterdata/attribute-defs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function getAttributeDefDeleteInfo(id: string) {
  return apiJson(`/admin/masterdata/attribute-defs/${encodeURIComponent(id)}/delete-info`, { method: 'GET' });
}

export function deleteAttributeDef(id: string, args: { deleteValues: boolean }) {
  return apiJson(`/admin/masterdata/attribute-defs/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function listEntities(entityTypeId: string) {
  if (!USE_LEDGER_READ) {
    return apiJson(`/admin/masterdata/entities?entityTypeId=${encodeURIComponent(entityTypeId)}`, { method: 'GET' });
  }
  return (async () => {
    const [entitiesRes, defsRes] = await Promise.all([
      ledgerQuery({
        table: 'entities',
        filter: { type_id: String(entityTypeId) },
        sortBy: 'updated_at',
        sortDir: 'desc',
        includeDeleted: false,
        limit: 20000,
      }),
      ledgerQuery({
        table: 'attribute_defs',
        filter: { entity_type_id: String(entityTypeId) },
        sortBy: 'sort_order',
        sortDir: 'asc',
        includeDeleted: false,
        limit: 20000,
      }),
    ]);
    if (!(entitiesRes as any)?.ok || !(defsRes as any)?.ok) {
      return await apiJson(`/admin/masterdata/entities?entityTypeId=${encodeURIComponent(entityTypeId)}`, { method: 'GET' });
    }
    const entitiesRows = Array.isArray((entitiesRes as any).rows) ? (entitiesRes as any).rows : [];
    const defsRows = Array.isArray((defsRes as any).rows) ? (defsRes as any).rows : [];
    const labelDef =
      defsRows.find((d: any) => String(d.code) === 'name') ??
      defsRows.find((d: any) => String(d.code) === 'full_name') ??
      defsRows.find((d: any) => String(d.code) === 'number') ??
      defsRows.find((d: any) => String(d.code) === 'engine_number') ??
      null;

    const displayByEntity = new Map<string, string>();
    if (labelDef?.id) {
      const valuesRes = await ledgerQuery({
        table: 'attribute_values',
        filter: { attribute_def_id: String(labelDef.id) },
        includeDeleted: false,
        limit: 50000,
      });
      if ((valuesRes as any)?.ok) {
        const valuesRows = Array.isArray((valuesRes as any).rows) ? (valuesRes as any).rows : [];
        for (const row of valuesRows as any[]) {
          const value = parseValueJson(row.value_json);
          const text = value == null ? '' : String(value);
          if (text.trim()) displayByEntity.set(String(row.entity_id), text);
        }
      }
    }

    return {
      ok: true as const,
      rows: entitiesRows.map((x: any) => ({
        id: String(x.id),
        typeId: String(x.type_id),
        updatedAt: Number(x.updated_at ?? 0),
        syncStatus: String(x.sync_status ?? 'synced'),
        displayName: displayByEntity.get(String(x.id)) ?? '',
      })),
      source: MASTERDATA_READ_SOURCE,
    };
  })();
}

export function createEntity(entityTypeId: string) {
  return apiJson('/admin/masterdata/entities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityTypeId }),
  });
}

export function getEntity(id: string) {
  if (!USE_LEDGER_READ) {
    return apiJson(`/admin/masterdata/entities/${encodeURIComponent(id)}`, { method: 'GET' });
  }
  return (async () => {
    const entityRes = await ledgerQuery({
      table: 'entities',
      filter: { id: String(id) },
      includeDeleted: true,
      limit: 1,
    });
    if (!(entityRes as any)?.ok) {
      return await apiJson(`/admin/masterdata/entities/${encodeURIComponent(id)}`, { method: 'GET' });
    }
    const entity = Array.isArray((entityRes as any).rows) ? (entityRes as any).rows[0] : null;
    if (!entity?.id) return { ok: false as const, error: 'not found' };
    const typeId = String(entity.type_id ?? '');
    if (!typeId) return { ok: false as const, error: 'missing type_id' };

    const [defsRes, valuesRes] = await Promise.all([
      ledgerQuery({
        table: 'attribute_defs',
        filter: { entity_type_id: typeId },
        sortBy: 'sort_order',
        sortDir: 'asc',
        includeDeleted: false,
        limit: 20000,
      }),
      ledgerQuery({
        table: 'attribute_values',
        filter: { entity_id: String(id) },
        includeDeleted: false,
        limit: 50000,
      }),
    ]);
    if (!(defsRes as any)?.ok || !(valuesRes as any)?.ok) {
      return await apiJson(`/admin/masterdata/entities/${encodeURIComponent(id)}`, { method: 'GET' });
    }
    const defsRows = Array.isArray((defsRes as any).rows) ? (defsRes as any).rows : [];
    const valuesRows = Array.isArray((valuesRes as any).rows) ? (valuesRes as any).rows : [];
    const codeByDefId = new Map<string, string>(defsRows.map((d: any) => [String(d.id), String(d.code)]));
    const attributes: Record<string, unknown> = {};
    for (const row of valuesRows as any[]) {
      const code = codeByDefId.get(String(row.attribute_def_id));
      if (!code) continue;
      attributes[code] = parseValueJson(row.value_json);
    }
    return {
      ok: true as const,
      entity: {
        id: String(entity.id),
        typeId,
        createdAt: Number(entity.created_at ?? 0),
        updatedAt: Number(entity.updated_at ?? 0),
        deletedAt: entity.deleted_at == null ? null : Number(entity.deleted_at),
        syncStatus: String(entity.sync_status ?? 'synced'),
        attributes,
      },
      source: MASTERDATA_READ_SOURCE,
    };
  })();
}

export function setEntityAttr(id: string, code: string, value: unknown) {
  return apiJson(`/admin/masterdata/entities/${encodeURIComponent(id)}/set-attr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, value }),
  });
}

export function getEntityDeleteInfo(id: string) {
  return apiJson(`/admin/masterdata/entities/${encodeURIComponent(id)}/delete-info`, { method: 'GET' });
}

export function softDeleteEntity(id: string) {
  return apiJson(`/admin/masterdata/entities/${encodeURIComponent(id)}/soft-delete`, { method: 'POST' });
}

export function detachLinksAndDelete(id: string) {
  return apiJson(`/admin/masterdata/entities/${encodeURIComponent(id)}/detach-links-delete`, { method: 'POST' });
}

