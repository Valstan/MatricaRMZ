import { apiJson } from './client.js';

export function presenceMe() {
  return apiJson('/presence/me', { method: 'GET' });
}
