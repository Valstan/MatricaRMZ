import React, { useEffect, useMemo, useState } from 'react';

import type { ChatDeepLinkPayload, ChatUserItem } from '@matricarmz/shared';
import type { NoteBlock, NoteImportance, NoteItem, NoteShareItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { theme } from '../theme.js';

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

function formatDate(ms: number | null) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('ru-RU');
}

function noteToText(note: NoteDraft) {
  const lines: string[] = [];
  lines.push(note.title);
  lines.push('');
  for (const b of note.body) {
    if (b.kind === 'text') lines.push(b.text);
    if (b.kind === 'link') {
      if (b.url) lines.push(b.url);
      if (b.appLink) lines.push(`app:${b.appLink.tab}`);
    }
    if (b.kind === 'image') lines.push(`[image:${b.name ?? b.fileId}]`);
  }
  return lines.join('\n').trim();
}

function parseDueColor(dueAt: number | null, now: number) {
  if (!dueAt) return { color: theme.colors.text, blink: false, label: null };
  const diff = dueAt - now;
  if (diff < 0) return { color: 'var(--danger)', blink: true, label: 'Просрочено' };
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (diff > 7 * day) return { color: theme.colors.text, blink: false, label: null };
  if (diff > 3 * day) return { color: 'var(--success)', blink: false, label: 'Срок близко' };
  if (diff > 1 * day) return { color: '#60a5fa', blink: false, label: 'Срок скоро' };
  if (diff > 2 * hour) return { color: 'var(--warn)', blink: false, label: 'Скоро' };
  return { color: 'var(--danger)', blink: false, label: 'Сейчас' };
}

