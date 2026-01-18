import { apiJson } from './client.js';

export function listUsers() {
  return apiJson('/admin/users', { method: 'GET' });
}

export function createUser(args: { login: string; password: string; role: string; fullName?: string; accessEnabled?: boolean }) {
  return apiJson('/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function updateUser(
  userId: string,
  args: { role?: string; accessEnabled?: boolean; password?: string; login?: string; fullName?: string },
) {
  return apiJson(`/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function getUserPermissions(userId: string) {
  return apiJson(`/admin/users/${encodeURIComponent(userId)}/permissions`, { method: 'GET' });
}

export function setUserPermissions(userId: string, set: Record<string, boolean>) {
  return apiJson(`/admin/users/${encodeURIComponent(userId)}/permissions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set }),
  });
}

export function listUserDelegations(userId: string) {
  return apiJson(`/admin/users/${encodeURIComponent(userId)}/delegations`, { method: 'GET' });
}

export function createDelegation(args: {
  fromUserId: string;
  toUserId: string;
  permCode: string;
  startsAt?: number;
  endsAt: number;
  note?: string;
}) {
  return apiJson('/admin/delegations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function revokeDelegation(id: string, note?: string) {
  return apiJson(`/admin/delegations/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
}

