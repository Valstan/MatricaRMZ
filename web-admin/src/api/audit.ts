import { apiJson } from './client.js';

export function listAudit(params?: {
  limit?: number;
  fromMs?: number | null;
  toMs?: number | null;
  actor?: string | null;
  actionType?: 'create' | 'update' | 'delete' | 'session' | 'other' | null;
}) {
  const p = new URLSearchParams();
  if (params?.limit) p.set('limit', String(params.limit));
  if (params?.fromMs != null) p.set('fromMs', String(params.fromMs));
  if (params?.toMs != null) p.set('toMs', String(params.toMs));
  if (params?.actor) p.set('actor', String(params.actor));
  if (params?.actionType) p.set('actionType', String(params.actionType));
  const qs = p.toString();
  return apiJson(`/admin/audit/list${qs ? `?${qs}` : ''}`, { method: 'GET' });
}

export function dailyAuditSummary(params?: { date?: string; cutoffHour?: number }) {
  const p = new URLSearchParams();
  if (params?.date) p.set('date', params.date);
  if (params?.cutoffHour != null) p.set('cutoffHour', String(params.cutoffHour));
  const qs = p.toString();
  return apiJson(`/admin/audit/daily-summary${qs ? `?${qs}` : ''}`, { method: 'GET' });
}

export function getAuditStatisticsStatus() {
  return apiJson('/admin/audit/statistics-status', { method: 'GET' });
}
