import { describe, expect, it, vi } from 'vitest';

// makePrivacyRowFilter is pure, but the module imports db.js at load — stub it.
vi.mock('../../database/db.js', () => ({ db: {} }));

const { SyncTableName } = await import('@matricarmz/shared');
const { makePrivacyRowFilter, isPrivacyTable } = await import('./syncPrivacy.js');

const ME = 'user-me';
const OTHER = 'user-other';

const operator = (shared: string[] = [], owned: string[] = []) =>
  makePrivacyRowFilter(
    { id: ME, isAdmin: false, isPending: false },
    { sharedNoteIds: new Set(shared), ownedNoteIds: new Set(owned) },
  );

describe('isPrivacyTable', () => {
  it('flags chat/notes tables, not business/presence tables', () => {
    expect(isPrivacyTable(SyncTableName.ChatMessages)).toBe(true);
    expect(isPrivacyTable(SyncTableName.ChatReads)).toBe(true);
    expect(isPrivacyTable(SyncTableName.Notes)).toBe(true);
    expect(isPrivacyTable(SyncTableName.NoteShares)).toBe(true);
    expect(isPrivacyTable(SyncTableName.UserPresence)).toBe(false);
    expect(isPrivacyTable(SyncTableName.Entities)).toBe(false);
  });
});

describe('makePrivacyRowFilter — operator (non-admin)', () => {
  const f = operator();

  it('chat_messages: own sent / received / broadcast visible, others hidden', () => {
    expect(f(SyncTableName.ChatMessages, { sender_user_id: ME, recipient_user_id: OTHER })).toBe(true);
    expect(f(SyncTableName.ChatMessages, { sender_user_id: OTHER, recipient_user_id: ME })).toBe(true);
    expect(f(SyncTableName.ChatMessages, { sender_user_id: OTHER, recipient_user_id: null })).toBe(true); // общий чат
    expect(f(SyncTableName.ChatMessages, { sender_user_id: OTHER, recipient_user_id: undefined })).toBe(true);
    expect(f(SyncTableName.ChatMessages, { sender_user_id: OTHER, recipient_user_id: 'user-third' })).toBe(false);
  });

  it('chat_reads: only own', () => {
    expect(f(SyncTableName.ChatReads, { user_id: ME })).toBe(true);
    expect(f(SyncTableName.ChatReads, { user_id: OTHER })).toBe(false);
  });

  it('notes: own + shared-with-me, others hidden', () => {
    expect(f(SyncTableName.Notes, { id: 'n1', owner_user_id: ME })).toBe(true);
    expect(f(SyncTableName.Notes, { id: 'n2', owner_user_id: OTHER })).toBe(false);
    const fShared = operator(['n3']);
    expect(fShared(SyncTableName.Notes, { id: 'n3', owner_user_id: OTHER })).toBe(true);
  });

  it('note_shares: addressed to me + shares of my own notes, others hidden', () => {
    expect(f(SyncTableName.NoteShares, { note_id: 'n1', recipient_user_id: ME })).toBe(true);
    expect(f(SyncTableName.NoteShares, { note_id: 'n2', recipient_user_id: OTHER })).toBe(false);
    const fOwned = operator([], ['n5']);
    expect(fOwned(SyncTableName.NoteShares, { note_id: 'n5', recipient_user_id: OTHER })).toBe(true);
  });

  it('ai_chat_requests: only own visible', () => {
    expect(isPrivacyTable(SyncTableName.AiChatRequests)).toBe(true);
    expect(f(SyncTableName.AiChatRequests, { user_id: ME, status: 'pending' })).toBe(true);
    expect(f(SyncTableName.AiChatRequests, { user_id: OTHER, status: 'answered' })).toBe(false);
  });

  it('non-privacy tables pass through', () => {
    expect(f(SyncTableName.Entities, { id: 'e1' })).toBe(true);
    expect(f(SyncTableName.UserPresence, { user_id: OTHER })).toBe(true);
  });
});

describe('makePrivacyRowFilter — admin sees all, pending sees none', () => {
  const admin = makePrivacyRowFilter(
    { id: ME, isAdmin: true, isPending: false },
    { sharedNoteIds: new Set(), ownedNoteIds: new Set() },
  );
  const pending = makePrivacyRowFilter(
    { id: ME, isAdmin: false, isPending: true },
    { sharedNoteIds: new Set(), ownedNoteIds: new Set() },
  );

  it('admin: every privacy row visible', () => {
    expect(admin(SyncTableName.ChatMessages, { sender_user_id: OTHER, recipient_user_id: 'user-third' })).toBe(true);
    expect(admin(SyncTableName.Notes, { id: 'n2', owner_user_id: OTHER })).toBe(true);
  });

  it('pending: no privacy rows, business rows still pass', () => {
    expect(pending(SyncTableName.ChatMessages, { sender_user_id: OTHER, recipient_user_id: null })).toBe(false);
    expect(pending(SyncTableName.Notes, { id: 'n1', owner_user_id: ME })).toBe(false);
    expect(pending(SyncTableName.Entities, { id: 'e1' })).toBe(true);
  });
});
