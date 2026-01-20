import { apiJson } from './client.js';

export function getLatestUpdateInfo() {
  return apiJson('/updates/latest', { method: 'GET' });
}
