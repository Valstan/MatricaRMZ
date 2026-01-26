import { apiJson } from './client.js';

export function publishRelease(args: {
  version: string;
  notes?: string;
  sha256?: string;
  fileName?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}) {
  return apiJson('/ledger/releases/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function getLatestRelease() {
  return apiJson('/ledger/releases/latest', { method: 'GET' });
}
