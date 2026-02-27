import React, { useEffect, useMemo, useState } from 'react';

import type { NoteBlock, NoteImportance, NoteItem, NoteShareItem } from '@matricarmz/shared';

import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { deleteNote, hideNote, listNoteUsers, listNotes, reorderNote, shareNote, unshareNote, upsertNote } from '../api/notes.js';
import { fileUrl, uploadSmallFile } from '../api/chat.js';
import { formatMoscowDateTime } from './utils/dateUtils.js';

type NoteDraft = {
  id: string;
  title: string;
  body: NoteBlock[];
  importance: NoteImportance;
  dueAt: number | null;
};

type NoteView = NoteItem & { shared: boolean; share?: NoteShareItem | null };

function nowMs() {
  return Date.now();
}

function newId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? (crypto as any).randomUUID() : `note_${Math.random().toString(36).slice(2)}`;
}

function parseDueColor(dueAt: number | null, now: number) {
  if (!dueAt) return { color: '#111827', blink: false, label: null };
  const diff = dueAt - now;
  if (diff < 0) return { color: '#b91c1c', blink: true, label: 'Просрочено' };
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (diff > 7 * day) return { color: '#111827', blink: false, label: null };
  if (diff > 3 * day) return { color: '#16a34a', blink: false, label: 'Срок близко' };
  if (diff > 1 * day) return { color: '#2563eb', blink: false, label: 'Срок скоро' };
  if (diff > 2 * hour) return { color: '#d97706', blink: false, label: 'Скоро' };
  return { color: '#b91c1c', blink: false, label: 'Сейчас' };
}

function formatDate(ms: number | null) {
  if (!ms) return '';
  return formatMoscowDateTime(ms);
}

