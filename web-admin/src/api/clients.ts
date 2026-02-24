import { apiJson } from './client.js';

export function listClients() {
  return apiJson('/admin/clients', { method: 'GET' });
}

export function updateClient(
  clientId: string,
  args: {
    updatesEnabled?: boolean;
    torrentEnabled?: boolean;
    loggingEnabled?: boolean;
    loggingMode?: 'dev' | 'prod';
  },
) {
  return apiJson(`/admin/clients/${encodeURIComponent(clientId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}
