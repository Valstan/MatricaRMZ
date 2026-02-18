import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatDeepLinkPayload, ChatUserItem } from '@matricarmz/shared';
import type { NoteBlock, NoteItem, NoteShareItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useFileUploadFlow } from '../hooks/useFileUploadFlow.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { theme } from '../theme.js';

type NoteDraft = {
  id: string;
  title: string;
  body: NoteBlock[];
  importance: 'normal' | 'important' | 'burning' | 'later';
  dueAt: number | null;
};

type NoteView = NoteItem & { shared: boolean; share?: NoteShareItem | null };
type NoteListEntry = NoteView & { section: 'owned' | 'shared' };
type RecipientPickerState = {
  noteId: string;
  mode: 'chat' | 'share';
  selectedIds: string[];
};

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

function getTextFromBody(body: NoteBlock[]) {
  const lines: string[] = [];
  for (const b of body) {
    if (b.kind === 'text') lines.push(b.text);
  }
  return lines.join('\n').trim();
}

function noteToText(note: NoteDraft) {
  return getTextFromBody(note.body);
}

function makeAutoTitle(body: NoteBlock[]) {
  const text = getTextFromBody(body);
  const first = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean);
  if (!first) return 'Заметка';
  return first.slice(0, 80);
}

function ensureTextBlock(body: NoteBlock[]) {
  const idx = body.findIndex((b) => b.kind === 'text');
  if (idx >= 0) return { body, textIndex: idx };
  return { body: [{ id: newId(), kind: 'text', text: '' } as NoteBlock, ...body], textIndex: 0 };
}

