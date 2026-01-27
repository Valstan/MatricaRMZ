import type { ChatDeepLinkPayload } from '../ipc/types.js';

export type NoteImportance = 'normal' | 'important' | 'burning' | 'later';

export type NoteBlock =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'link'; label?: string; url?: string; appLink?: ChatDeepLinkPayload }
  | { id: string; kind: 'image'; fileId: string; name?: string; mime?: string };

export type NoteItem = {
  id: string;
  ownerUserId: string;
  title: string;
  body: NoteBlock[];
  importance: NoteImportance;
  dueAt: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type NoteShareItem = {
  id: string;
  noteId: string;
  recipientUserId: string;
  hidden: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};
