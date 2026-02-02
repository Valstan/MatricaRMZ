import { apiJson } from './client.js';

export function getLatestUpdateInfo() {
  return apiJson('/updates/latest', { method: 'GET' });
}

export function getUpdateStatus() {
  return apiJson('/updates/status', { method: 'GET' });
}

export function getLatestUpdateMeta() {
  return apiJson('/updates/latest-meta', { method: 'GET' });
}