function textPreviewLines(body: NoteBlock[]) {
  const text = getTextFromBody(body);
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (lines.length === 0) return ['Пустая заметка', '', ''];
  return [lines[0] ?? '', lines[1] ?? '', lines[2] ?? ''];
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
  onNavigate: (link: ChatDeepLinkPayload) => void;
  onSendToChat: (note: NoteDraft, recipientUserIds: string[]) => Promise<void>;
  onBurningCountChange?: (count: number) => void;
}) {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [shares, setShares] = useState<NoteShareItem[]>([]);
  const [users, setUsers] = useState<ChatUserItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, NoteDraft>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [recipientPicker, setRecipientPicker] = useState<RecipientPickerState | null>(null);
  const [noteStatus, setNoteStatus] = useState<Record<string, { text: string; tone: 'ok' | 'error' }>>({});
  const [now, setNow] = useState(() => nowMs());
  const [imageThumbs, setImageThumbs] = useState<Record<string, { dataUrl: string | null; status: 'idle' | 'loading' | 'done' | 'error' }>>({});
  const recipientPickerRef = useRef<HTMLDivElement | null>(null);
  const uploadFlow = useFileUploadFlow();

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

  useLiveDataRefresh(
    async () => {
      await refresh();
    },
    { intervalMs: 15000 },
  );

  useEffect(() => {
    const id = window.setInterval(() => setNow(nowMs()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<string, NoteDraft> = { ...prev };
      const aliveIds = new Set<string>();
      for (const n of notes) {
        aliveIds.add(n.id);
        if (!prev[n.id] || !dirty[n.id]) {
          const normalized = ensureTextBlock(n.body ?? []);
          next[n.id] = {
            id: n.id,
            title: makeAutoTitle(normalized.body),
            body: normalized.body,
            importance: n.importance ?? 'normal',
            dueAt: n.dueAt ?? null,
          };
        }
      }
      for (const id of Object.keys(next)) {
        if (!aliveIds.has(id)) delete next[id];
      }
      return next;
    });
    setDirty((prev) => {
      const next: Record<string, boolean> = {};
      for (const n of notes) {
        if (prev[n.id]) next[n.id] = true;
      }
      return next;
    });
  }, [notes, dirty]);

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
  }, [notesVisible, now, props]);

  const ownedNotes = notesVisible.filter((n) => !n.shared);
  const sharedNotes = notesVisible.filter((n) => n.shared);
  const listEntries: NoteListEntry[] = useMemo(
    () => [...ownedNotes.map((n) => ({ ...n, section: 'owned' as const })), ...sharedNotes.map((n) => ({ ...n, section: 'shared' as const }))],
    [ownedNotes, sharedNotes],
  );

  useEffect(() => {
    if (listEntries.length === 0) {
      setSelectedNoteId(null);
      return;
    }
    if (selectedNoteId && listEntries.some((n) => n.id === selectedNoteId)) return;
    setSelectedNoteId(listEntries[0]?.id ?? null);
  }, [listEntries, selectedNoteId]);

  useEffect(() => {
    const ids = new Set<string>();
    for (const entry of listEntries) {
      const draft = drafts[entry.id];
      for (const b of draft?.body ?? []) {
        if (b.kind === 'image' && b.fileId) ids.add(String(b.fileId));
      }
    }
    const missing = Array.from(ids).filter((id) => !imageThumbs[id]);
    if (missing.length === 0) return;
    for (const fileId of missing) {
      setImageThumbs((prev) => ({ ...prev, [fileId]: { dataUrl: null, status: 'loading' } }));
      void window.matrica.files
        .previewGet({ fileId })
        .then((r) => {
          if (r.ok) setImageThumbs((prev) => ({ ...prev, [fileId]: { dataUrl: r.dataUrl ?? null, status: 'done' } }));
          else setImageThumbs((prev) => ({ ...prev, [fileId]: { dataUrl: null, status: 'error' } }));
        })
        .catch(() => {
          setImageThumbs((prev) => ({ ...prev, [fileId]: { dataUrl: null, status: 'error' } }));
        });
    }
  }, [drafts, imageThumbs, listEntries]);

  useEffect(() => {
    if (!recipientPicker) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (recipientPickerRef.current?.contains(target)) return;
      setRecipientPicker(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [recipientPicker]);

  function updateDraft(id: string, next: Partial<NoteDraft>) {
    setDrafts((prev) => {
      const current = prev[id] ?? { id, title: '', body: [], importance: 'normal' as const, dueAt: null };
      const merged = { ...current, ...next };
      return { ...prev, [id]: { ...merged, title: makeAutoTitle(merged.body ?? []) } };
    });
    setDirty((prev) => ({ ...prev, [id]: true }));
  }

  function setPerNoteStatus(noteId: string, text: string, tone: 'ok' | 'error') {
    setNoteStatus((prev) => ({ ...prev, [noteId]: { text, tone } }));
    window.setTimeout(() => {
      setNoteStatus((prev) => {
        if (!prev[noteId]) return prev;
        const next = { ...prev };
        delete next[noteId];
        return next;
      });
    }, 2800);
  }

  async function saveDraft(id: string) {
    const draft = drafts[id];
    if (!draft) return;
    const normalized = ensureTextBlock(draft.body ?? []);
    const title = makeAutoTitle(normalized.body);
    const r = await window.matrica.notes.upsert({
      id,
      title,
      body: normalized.body,
      importance: draft.importance,
      dueAt: draft.dueAt ?? null,
    });
    if ((r as any)?.ok) {
      setDirty((prev) => ({ ...prev, [id]: false }));
      void refresh();
    }
  }

  async function createNote() {
    const body: NoteBlock[] = [{ id: newId(), kind: 'text', text: '' }];
    const r = await window.matrica.notes.upsert({
      title: 'Заметка',
      body,
      importance: 'normal',
      dueAt: null,
    });
    if ((r as any)?.ok) {
      await refresh();
      setSelectedNoteId(String((r as any).id ?? ''));
    }
  }

  async function deleteNote(id: string) {
    await window.matrica.notes.delete({ noteId: id });
    await refresh();
  }

  async function unshareNote(noteId: string, recipientUserId: string) {
    const r = await window.matrica.notes.unshare({ noteId, recipientUserId }).catch(() => null);
    if ((r as any)?.ok) {
      setPerNoteStatus(noteId, 'Доступ убран', 'ok');
      await refresh();
      return;
    }
    setPerNoteStatus(noteId, `Ошибка удаления доступа: ${String((r as any)?.error ?? 'unknown')}`, 'error');
  }

  async function toggleHidden(noteId: string, hidden: boolean) {
    const r = await window.matrica.notes.hide({ noteId, hidden }).catch(() => null);
    if ((r as any)?.ok) {
      setPerNoteStatus(noteId, hidden ? 'Заметка скрыта' : 'Заметка показана', 'ok');
      await refresh();
      return;
    }
    setPerNoteStatus(noteId, `Ошибка: ${String((r as any)?.error ?? 'unknown')}`, 'error');
  }

  async function reorderNotes(list: NoteView[]) {
    for (let i = 0; i < list.length; i += 1) {
      const note = list[i];
      if (!note) continue;
      await window.matrica.notes.reorder({ noteId: note.id, sortOrder: i * 10 });
    }
    await refresh();
  }

  async function addImageBlock(noteId: string) {
    const draft = drafts[noteId];
    if (!draft) return;
    const picked = await window.matrica.files.pick().catch(() => null);
    if (!picked || !(picked as any).ok) return;
    const paths = (picked as any).paths as string[];
    const cleanPaths = (paths ?? []).map((x) => String(x)).filter(Boolean);
    if (cleanPaths.length === 0) return;
    const tasks = await uploadFlow.buildTasks(cleanPaths);
    if (!tasks || tasks.length === 0) {
      uploadFlow.setStatusWithTimeout('Загрузка отменена пользователем', 1500);
      return;
    }
    uploadFlow.setStatus('');
    const result = await uploadFlow.runUploads(tasks, async (task) => {
      const uploaded = await window.matrica.files.upload({
        path: task.path,
        fileName: task.fileName,
        scope: { ownerType: 'note', ownerId: noteId, category: 'note-images' },
      });
      if (!uploaded.ok) return { ok: false as const, error: uploaded.error };
      return { ok: true as const, value: uploaded.file };
    });
    if (result.failures.length > 0 || result.successes.length === 0) {
      uploadFlow.setStatusWithTimeout(`Неуспешно: ${result.failures[0]?.error ?? 'неизвестная ошибка'}`, 4500);
      return;
    }
    const imageBlocks: NoteBlock[] = result.successes
      .map((s) => s.value as { id: string; name: string; mime?: string | null })
      .filter((x) => x && x.id)
      .map((file) => ({
        id: newId(),
        kind: 'image' as const,
        fileId: file.id,
        name: file.name,
        ...(file.mime != null ? { mime: file.mime } : {}),
      }));
    if (imageBlocks.length === 0) return;
    updateDraft(noteId, { body: [...draft.body, ...imageBlocks] });
    uploadFlow.setStatusWithTimeout(`Успешно: прикреплено ${imageBlocks.length} изображ.`, 1600);
  }

  async function moveNote(noteId: string, list: NoteView[], dir: -1 | 1) {
    const index = list.findIndex((n) => n.id === noteId);
    if (index < 0) return;
    const nextIndex = index + dir;
    if (nextIndex < 0 || nextIndex >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(nextIndex, 0, moved);
    await reorderNotes(next);
  }

  function formatUserLabel(u: ChatUserItem) {
    const display = String(u.chatDisplayName ?? '').trim();
    if (display) return `${display} (${u.username})`;
    return u.username;
  }

  function openNote(id: string) {
    setSelectedNoteId(id);
    setRecipientPicker(null);
  }

  function openRecipientPicker(noteId: string, mode: 'chat' | 'share') {
    setRecipientPicker({ noteId, mode, selectedIds: [] });
  }

  function toggleRecipientSelection(userId: string) {
    setRecipientPicker((prev) => {
      if (!prev) return prev;
      const has = prev.selectedIds.includes(userId);
      return { ...prev, selectedIds: has ? prev.selectedIds.filter((x) => x !== userId) : [...prev.selectedIds, userId] };
    });
  }

  function selectAllRecipients(ids: string[]) {
    setRecipientPicker((prev) => (prev ? { ...prev, selectedIds: Array.from(new Set(ids)) } : prev));
  }

  function clearRecipientSelection() {
    setRecipientPicker((prev) => (prev ? { ...prev, selectedIds: [] } : prev));
  }

  async function runRecipientAction(note: NoteView, draft: NoteDraft) {
    if (!recipientPicker || recipientPicker.noteId !== note.id) return;
    const ids = Array.from(new Set(recipientPicker.selectedIds));
    if (ids.length === 0) {
      setPerNoteStatus(note.id, 'Выберите хотя бы одного пользователя', 'error');
      return;
    }
    if (recipientPicker.mode === 'chat') {
      await props.onSendToChat(draft, ids);
      setPerNoteStatus(note.id, `Отправлено в чат: ${ids.length}`, 'ok');
      setRecipientPicker(null);
      return;
    }
    let okCount = 0;
    let errCount = 0;
    for (const userId of ids) {
      const r = await window.matrica.notes.share({ noteId: note.id, recipientUserId: userId }).catch(() => null);
      if ((r as any)?.ok) okCount += 1;
      else errCount += 1;
    }
    if (okCount > 0) await refresh();
    setPerNoteStatus(note.id, errCount > 0 ? `Частично: выдано ${okCount}, ошибки ${errCount}` : `Доступ выдан: ${okCount}`, errCount > 0 ? 'error' : 'ok');
    setRecipientPicker(null);
  }

  function renderListItem(entry: NoteListEntry, index: number) {
    const draft = drafts[entry.id];
    const body = draft?.body ?? entry.body ?? [];
    const [line1, line2, line3] = textPreviewLines(body);
    const active = selectedNoteId === entry.id;
    return (
      <button
        key={entry.id}
        type="button"
        onClick={() => openNote(entry.id)}
        style={{
          textAlign: 'left',
          border: `1px solid ${active ? '#0f2f72' : theme.colors.border}`,
          borderRadius: 10,
          padding: 10,
          background: active ? '#f1f5ff' : theme.colors.surface2,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          cursor: 'pointer',
          width: '100%',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: theme.colors.muted }}>
            {index + 1}. {entry.section === 'owned' ? 'Моя' : 'Получена'}
          </span>
          <span style={{ fontSize: 11, color: theme.colors.muted }}>{formatDate(entry.updatedAt)}</span>
        </div>
        <div style={{ minHeight: 64 }}>
          <div style={{ fontWeight: 700, color: theme.colors.text }}>{line1 || ' '}</div>
          <div style={{ opacity: 0.58, color: theme.colors.text }}>{line2 || ' '}</div>
          <div style={{ opacity: 0.34, color: theme.colors.text }}>{line3 || ' '}</div>
        </div>
        {dirty[entry.id] ? <span style={{ color: 'var(--warn)', fontSize: 12, fontWeight: 700 }}>Есть несохраненные изменения</span> : null}
      </button>
    );
  }

  function renderSelectedNote(note: NoteView, list: NoteView[], listIndex: number) {
    const draft = drafts[note.id];
    if (!draft) return null;
    const share = note.shared ? note.share : null;
    const dueInfo = parseDueColor(draft?.dueAt ?? note.dueAt ?? null, now);
    const noteUsers = users.filter((u) => u.id !== props.meUserId);
    const allRecipientIds = noteUsers.map((u) => u.id);
    const sharedWith = sharesByNoteId.get(note.id) ?? [];
    const noteImages = draft.body.filter((b): b is Extract<NoteBlock, { kind: 'image' }> => b.kind === 'image');
    const { body: ensuredBody, textIndex } = ensureTextBlock(draft.body ?? []);

    return (
      <div
        style={{
          border: `1px solid ${theme.colors.border}`,
          borderRadius: 12,
          background: theme.colors.surface2,
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className={dueInfo.blink ? 'notes-blink' : undefined} style={{ fontWeight: 800, color: dueInfo.color, flex: 1, minWidth: 0 }}>
            {note.shared ? 'Полученная заметка' : 'Моя заметка'}
          </div>
          <div style={{ color: theme.colors.muted, fontSize: 12 }}>{formatDate(note.createdAt)}</div>
        </div>

        <textarea
          value={String((ensuredBody[textIndex] as any)?.text ?? '')}
          disabled={note.shared || !props.canEdit}
          onChange={(e) => {
            const next = [...ensuredBody];
            const existing = next[textIndex] as Extract<NoteBlock, { kind: 'text' }>;
            next[textIndex] = { ...existing, text: e.target.value };
            updateDraft(note.id, { body: next });
          }}
          rows={14}
          style={{
            border: `1px solid ${theme.colors.border}`,
            borderRadius: 10,
            padding: 12,
            background: theme.colors.surface,
            color: theme.colors.text,
            width: '100%',
            resize: 'vertical',
          }}
        />

        {noteImages.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 10,
            }}
          >
            {noteImages.map((b) => {
              const thumb = imageThumbs[b.fileId];
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => void window.matrica.files.open({ fileId: b.fileId })}
                  style={{
                    border: `1px solid ${theme.colors.border}`,
                    borderRadius: 10,
                    background: '#f8fafc',
                    minHeight: 180,
                    width: '100%',
                    overflow: 'hidden',
                    padding: 0,
                    cursor: 'pointer',
                  }}
                  title={b.name ?? b.fileId}
                >
                  {thumb?.dataUrl ? (
                    <img src={thumb.dataUrl} alt={b.name ?? 'image'} style={{ display: 'block', width: '100%', height: 180, objectFit: 'cover' }} />
                  ) : (
                    <div style={{ display: 'grid', placeItems: 'center', height: 180, color: theme.colors.muted, fontSize: 12 }}>Превью недоступно</div>
                  )}
                  <div
                    style={{
                      padding: '6px 8px',
                      fontSize: 12,
                      color: theme.colors.muted,
                      textAlign: 'left',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {b.name ?? b.fileId}
                  </div>
                </button>
              );
            })}
          </div>
        ) : null}

        {!note.shared && props.canEdit && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button variant="ghost" onClick={() => void addImageBlock(note.id)}>
              Добавить изображение
            </Button>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, position: 'relative' }}>
          {!note.shared && props.canEdit && (
            <Button variant="primary" disabled={!dirty[note.id]} onClick={() => void saveDraft(note.id)}>
              Сохранить
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              const text = noteToText(draft);
              void navigator.clipboard.writeText(text);
            }}
          >
            Копировать текст
          </Button>
          <Button variant="ghost" onClick={() => openRecipientPicker(note.id, 'chat')} disabled={noteUsers.length === 0}>
            Отправить в чат
          </Button>
          {!note.shared && props.canEdit && (
            <Button variant="ghost" onClick={() => openRecipientPicker(note.id, 'share')} disabled={noteUsers.length === 0}>
              Поделиться с другими
            </Button>
          )}
          {props.canEdit && (
            <>
              <Button variant="ghost" disabled={listIndex <= 0} onClick={() => void moveNote(note.id, list, -1)}>
                Выше
              </Button>
              <Button variant="ghost" disabled={listIndex < 0 || listIndex >= list.length - 1} onClick={() => void moveNote(note.id, list, 1)}>
                Ниже
              </Button>
            </>
          )}
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
          {recipientPicker && recipientPicker.noteId === note.id && (
            <div
              ref={recipientPickerRef}
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: 0,
                width: 360,
                maxWidth: 'min(92vw, 360px)',
                background: theme.colors.surface2,
                border: `1px solid ${theme.colors.border}`,
                borderRadius: 10,
                boxShadow: '0 16px 32px rgba(15,23,42,0.2)',
                padding: 10,
                zIndex: 40,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontWeight: 700 }}>
                {recipientPicker.mode === 'chat' ? 'Отправить в чат выбранным' : 'Поделиться заметкой с выбранными'}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <Button variant="ghost" onClick={() => selectAllRecipients(allRecipientIds)} disabled={allRecipientIds.length === 0}>
                  Выбрать всех
                </Button>
                <Button variant="ghost" onClick={clearRecipientSelection} disabled={recipientPicker.selectedIds.length === 0}>
                  Снять всех
                </Button>
              </div>
              <div style={{ maxHeight: 260, overflow: 'auto', border: `1px solid ${theme.colors.border}`, borderRadius: 8, padding: 8 }}>
                {noteUsers.length === 0 ? (
                  <div style={{ color: theme.colors.muted }}>Нет пользователей</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {noteUsers.map((u) => {
                      const checked = recipientPicker.selectedIds.includes(u.id);
                      return (
                        <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                          <input type="checkbox" checked={checked} onChange={() => toggleRecipientSelection(u.id)} />
                          <span style={{ fontSize: 13 }}>{formatUserLabel(u)}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <Button variant="ghost" onClick={() => setRecipientPicker(null)}>
                  Отмена
                </Button>
                <Button variant="primary" onClick={() => void runRecipientAction(note, draft)} disabled={recipientPicker.selectedIds.length === 0}>
                  Отправить
                </Button>
              </div>
            </div>
          )}
        </div>

        {!note.shared && props.canEdit && (
          <div style={{ borderTop: `1px dashed ${theme.colors.border}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontWeight: 700 }}>Доступ выдан</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {sharedWith.length === 0 && <span style={{ color: theme.colors.muted }}>Нет</span>}
              {sharedWith.map((s) => {
                const u = users.find((x) => x.id === s.recipientUserId);
                return (
                  <div key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 12 }}>{u ? formatUserLabel(u) : s.recipientUserId}</span>
                    <Button variant="ghost" onClick={() => void unshareNote(note.id, s.recipientUserId)}>
                      Убрать
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {noteStatus[note.id] && (
          <div style={{ fontSize: 12, color: noteStatus[note.id]?.tone === 'error' ? 'var(--danger)' : 'var(--success)' }}>
            {noteStatus[note.id]?.text}
          </div>
        )}
        {dueInfo.label && <span style={{ color: dueInfo.color, fontSize: 12 }}>{dueInfo.label}</span>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button variant="primary" onClick={() => void createNote()} disabled={!props.canEdit}>
          Создать новую заметку
        </Button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          <span style={{ fontSize: 12, color: theme.colors.muted }}>Показывать скрытые</span>
        </label>
      </div>

      {uploadFlow.status ? (
        <div style={{ color: uploadFlow.status.startsWith('Неуспешно') ? '#b91c1c' : '#64748b', fontSize: 12 }}>{uploadFlow.status}</div>
      ) : null}
      {uploadFlow.progress.active ? (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#64748b', marginBottom: 4 }}>
            <span>{uploadFlow.progress.label}</span>
            <span>{Math.max(0, Math.min(100, Math.round(uploadFlow.progress.percent)))}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: '#e5e7eb', overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, uploadFlow.progress.percent))}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #0ea5e9 0%, #2563eb 100%)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 33%) minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
        <div
          style={{
            border: `1px solid ${theme.colors.border}`,
            borderRadius: 10,
            background: theme.colors.surface,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: 'calc(100vh - 260px)',
            overflow: 'auto',
          }}
        >
          {listEntries.length === 0 ? <div style={{ color: theme.colors.muted }}>Заметок пока нет</div> : listEntries.map((entry, idx) => renderListItem(entry, idx))}
        </div>
        <div style={{ minWidth: 0 }}>
          {selectedNoteId ? (
            (() => {
              const selected = listEntries.find((x) => x.id === selectedNoteId) ?? null;
              if (!selected) return <div style={{ color: theme.colors.muted }}>Выберите заметку из списка.</div>;
              const sectionList = selected.section === 'owned' ? ownedNotes : sharedNotes;
              const listIndex = sectionList.findIndex((x) => x.id === selected.id);
              return renderSelectedNote(selected, sectionList, listIndex);
            })()
          ) : (
            <div style={{ color: theme.colors.muted }}>Выберите заметку из списка.</div>
          )}
        </div>
      </div>

      {uploadFlow.renameDialog}
    </div>
  );
}
