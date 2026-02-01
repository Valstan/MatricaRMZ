import { apiJson } from './client.js';

export function listAudit(params?: {
  limit?: number;
  fromMs?: number | null;
  toMs?: number | null;
  actor?: string | null;
}) {
  const p = new URLSearchParams();
  if (params?.limit) p.set('limit', String(params.limit));
  if (params?.fromMs != null) p.set('fromMs', String(params.fromMs));
  if (params?.toMs != null) p.set('toMs', String(params.toMs));
  if (params?.actor) p.set('actor', String(params.actor));
  const qs = p.toString();
  return apiJson(`/admin/audit/list${qs ? `?${qs}` : ''}`, { method: 'GET' });
}
