import { apiJson } from './client.js';

export function listEntityTypes() {
  return apiJson('/admin/masterdata/entity-types', { method: 'GET' });
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
  return apiJson(`/admin/masterdata/attribute-defs?entityTypeId=${encodeURIComponent(entityTypeId)}`, { method: 'GET' });
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
  return apiJson(`/admin/masterdata/entities?entityTypeId=${encodeURIComponent(entityTypeId)}`, { method: 'GET' });
}

export function createEntity(entityTypeId: string) {
  return apiJson('/admin/masterdata/entities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityTypeId }),
  });
}

export function getEntity(id: string) {
  return apiJson(`/admin/masterdata/entities/${encodeURIComponent(id)}`, { method: 'GET' });
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

