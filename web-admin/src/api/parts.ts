import { apiJson } from './client.js';

export function listParts(args?: { q?: string; limit?: number; engineBrandId?: string }) {
  const params = new URLSearchParams();
  if (args?.q) params.set('q', args.q);
  if (args?.limit) params.set('limit', String(args.limit));
  if (args?.engineBrandId) params.set('engineBrandId', args.engineBrandId);
  const suffix = params.toString();
  return apiJson(`/parts${suffix ? `?${suffix}` : ''}`, { method: 'GET' });
}
