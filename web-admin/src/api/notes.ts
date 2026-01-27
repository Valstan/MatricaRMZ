import { apiJson } from './client.js';

export function listNotes() {
  return apiJson('/notes/list', { method: 'GET' });
}

export function listNoteUsers() {
  return apiJson('/notes/users', { method: 'GET' });
}

export function upsertNote(args: {
  id?: string;
  title: string;
  body?: unknown[];
  importance?: 'normal' | 'important' | 'burning' | 'later';
  dueAt?: number | null;
  sortOrder?: number;
}) {
  return apiJson('/notes/upsert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function deleteNote(noteId: string) {
  return apiJson('/notes/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ noteId }),
  });
}

export function shareNote(noteId: string, recipientUserId: string) {
  return apiJson('/notes/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ noteId, recipientUserId }),
  });
}

export function unshareNote(noteId: string, recipientUserId: string) {
  return apiJson('/notes/unshare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ noteId, recipientUserId }),
  });
}

export function hideNote(noteId: string, hidden: boolean) {
  return apiJson('/notes/hide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ noteId, hidden }),
  });
}

export function reorderNote(args: { noteId: string; sortOrder: number; scope: 'owner' | 'shared' }) {
  return apiJson('/notes/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}