export function NotesPage(props: {
  meUserId: string;
  canEdit: boolean;
  currentLink: ChatDeepLinkPayload | null;
  onNavigate: (link: ChatDeepLinkPayload) => void;
  onSendToChat: (note: NoteDraft) => Promise<void>;
  onBurningCountChange?: (count: number) => void;
}) {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [shares, setShares] = useState<NoteShareItem[]>([]);
  const [users, setUsers] = useState<ChatUserItem[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, NoteDraft>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [sharePickerOpen, setSharePickerOpen] = useState<Record<string, boolean>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [now, setNow] = useState(() => nowMs());

  async function refresh() {
    const r = await window.matrica.notes.list().catch(() => null);
    if (r && (r as any).ok) {
      const nextNotes = (r as any).notes as NoteItem[];
      const nextShares = (r as any).shares as NoteShareItem[];
      setNotes(nextNotes);
      setShares(nextShares);
    }
  }

  async function refreshUsers() {
    const r = await window.matrica.notes.usersList().catch(() => null);
    if (r && (r as any).ok) setUsers((r as any).users as ChatUserItem[]);
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

  useEffect(() => {
    const visible = notesVisible;
    const count = visible.filter((n) => n.importance === 'burning' || (n.dueAt != null && n.dueAt < now)).length;
    props.onBurningCountChange?.(count);
  }, [notes, shares, now]);

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

  const ownedNotes = notesVisible.filter((n) => !n.shared);
  const sharedNotes = notesVisible.filter((n) => n.shared);

  function toggleExpand(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleSharePicker(id: string) {
    setSharePickerOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function updateDraft(id: string, next: Partial<NoteDraft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...next } }));
    setDirty((prev) => ({ ...prev, [id]: true }));
  }

  async function saveDraft(id: string) {
    const draft = drafts[id];
    if (!draft) return;
    const r = await window.matrica.notes.upsert({
      id,
      title: draft.title,
      body: draft.body,
      importance: draft.importance,
      dueAt: draft.dueAt ?? null,
      sortOrder: undefined,
    });
    if ((r as any)?.ok) {
      setDirty((prev) => ({ ...prev, [id]: false }));
      void refresh();
    }
  }

  async function createNote() {
    const title = newTitle.trim() || 'Новая заметка';
    const r = await window.matrica.notes.upsert({
      title,
      body: [],
      importance: 'normal',
      dueAt: null,
    });
    if ((r as any)?.ok) {
      setNewTitle('');
      await refresh();
      setExpanded((prev) => ({ ...prev, [(r as any).id]: true }));
    }
  }

  async function deleteNote(id: string) {
    await window.matrica.notes.delete({ noteId: id });
    await refresh();
  }

  async function shareNote(noteId: string, recipientUserId: string) {
    await window.matrica.notes.share({ noteId, recipientUserId });
    await refresh();
  }

  async function unshareNote(noteId: string, recipientUserId: string) {
    await window.matrica.notes.unshare({ noteId, recipientUserId });
    await refresh();
  }

  async function toggleHidden(noteId: string, hidden: boolean) {
    await window.matrica.notes.hide({ noteId, hidden });
    await refresh();
  }

  async function reorderNotes(list: NoteView[]) {
    for (let i = 0; i < list.length; i += 1) {
      await window.matrica.notes.reorder({ noteId: list[i].id, sortOrder: i * 10 });
    }
    await refresh();
  }

  function addTextBlock(noteId: string) {
    const draft = drafts[noteId];
    if (!draft) return;
    const block: NoteBlock = { id: newId(), kind: 'text', text: '' };
    updateDraft(noteId, { body: [...draft.body, block] });
  }

  function addUrlBlock(noteId: string) {
    const draft = drafts[noteId];
    if (!draft) return;
    const url = window.prompt('Введите ссылку (URL)');
    if (!url) return;
    const block: NoteBlock = { id: newId(), kind: 'link', url: String(url).trim() };
    updateDraft(noteId, { body: [...draft.body, block] });
  }

  function addAppLinkBlock(noteId: string) {
    const draft = drafts[noteId];
    if (!draft) return;
    if (!props.currentLink) return;
    const block: NoteBlock = { id: newId(), kind: 'link', appLink: props.currentLink };
    updateDraft(noteId, { body: [...draft.body, block] });
  }

  async function addImageBlock(noteId: string) {
    const draft = drafts[noteId];
    if (!draft) return;
    const picked = await window.matrica.files.pick().catch(() => null);
    if (!picked || !(picked as any).ok) return;
    const paths = (picked as any).paths as string[];
    const path = paths?.[0] ? String(paths[0]) : '';
    if (!path) return;
    const uploaded = await window.matrica.files.upload({ path, scope: { ownerType: 'note', ownerId: noteId, category: 'note-images' } });
    if (!uploaded || !(uploaded as any).ok) return;
    const file = (uploaded as any).file as { id: string; name: string; mime?: string | null };
    const block: NoteBlock = { id: newId(), kind: 'image', fileId: file.id, name: file.name, mime: file.mime ?? undefined };
    updateDraft(noteId, { body: [...draft.body, block] });
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
      <div
        style={{
          border: `1px solid ${theme.colors.border}`,
          borderRadius: 12,
          background: theme.colors.surface2,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div
          onClick={() => toggleExpand(note.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            cursor: 'pointer',
          }}
        >
          <div
            className={dueInfo.blink ? 'notes-blink' : undefined}
            style={{
              fontWeight: 800,
              color: dueInfo.color,
              flex: 1,
              minWidth: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {titleText}
          </div>
          <div style={{ color: theme.colors.muted, fontSize: 12 }}>{formatDate(note.createdAt)}</div>
        </div>

        {isExpanded && draft && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
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
                style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${theme.colors.border}` }}
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
                      style={{
                        border: `1px solid ${theme.colors.border}`,
                        borderRadius: 10,
                        padding: 10,
                        background: theme.colors.surface,
                        color: theme.colors.text,
                      }}
                    />
                  )}
                  {b.kind === 'link' && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {b.url ? (
                        <Button variant="ghost" onClick={() => window.open(b.url, '_blank')}>
                          Открыть ссылку
                        </Button>
                      ) : null}
                      {b.appLink ? (
                        <Button variant="ghost" onClick={() => props.onNavigate(b.appLink!)}>
                          Открыть раздел
                        </Button>
                      ) : null}
                      {b.url ? <span style={{ color: theme.colors.muted, fontSize: 12 }}>{b.url}</span> : null}
                    </div>
                  )}
                  {b.kind === 'image' && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Button variant="ghost" onClick={() => void window.matrica.files.open({ fileId: b.fileId })}>
                        Открыть изображение
                      </Button>
                      <span style={{ color: theme.colors.muted, fontSize: 12 }}>{b.name ?? b.fileId}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {!note.shared && props.canEdit && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <Button variant="ghost" onClick={() => addTextBlock(note.id)}>
                  Добавить текст
                </Button>
                <Button variant="ghost" onClick={() => addUrlBlock(note.id)}>
                  Добавить ссылку (URL)
                </Button>
                <Button variant="ghost" disabled={!props.currentLink} onClick={() => addAppLinkBlock(note.id)}>
                  Ссылка на текущий раздел
                </Button>
                <Button variant="ghost" onClick={() => void addImageBlock(note.id)}>
                  Добавить изображение
                </Button>
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {!note.shared && props.canEdit && (
                <Button variant="primary" disabled={!dirty[note.id]} onClick={() => void saveDraft(note.id)}>
                  Сохранить
                </Button>
              )}
              {!note.shared && props.canEdit && (
                <Button variant="ghost" disabled={availableUsers.length === 0} onClick={() => toggleSharePicker(note.id)}>
                  Поделиться с другими...
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  const text = noteToText(draft);
                  void navigator.clipboard.writeText(text);
                }}
              >
                Копировать
              </Button>
              <Button variant="ghost" onClick={() => void props.onSendToChat(draft)}>
                Отправить в чат
              </Button>
              {!note.shared && props.canEdit && (
                <Button variant="ghost" onClick={() => void deleteNote(note.id)}>
                  Удалить заметку
                </Button>
              )}
              {note.shared && share && (
                <>
                  <Button variant="ghost" onClick={() => void toggleHidden(note.id, !share.hidden)}>
                    {share.hidden ? 'Показать заметку' : 'Скрыть заметку'}
                  </Button>
                  <Button variant="ghost" onClick={() => void unshareNote(note.id, props.meUserId)}>
                    Удалить из моих
                  </Button>
                </>
              )}
            </div>

            {!note.shared && props.canEdit && (
              <div style={{ borderTop: `1px dashed ${theme.colors.border}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontWeight: 700 }}>Доступ другим пользователям</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {sharedWith.length === 0 && <span style={{ color: theme.colors.muted }}>Нет</span>}
                  {sharedWith.map((s) => {
                    const u = users.find((x) => x.id === s.recipientUserId);
                    return (
                      <div key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 12 }}>{u?.username ?? s.recipientUserId}</span>
                        <Button variant="ghost" onClick={() => void unshareNote(note.id, s.recipientUserId)}>
                          Убрать
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {sharePickerOpen[note.id] && availableUsers.length > 0 && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id) return;
                        void shareNote(note.id, id);
                        e.currentTarget.value = '';
                        setSharePickerOpen((prev) => ({ ...prev, [note.id]: false }));
                      }}
                      style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${theme.colors.border}` }}
                    >
                      <option value="">Выбрать пользователя…</option>
                      {availableUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.username}
                        </option>
                      ))}
                    </select>
                    <Button variant="ghost" onClick={() => toggleSharePicker(note.id)}>
                      Отмена
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderNotesSection(title: string, list: NoteView[]) {
    if (list.length === 0) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontWeight: 900 }}>{title}</div>
        <DraggableFieldList
          items={list}
          getKey={(n) => n.id}
          canDrag={props.canEdit}
          onReorder={(next) => void reorderNotes(next)}
          renderItem={(item, itemProps, _dragHandleProps, state) => (
            <div
              {...itemProps}
              className="card-row"
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                gap: 8,
                alignItems: 'start',
                padding: '4px 6px',
                border: state.isOver ? '1px dashed #93c5fd' : '1px solid var(--card-row-border)',
                background: state.isDragging ? 'var(--card-row-drag-bg)' : undefined,
              }}
            >
              {renderNote(item)}
            </div>
          )}
        />
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          <span style={{ fontSize: 12, color: theme.colors.muted }}>Показывать скрытые</span>
        </label>
      </div>

      {renderNotesSection('Мои заметки', ownedNotes)}
      {renderNotesSection('Полученные заметки', sharedNotes)}
    </div>
  );
}
