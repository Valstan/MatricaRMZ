import { apiJson } from './client.js';

export function listParts(args?: { q?: string; limit?: number; offset?: number; engineBrandId?: string }) {
  const params = new URLSearchParams();
  if (args?.q) params.set('q', args.q);
  if (args?.limit) {
    const normalizedLimit = Math.min(Math.max(1, Math.trunc(Number(args.limit))), 5000);
    params.set('limit', String(normalizedLimit));
  }
  if (args?.offset) {
    const normalizedOffset = Math.max(0, Math.trunc(Number(args.offset)));
    if (Number.isFinite(normalizedOffset)) params.set('offset', String(normalizedOffset));
  }
  if (args?.engineBrandId) params.set('engineBrandId', args.engineBrandId);
  const suffix = params.toString();
  return apiJson(`/parts${suffix ? `?${suffix}` : ''}`, { method: 'GET' });
}

export function createPart(args: { attributes?: Record<string, unknown> }) {
  return apiJson('/parts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
}

export function listBrandLinks(args: { partId: string; engineBrandId?: string }) {
  const partId = String(args.partId || '').trim();
  if (!partId) throw new Error('partId is required');
  const params = new URLSearchParams();
  if (args.engineBrandId) params.set('engineBrandId', args.engineBrandId);
  const suffix = params.toString();
  return apiJson(`/parts/${encodeURIComponent(partId)}/brand-links${suffix ? `?${suffix}` : ''}`, { method: 'GET' });
}