export function NotesPage(props: {
  meUserId: string;
  canEdit: boolean;
  onBurningCountChange?: (count: number) => void;
  onSendToChat: (note: NoteDraft) => Promise<void>;
}) {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [shares, setShares] = useState<NoteShareItem[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; username: string }>>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, NoteDraft>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [now, setNow] = useState(() => nowMs());
  const [dragId, setDragId] = useState<string | null>(null);

  async function refresh() {
    const r = await listNotes().catch(() => null);
    if (r && (r as any).ok) {
      const nextNotes = (r as any).notes as NoteItem[];
      const nextShares = (r as any).shares as NoteShareItem[];
      setNotes(nextNotes);
      setShares(nextShares);
    }
  }

  async function refreshUsers() {
    const r = await listNoteUsers().catch(() => null);
    if (r && (r as any).ok) {
      const usersRaw = (r as any).users as Array<{ id: string; username: string }>;
      setUsers(usersRaw.map((u) => ({ id: String(u.id), username: String((u as any).username ?? (u as any).login ?? u.id) })));
    }
  }

  useEffect(() => {
    void refresh();
    void refreshUsers();
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(nowMs()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const map: Record<string, NoteDraft> = {};
    for (const n of notes) {
      map[n.id] = {
        id: n.id,
        title: n.title,
        body: n.body ?? [],
        importance: n.importance ?? 'normal',
        dueAt: n.dueAt ?? null,
      };
    }
    setDrafts(map);
  }, [notes]);

  const sharesByNoteId = useMemo(() => {
    const map = new Map<string, NoteShareItem[]>();
    for (const s of shares) {
      const id = String(s.noteId);
      if (!map.has(id)) map.set(id, []);
      map.get(id)!.push(s);
    }
    return map;
  }, [shares]);

  const mySharesByNoteId = useMemo(() => {
    const map = new Map<string, NoteShareItem>();
    for (const s of shares) {
      if (s.recipientUserId === props.meUserId) map.set(String(s.noteId), s);
    }
    return map;
  }, [shares, props.meUserId]);

  const notesVisible: NoteView[] = useMemo(() => {
    const owned = notes.filter((n) => n.ownerUserId === props.meUserId);
    const shared = notes.filter((n) => n.ownerUserId !== props.meUserId && mySharesByNoteId.has(String(n.id)));
    const ownedViews = owned.map((n) => ({ ...n, shared: false, share: null }));
    const sharedViews = shared
      .map((n) => ({ ...n, shared: true, share: mySharesByNoteId.get(String(n.id)) ?? null }))
      .filter((n) => (showHidden ? true : !(n.share?.hidden ?? false)));
    return [...ownedViews, ...sharedViews];
  }, [notes, props.meUserId, mySharesByNoteId, showHidden]);

  useEffect(() => {
    const count = notesVisible.filter((n) => n.importance === 'burning' || (n.dueAt != null && n.dueAt < now)).length;
    props.onBurningCountChange?.(count);
  }, [notesVisible, now]);

  const ownedNotes = notesVisible.filter((n) => !n.shared);
  const sharedNotes = notesVisible.filter((n) => n.shared);

  function toggleExpand(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function updateDraft(id: string, next: Partial<NoteDraft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...next } }));
    setDirty((prev) => ({ ...prev, [id]: true }));
  }

  async function saveDraft(id: string) {
    const draft = drafts[id];
    if (!draft) return;
    const r = await upsertNote({
      id,
      title: draft.title,
      body: draft.body,
      importance: draft.importance,
      dueAt: draft.dueAt ?? null,
    });
    if ((r as any)?.ok) {
      setDirty((prev) => ({ ...prev, [id]: false }));
      void refresh();
    }
  }

  async function createNote() {
    const title = newTitle.trim() || 'Новая заметка';
    const r = await upsertNote({ title, body: [], importance: 'normal', dueAt: null });
    if ((r as any)?.ok) {
      setNewTitle('');
      await refresh();
      setExpanded((prev) => ({ ...prev, [(r as any).id]: true }));
    }
  }

  async function deleteNoteById(id: string) {
    await deleteNote(id);
    await refresh();
  }

  async function shareNoteTo(noteId: string, recipientUserId: string) {
    await shareNote(noteId, recipientUserId);
    await refresh();
  }

  async function unshareNoteFrom(noteId: string, recipientUserId: string) {
    await unshareNote(noteId, recipientUserId);
    await refresh();
  }

  async function toggleHidden(noteId: string, hidden: boolean) {
    await hideNote(noteId, hidden);
    await refresh();
  }

  async function reorderList(list: NoteView[], scope: 'owner' | 'shared') {
    for (let i = 0; i < list.length; i += 1) {
      await reorderNote({ noteId: list[i].id, sortOrder: i * 10, scope });
    }
    await refresh();
  }

  function addTextBlock(noteId: string) {
    const draft = drafts[noteId];
    if (!draft) return;
    updateDraft(noteId, { body: [...draft.body, { id: newId(), kind: 'text', text: '' }] });
  }

  function addUrlBlock(noteId: string) {
    const draft = drafts[noteId];
    if (!draft) return;
    const url = window.prompt('Введите ссылку (URL)');
    if (!url) return;
    updateDraft(noteId, { body: [...draft.body, { id: newId(), kind: 'link', url: String(url).trim() }] });
  }

  async function addImageBlock(noteId: string, file: File) {
    const draft = drafts[noteId];
    if (!draft) return;
    const upload = await uploadSmallFile(file, { ownerType: 'note', ownerId: noteId, category: 'note-images' });
    if (!(upload as any)?.ok) return;
    const fileRef = (upload as any).file as { id: string; name?: string; mime?: string | null };
    updateDraft(noteId, { body: [...draft.body, { id: newId(), kind: 'image', fileId: fileRef.id, name: fileRef.name ?? fileRef.id, mime: fileRef.mime ?? undefined }] });
  }

  async function handleDrop(noteId: string, scope: 'owner' | 'shared') {
    if (!dragId || dragId === noteId) return;
    const list = scope === 'owner' ? [...ownedNotes] : [...sharedNotes];
    const fromIdx = list.findIndex((n) => n.id === dragId);
    const toIdx = list.findIndex((n) => n.id === noteId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...list];
    const [item] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, item);
    await reorderList(next, scope);
    setDragId(null);
  }

  function renderNote(note: NoteView) {
    const draft = drafts[note.id];
    const share = note.shared ? note.share : null;
    const isExpanded = !!expanded[note.id];
    const dueInfo = parseDueColor(draft?.dueAt ?? note.dueAt ?? null, now);
    const titleText = draft?.title ?? note.title;
    const noteUsers = users.filter((u) => u.id !== props.meUserId);
    const sharedWith = sharesByNoteId.get(note.id) ?? [];
    const availableUsers = noteUsers.filter((u) => !sharedWith.some((s) => s.recipientUserId === u.id));

    return (
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10, background: '#fff' }}>
        <div onClick={() => toggleExpand(note.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <div className={dueInfo.blink ? 'notes-blink' : undefined} style={{ fontWeight: 800, color: dueInfo.color, flex: 1 }}>
            {titleText}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {formatDate(note.createdAt)}
          </div>
        </div>

        {isExpanded && draft && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Input
                value={draft.title}
                disabled={note.shared || !props.canEdit}
                onChange={(e) => updateDraft(note.id, { title: e.target.value })}
                placeholder="Заголовок"
              />
              <select
                value={draft.importance}
                disabled={note.shared || !props.canEdit}
                onChange={(e) => updateDraft(note.id, { importance: e.target.value as NoteImportance })}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb' }}
              >
                <option value="normal">Обычная</option>
                <option value="burning">Горящая</option>
                <option value="important">Важная</option>
                <option value="later">На потом</option>
              </select>
              <Input
                type="datetime-local"
                value={draft.dueAt ? new Date(draft.dueAt).toISOString().slice(0, 16) : ''}
                disabled={note.shared || !props.canEdit}
                onChange={(e) => updateDraft(note.id, { dueAt: e.target.value ? new Date(e.target.value).getTime() : null })}
              />
              {dueInfo.label && <span style={{ color: dueInfo.color, fontSize: 12 }}>{dueInfo.label}</span>}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {draft.body.map((b, idx) => (
                <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {b.kind === 'text' && (
                    <textarea
                      value={b.text}
                      disabled={note.shared || !props.canEdit}
                      onChange={(e) => {
                        const next = [...draft.body];
                        next[idx] = { ...b, text: e.target.value };
                        updateDraft(note.id, { body: next });
                      }}
                      rows={4}
                      style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10 }}
                    />
                  )}
                  {b.kind === 'link' && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {b.url ? (
                        <Button variant="ghost" onClick={() => window.open(b.url, '_blank')}>
                          Открыть ссылку
                        </Button>
                      ) : null}
                      {(b as any).appLink ? <span className="muted">Ссылка на раздел</span> : null}
                      {b.url ? <span className="muted">{b.url}</span> : null}
                    </div>
                  )}
                  {b.kind === 'image' && (
                    <NoteImageBlock fileId={b.fileId} name={b.name ?? b.fileId} />
                  )}
                </div>
              ))}
            </div>

            {!note.shared && props.canEdit && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="ghost" onClick={() => addTextBlock(note.id)}>
                  Добавить текст
                </Button>
                <Button variant="ghost" onClick={() => addUrlBlock(note.id)}>
                  Добавить ссылку (URL)
                </Button>
                <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <span className="muted">Добавить изображение</span>
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void addImageBlock(note.id, f);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {!note.shared && props.canEdit && (
                <Button variant="primary" disabled={!dirty[note.id]} onClick={() => void saveDraft(note.id)}>
                  Сохранить
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  const lines: string[] = [];
                  lines.push(draft.title || 'Заметка');
                  lines.push('');
                  for (const b of draft.body) {
                    if (b.kind === 'text') lines.push(b.text);
                    if (b.kind === 'link') {
                      if ((b as any).url) lines.push(String((b as any).url));
                      if ((b as any).appLink?.tab) lines.push(`app:${String((b as any).appLink.tab)}`);
                    }
                    if (b.kind === 'image') lines.push(`[image:${String((b as any).name ?? (b as any).fileId ?? '')}]`);
                  }
                  void navigator.clipboard.writeText(lines.join('\n').trim());
                }}
              >
                Копировать
              </Button>
              <Button variant="ghost" onClick={() => void props.onSendToChat(draft)}>
                Отправить в чат
              </Button>
              {!note.shared && props.canEdit && (
                <Button variant="ghost" onClick={() => void deleteNoteById(note.id)}>
                  Удалить заметку
                </Button>
              )}
              {note.shared && share && (
                <Button variant="ghost" onClick={() => void toggleHidden(note.id, !share.hidden)}>
                  {share.hidden ? 'Показать заметку' : 'Скрыть заметку'}
                </Button>
              )}
            </div>

            {!note.shared && props.canEdit && (
              <div style={{ borderTop: '1px dashed #e5e7eb', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontWeight: 700 }}>Доступ другим пользователям</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {sharedWith.length === 0 && <span className="muted">Нет</span>}
                  {sharedWith.map((s) => {
                    const u = users.find((x) => x.id === s.recipientUserId);
                    return (
                      <div key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 12 }}>{u?.username ?? s.recipientUserId}</span>
                        <Button variant="ghost" onClick={() => void unshareNoteFrom(note.id, s.recipientUserId)}>
                          Убрать
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {availableUsers.length > 0 && (
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const id = e.target.value;
                      if (!id) return;
                      void shareNoteTo(note.id, id);
                      e.currentTarget.value = '';
                    }}
                    style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb' }}
                  >
                    <option value="">Выбрать пользователя…</option>
                    {availableUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderSection(title: string, list: NoteView[], scope: 'owner' | 'shared') {
    if (list.length === 0) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontWeight: 900 }}>{title}</div>
        {list.map((note) => (
          <div
            key={note.id}
            draggable={props.canEdit}
            onDragStart={() => setDragId(note.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => void handleDrop(note.id, scope)}
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}
          >
            <div style={{ width: 20, color: '#94a3b8', userSelect: 'none' }}>⋮⋮</div>
            {renderNote(note)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Название новой заметки" />
        <Button variant="primary" onClick={() => void createNote()} disabled={!props.canEdit}>
          Создать новую заметку
        </Button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          <span className="muted" style={{ fontSize: 12 }}>
            Показывать скрытые
          </span>
        </label>
      </div>

      {renderSection('Мои заметки', ownedNotes, 'owner')}
      {renderSection('Полученные заметки', sharedNotes, 'shared')}
    </div>
  );
}

function NoteImageBlock(props: { fileId: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void fileUrl(props.fileId).then((r: any) => {
      if (!alive) return;
      if (r?.ok && r.url) setUrl(String(r.url));
    });
    return () => {
      alive = false;
    };
  }, [props.fileId]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {url ? <img src={url} alt={props.name} style={{ maxWidth: 260, borderRadius: 8, border: '1px solid #e5e7eb' }} /> : null}
      <span className="muted" style={{ fontSize: 12 }}>
        {props.name}
      </span>
    </div>
  );
}
