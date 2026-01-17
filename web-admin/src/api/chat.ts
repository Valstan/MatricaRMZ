import { apiFetch, apiJson } from './client.js';

export function listChatUsers() {
  return apiJson('/chat/users', { method: 'GET' });
}

export function listMessages(args: { mode: 'global' | 'private'; withUserId?: string | null; limit?: number }) {
  const params = new URLSearchParams();
  params.set('mode', args.mode);
  if (args.withUserId) params.set('withUserId', args.withUserId);
  if (args.limit) params.set('limit', String(args.limit));
  return apiJson(`/chat/messages?${params.toString()}`, { method: 'GET' });
}

export function adminPair(args: { userAId: string; userBId: string; limit?: number }) {
  const params = new URLSearchParams();
  params.set('userAId', args.userAId);
  params.set('userBId', args.userBId);
  if (args.limit) params.set('limit', String(args.limit));
  return apiJson(`/chat/admin/pair?${params.toString()}`, { method: 'GET' });
}

export function sendText(args: { recipientUserId?: string | null; text: string }) {
  return apiJson('/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function sendLink(args: { recipientUserId?: string | null; link: any }) {
  return apiJson('/chat/send-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function sendFile(args: { recipientUserId?: string | null; fileId: string }) {
  return apiJson('/chat/send-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function unreadCount() {
  return apiJson('/chat/unread', { method: 'GET' });
}

export function markRead(messageIds: string[]) {
  return apiJson('/chat/mark-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageIds }),
  });
}

export function exportChats(startMs: number, endMs: number) {
  return apiJson(`/chat/export?startMs=${encodeURIComponent(startMs)}&endMs=${encodeURIComponent(endMs)}`, { method: 'GET' });
}

export async function fileMeta(fileId: string) {
  return apiJson(`/files/${encodeURIComponent(fileId)}/meta`, { method: 'GET' });
}

export async function fileUrl(fileId: string) {
  return apiJson(`/files/${encodeURIComponent(fileId)}/url`, { method: 'GET' });
}

export async function fileDownload(fileId: string) {
  const r = await apiFetch(`/files/${encodeURIComponent(fileId)}`, { method: 'GET' });
  return r;
}

export async function uploadSmallFile(file: File, scope?: { ownerType: string; ownerId: string; category: string }) {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('file read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.readAsDataURL(file);
  });
  return apiJson('/files/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mime: file.type || null, dataBase64, ...(scope ? { scope } : {}) }),
  });
}

export async function initLargeUpload(args: { name: string; size: number; sha256: string; mime?: string | null; scope?: { ownerType: string; ownerId: string; category: string } }) {
  return apiJson('/files/yandex/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

