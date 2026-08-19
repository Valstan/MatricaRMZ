import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatDeepLinkPayload, ChatMessageItem, ChatUnreadCountResult, ChatUserItem } from '@matricarmz/shared';

import { Button } from './Button.js';
import { useConfirm } from './ConfirmContext.js';
import { Input } from './Input.js';
import { theme } from '../theme.js';
import { formatChatDaySeparator, formatMoscowTime, moscowDayKey } from '../utils/dateUtils.js';
import { pollWhenVisible } from '../utils/pollWhenVisible.js';
import { useTabVisible } from '../shell/TabVisibilityContext.js';

function onlineDot(online: boolean | null | undefined, size = 9) {
  if (online == null) return null;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        display: 'inline-block',
        flexShrink: 0,
        background: online ? 'var(--success)' : 'var(--border)',
        boxShadow: online ? '0 0 0 2px rgba(22, 163, 74, 0.18)' : 'none',
      }}
      title={online ? 'В сети' : 'Не в сети'}
    />
  );
}

/** Собеседник в левой колонке: общий чат — псевдо-собеседник с id `null`. */
type ConversationItem = {
  id: string | null;
  title: string;
  online: boolean | null;
  unread: number;
  role: string;
};

export function ChatPanel(props: {
  meUserId: string;
  meRole: string;
  canExport: boolean;
  canAdminViewAll: boolean;
  onNavigate: (link: ChatDeepLinkPayload) => void;
  onChatContextChange?: (ctx: { selectedUserId: string | null; adminMode: boolean }) => void;
  viewMode: boolean;
}) {
  const { confirm } = useConfirm();
  // Скрытая вкладка чата не поллит и, что важнее, не помечает входящие прочитанными.
  const tabVisible = useTabVisible();
  const [users, setUsers] = useState<ChatUserItem[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [adminMode, setAdminMode] = useState<boolean>(false);
  const [adminPair, setAdminPair] = useState<{ aId: string; bId: string }>({ aId: '', bId: '' });
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [text, setText] = useState<string>('');
  const [unread, setUnread] = useState<ChatUnreadCountResult | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportRange, setExportRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [peopleQuery, setPeopleQuery] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const [busyNote, setBusyNote] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const chatRootRef = useRef<HTMLDivElement | null>(null);
  const [noteDialog, setNoteDialog] = useState<{ open: boolean; message: ChatMessageItem | null; title: string }>({
    open: false,
    message: null,
    title: '',
  });

  const byUserUnread = useMemo(() => {
    if (!unread || (unread as any).ok !== true) return {} as Record<string, number>;
    return ((unread as any).byUser ?? {}) as Record<string, number>;
  }, [unread]);
  const globalUnread = useMemo(() => {
    if (!unread || (unread as any).ok !== true) return 0;
    return Number((unread as any).global ?? 0);
  }, [unread]);

  const usersById = useMemo(() => {
    const map = new Map<string, ChatUserItem>();
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);

  const role = String(props.meRole ?? '').toLowerCase();
  const isAdmin = ['admin', 'superadmin'].includes(role);
  const isPending = role === 'pending';

  // Левая колонка: общий чат + все активные собеседники. Порядок — сначала те, кто
  // ждёт ответа (непрочитанные), затем кто в сети, затем по имени: оператору важен
  // не алфавит, а «кому я не ответил».
  const conversations = useMemo<ConversationItem[]>(() => {
    const base = isPending ? users.filter((u) => u.role === 'superadmin') : users;
    const people = base
      .filter((u) => u.isActive && u.id !== props.meUserId)
      .map<ConversationItem>((u) => ({
        id: u.id,
        title: (u.chatDisplayName || u.username || '').trim() || 'Пользователь',
        online: u.online ?? false,
        unread: byUserUnread[u.id] ?? 0,
        role: u.role ?? '',
      }))
      .sort((a, b) => {
        if ((b.unread > 0 ? 1 : 0) !== (a.unread > 0 ? 1 : 0)) return (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0);
        if ((b.online ? 1 : 0) !== (a.online ? 1 : 0)) return (b.online ? 1 : 0) - (a.online ? 1 : 0);
        return a.title.localeCompare(b.title, 'ru');
      });
    const q = peopleQuery.trim().toLowerCase();
    const filtered = q ? people.filter((p) => p.title.toLowerCase().includes(q)) : people;
    const general: ConversationItem[] = isPending
      ? []
      : [{ id: null, title: 'Общий чат', online: null, unread: globalUnread, role: '' }];
    return [...general, ...filtered];
  }, [users, isPending, props.meUserId, byUserUnread, globalUnread, peopleQuery]);

  const privateWith = !adminMode && selectedUserId ? usersById.get(selectedUserId) ?? null : null;
  const isPrivate = !!privateWith;
  const conversationTitle = adminMode
    ? 'Админ: просмотр переписки'
    : privateWith
      ? (privateWith.chatDisplayName || privateWith.username || 'Пользователь')
      : 'Общий чат';

  // Destructured on purpose: this effect keeps the callback in its deps, so a caller passing an inline arrow
  // would re-fire it on every parent render and store a new context object each time (a render feedback loop).
  const { onChatContextChange } = props;
  useEffect(() => {
    onChatContextChange?.({ selectedUserId, adminMode });
  }, [selectedUserId, adminMode, onChatContextChange]);

  async function refreshUsers() {
    const r = await window.matrica.chat.usersList().catch(() => null);
    if (r && (r as any).ok) setUsers((r as any).users ?? []);
  }

  async function refreshUnread() {
    const r = await window.matrica.chat.unreadCount().catch(() => null);
    if (r) setUnread(r as any);
  }

  async function refreshMessages() {
    if (adminMode && props.canAdminViewAll) {
      const aId = adminPair.aId.trim();
      const bId = adminPair.bId.trim();
      if (!aId || !bId || aId === bId) {
        setMessages([]);
        return;
      }
      const r = await window.matrica.chat.adminListPair({ userAId: aId, userBId: bId, limit: 400 }).catch(() => null);
      if (r && (r as any).ok) setMessages((r as any).messages as ChatMessageItem[]);
      return;
    }

    if (isPending && !selectedUserId) return;
    const r = await window.matrica.chat
      .list({ mode: selectedUserId ? 'private' : 'global', withUserId: selectedUserId, limit: 200 })
      .catch(() => null);
    if (r && (r as any).ok) {
      const msgs = (r as any).messages as ChatMessageItem[];
      setMessages(msgs);
      // mark read (best-effort); в режиме бэкапа лента — снимок, пометка прочтения
      // ушла бы в живую базу (её же теперь отклоняет и main-процесс).
      if (!props.viewMode) {
        const ids = msgs.filter((m) => m.senderUserId !== props.meUserId).map((m) => m.id);
        if (ids.length > 0) void window.matrica.chat.markRead({ messageIds: ids }).catch(() => {});
      }
    }
  }

  // When chat is open: more frequent sync & refresh for responsiveness.
  useEffect(() => {
    if (props.viewMode || !tabVisible) return;
    const stop = pollWhenVisible(() => {
      void window.matrica.sync.run().catch(() => {});
    }, 60_000);
    return () => stop();
  }, [props.viewMode, tabVisible]);

  // Poll users/unread/messages. Пауза при скрытом окне — заодно скрытый чат не
  // помечает входящие прочитанными, пока оператор реально не смотрит на окно.
  useEffect(() => {
    if (!tabVisible) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await refreshUsers();
      await refreshUnread();
      await refreshMessages();
    };
    void tick();
    const stop = pollWhenVisible(() => void tick(), 30_000);
    return () => {
      alive = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the poll is keyed to the chat selection only; refreshMessages is re-created on every render, so depending on it would tear down and restart the poll (refetching messages and marking them read) on every render
  }, [selectedUserId, adminMode, adminPair.aId, adminPair.bId, tabVisible, props.meUserId, props.meRole, props.canAdminViewAll]);

  useEffect(() => {
    if (!isPending) return;
    if (adminMode) setAdminMode(false);
    const superadmin = users.find((u) => u.role === 'superadmin') ?? null;
    if (superadmin && selectedUserId !== superadmin.id) setSelectedUserId(superadmin.id);
  }, [isPending, users, selectedUserId, adminMode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length]);

  function getMessageUser(m: ChatMessageItem) {
    const u = usersById.get(m.senderUserId) ?? null;
    const displayName = u?.chatDisplayName?.trim() || u?.username?.trim() || '';
    return {
      name: displayName || m.senderUsername || 'Пользователь',
      role: u?.role ?? '',
      online: u?.online ?? null,
    };
  }

  function insertMention(name: string) {
    const mention = `@${name}`.trim();
    setText((prev) => {
      const base = prev.trim();
      return base ? `${base} ${mention} ` : `${mention} `;
    });
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleReply(message: ChatMessageItem) {
    insertMention(getMessageUser(message).name);
  }

  function handleReplyPrivate(message: ChatMessageItem) {
    const info = getMessageUser(message);
    const targetUserId =
      message.senderUserId === props.meUserId ? (message.recipientUserId ? String(message.recipientUserId) : null) : message.senderUserId;
    if (!targetUserId) return;
    setAdminMode(false);
    setSelectedUserId(targetUserId);
    insertMention(info.name);
  }

  async function handleDeleteMessage(message: ChatMessageItem) {
    const preview =
      message.messageType === 'text' || message.messageType === 'text_notify'
        ? String(message.bodyText ?? '').trim().slice(0, 200)
        : message.messageType === 'file'
          ? `файл: ${String(message.bodyText ?? '').trim() || 'вложение'}`
          : 'сообщение';
    const ok = await confirm({
      detail: `Будет удалено сообщение в чате (${preview ? `содержимое: «${preview}»` : 'без текста'}).`,
    });
    if (!ok) return;
    const r = await window.matrica.chat.deleteMessage({ messageId: message.id }).catch(() => null);
    if (r && (r as any).ok) {
      await refreshMessages();
      await refreshUnread();
    }
  }

  function openNoteDialog(message: ChatMessageItem) {
    setNoteDialog({ open: true, message, title: 'Заметка из чата' });
  }

  function closeNoteDialog() {
    setNoteDialog({ open: false, message: null, title: '' });
  }

  async function submitNoteFromMessage() {
    const msg = noteDialog.message;
    if (!msg) return;
    const title = noteDialog.title.trim() || 'Заметка из чата';
    const body: any[] = [];
    if (msg.messageType === 'text' || msg.messageType === 'text_notify') {
      body.push({ id: crypto.randomUUID(), kind: 'text', text: msg.bodyText || '' });
    }
    if (msg.messageType === 'deep_link') {
      body.push({ id: crypto.randomUUID(), kind: 'link', appLink: msg.payload });
    }
    if (msg.messageType === 'file') {
      const file = msg.payload as any;
      const mime = String(file?.mime ?? '');
      if (mime.startsWith('image/')) {
        body.push({ id: crypto.randomUUID(), kind: 'image', fileId: file?.id, name: file?.name, mime });
      } else {
        body.push({ id: crypto.randomUUID(), kind: 'text', text: `Файл: ${String(file?.name ?? 'Файл')}` });
      }
    }
    const r = await window.matrica.notes.upsert({ title, body, importance: 'normal' }).catch(() => null);
    if ((r as any)?.ok && !props.viewMode) void window.matrica.sync.run().catch(() => {});
    closeNoteDialog();
  }

  async function sendText() {
    const t = text.trim();
    if (!t) return;
    if (adminMode) return;
    setText('');
    const r = await window.matrica.chat.sendText({ recipientUserId: selectedUserId, text: t });
    if ((r as any)?.ok && !props.viewMode) void window.matrica.sync.run().catch(() => {});
    await refreshMessages();
    await refreshUnread();
  }

  async function sendTextEverywhere() {
    const t = text.trim();
    if (!t) return;
    if (adminMode) return;
    setText('');
    const r = await window.matrica.chat.sendTextEverywhere({ recipientUserId: selectedUserId, text: t });
    if ((r as any)?.ok && !props.viewMode) void window.matrica.sync.run().catch(() => {});
    await refreshMessages();
    await refreshUnread();
  }

  /** Общий хвост отправки файлов: и для выбора через диалог, и для перетаскивания. */
  async function sendFilePaths(paths: string[]) {
    const list = paths.map((p) => String(p ?? '').trim()).filter(Boolean);
    if (list.length === 0 || adminMode) return;
    let sent = 0;
    for (const [i, path] of list.entries()) {
      setBusyNote(list.length > 1 ? `Отправка файлов: ${i + 1} из ${list.length}…` : 'Отправка файла…');
      // IPC bridge to main (not express res.sendFile); main accepts only paths it issued
      // itself — the file dialog or files:registerDropped — via consumeIssuedPath.
      const r = await window.matrica.chat.sendFile({ recipientUserId: selectedUserId, path }).catch(() => null); // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
      if ((r as any)?.ok) sent += 1;
    }
    setBusyNote(sent < list.length ? `Отправлено ${sent} из ${list.length}: часть файлов не ушла` : '');
    if (sent > 0 && !props.viewMode) void window.matrica.sync.run().catch(() => {});
    await refreshMessages();
    await refreshUnread();
    if (sent === list.length) setTimeout(() => setBusyNote(''), 1500);
  }

  async function sendFile() {
    if (adminMode) return;
    const picked = await window.matrica.files.pick().catch(() => null);
    if (!picked || !(picked as any).ok) return;
    await sendFilePaths(((picked as any).paths ?? []) as string[]);
  }

  // Перетаскивание из проводника: реальный путь брошенного файла умеет достать
  // только preload (webUtils) и только у настоящего File из события drop.
  async function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDropActive(false);
    if (adminMode || props.viewMode) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const res = await window.matrica.files.dropped(files).catch(() => null);
    const paths = ((res as any)?.paths ?? []) as string[];
    if (paths.length === 0) {
      setBusyNote('Не удалось прочитать перетащенные файлы (папки отправлять нельзя)');
      return;
    }
    await sendFilePaths(paths);
  }

  const fileMessages = useMemo(
    () => messages.filter((m) => m.messageType === 'file' && (m.payload as any)?.id),
    [messages],
  );

  /** «Сохранить все» — все файлы открытой переписки одной папкой. */
  async function saveAllFiles() {
    const ids = fileMessages.map((m) => String((m.payload as any).id)).filter(Boolean);
    if (ids.length === 0) return;
    setBusyNote(`Сохранение файлов: ${ids.length} шт…`);
    const r = await window.matrica.files.copyToFolder({ fileIds: ids }).catch(() => null);
    setBusyNote((r as any)?.ok ? `Сохранено файлов: ${ids.length}` : 'Не удалось сохранить файлы');
    setTimeout(() => setBusyNote(''), 2500);
  }

  async function exportChats() {
    if (!props.canExport || !props.canAdminViewAll) return;
    const startMs = exportRange.start ? new Date(exportRange.start).getTime() : NaN;
    const endMs = exportRange.end ? new Date(exportRange.end).getTime() : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    void window.matrica.chat.export({ startMs, endMs });
  }

  // Лента режется на дни: подпись ставится перед первым сообщением каждых
  // московских суток (иначе у машин в разных поясах разделители встали бы
  // в разных местах одной переписки).
  const feed = useMemo(() => {
    const out: Array<{ kind: 'day'; key: string; label: string } | { kind: 'msg'; message: ChatMessageItem }> = [];
    let lastDay = '';
    for (const m of messages) {
      const day = moscowDayKey(m.createdAt);
      if (day !== lastDay) {
        out.push({ kind: 'day', key: day, label: formatChatDaySeparator(m.createdAt) });
        lastDay = day;
      }
      out.push({ kind: 'msg', message: m });
    }
    return out;
  }, [messages]);

  const composerDisabled = adminMode || props.viewMode;

  return (
    <div ref={chatRootRef} data-input-assist="off" style={{ height: '100%', display: 'flex', minWidth: 0 }}>
      {/* Левая колонка: собеседники */}
      {!adminMode && (
        <div
          data-chat-people
          style={{
            width: 232,
            flexShrink: 0,
            borderRight: `1px solid ${theme.colors.border}`,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: theme.colors.surface2,
          }}
        >
          <div style={{ padding: 8, borderBottom: `1px solid ${theme.colors.border}` }}>
            <Input
              value={peopleQuery}
              data-autogrow="off"
              onChange={(e) => setPeopleQuery(e.target.value)}
              placeholder="Поиск человека…"
            />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6 }}>
            {conversations.length === 0 && (
              <div style={{ color: theme.colors.muted, fontSize: 12, padding: 8 }}>Собеседников нет.</div>
            )}
            {conversations.map((c) => {
              const active = selectedUserId === c.id;
              return (
                <button
                  key={c.id ?? '__global__'}
                  type="button"
                  data-chat-person={c.id ?? 'global'}
                  data-active={active ? '1' : undefined}
                  onClick={() => setSelectedUserId(c.id)}
                  title={c.online == null ? 'Общий чат' : c.online ? 'В сети' : 'Не в сети'}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    marginBottom: 4,
                    textAlign: 'left',
                    borderRadius: 8,
                    cursor: 'pointer',
                    border: `1px solid ${active ? theme.colors.chatOtherBorder : 'transparent'}`,
                    background: active ? theme.colors.chatOtherBg : 'transparent',
                    color: theme.colors.text,
                    fontWeight: c.unread > 0 ? 800 : 500,
                  }}
                >
                  {c.id == null ? <span style={{ fontSize: 14 }}>#</span> : onlineDot(c.online)}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title}
                  </span>
                  {c.unread > 0 ? (
                    <span
                      className="chatBlink"
                      style={{
                        minWidth: 20,
                        height: 20,
                        padding: '0 6px',
                        borderRadius: 999,
                        background: 'var(--danger)',
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 800,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      title="Непрочитанные сообщения"
                    >
                      {c.unread}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Правая колонка: переписка */}
      <div
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}
        onDragOver={(e) => {
          if (composerDisabled) return;
          if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
          e.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDropActive(false);
        }}
        onDrop={(e) => void onDrop(e)}
      >
        <div
          style={{
            padding: '8px 10px',
            borderBottom: `1px solid ${theme.colors.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minHeight: 44,
          }}
        >
          <div style={{ fontWeight: 900, color: theme.colors.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {conversationTitle}
          </div>
          {isPrivate ? <span style={{ fontSize: 12, color: theme.colors.muted }}>личная переписка</span> : null}
          <span style={{ flex: 1 }} />
          {fileMessages.length > 0 && !adminMode ? (
            <Button variant="ghost" onClick={() => void saveAllFiles()} title="Сохранить все файлы этой переписки в папку">
              Сохранить все ({fileMessages.length})
            </Button>
          ) : null}
          {props.canAdminViewAll && (
            <Button variant="ghost" onClick={() => setAdminMode((v) => !v)} title="Админ просмотр всех чатов">
              {adminMode ? 'Обычный режим' : 'Админ режим'}
            </Button>
          )}
          {props.canAdminViewAll && props.canExport && (
            <Button variant="ghost" onClick={() => setExportOpen((v) => !v)} title="Выгрузка переписки за период">
              Экспорт
            </Button>
          )}
        </div>

        {adminMode && (
          <div style={{ display: 'flex', gap: 8, padding: 8, borderBottom: `1px solid ${theme.colors.border}` }}>
            <select
              value={adminPair.aId}
              onChange={(e) => setAdminPair((s) => ({ ...s, aId: e.target.value }))}
              style={{ width: '100%', padding: 6 }}
              title="Пользователь A"
            >
              <option value="">Пользователь A…</option>
              {users.filter((u) => u.isActive).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.chatDisplayName || u.username}
                </option>
              ))}
            </select>
            <select
              value={adminPair.bId}
              onChange={(e) => setAdminPair((s) => ({ ...s, bId: e.target.value }))}
              style={{ width: '100%', padding: 6 }}
              title="Пользователь B"
            >
              <option value="">Пользователь B…</option>
              {users.filter((u) => u.isActive).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.chatDisplayName || u.username}
                </option>
              ))}
            </select>
          </div>
        )}

        {exportOpen && props.canAdminViewAll && props.canExport && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 8, borderBottom: `1px dashed ${theme.colors.border}` }}>
            <Input
              value={exportRange.start}
              onChange={(e) => setExportRange((s) => ({ ...s, start: e.target.value }))}
              placeholder="с (2026-01-01)"
            />
            <Input
              value={exportRange.end}
              onChange={(e) => setExportRange((s) => ({ ...s, end: e.target.value }))}
              placeholder="по (2026-01-31)"
            />
            <Button variant="ghost" onClick={() => void exportChats()}>
              Выгрузить…
            </Button>
          </div>
        )}

        <div
          data-chat-feed
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: 12,
            background: theme.colors.chatFeedBg,
          }}
        >
          {feed.length === 0 && <div style={{ color: theme.colors.muted }}>Сообщений пока нет.</div>}
          {feed.map((item) => {
            if (item.kind === 'day') {
              return (
                <div key={`day-${item.key}`} style={{ display: 'flex', justifyContent: 'center', margin: '10px 0 12px' }}>
                  <span
                    data-chat-day
                    style={{
                      padding: '3px 12px',
                      borderRadius: 999,
                      background: theme.colors.surface2,
                      border: `1px solid ${theme.colors.border}`,
                      color: theme.colors.muted,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {item.label}
                  </span>
                </div>
              );
            }
            const m = item.message;
            const mine = m.senderUserId === props.meUserId;
            const info = getMessageUser(m);
            const canDelete = (mine || isAdmin) && !props.viewMode;
            const linkPayload = m.messageType === 'deep_link' ? (m.payload as any) : null;
            const breadcrumbs = (Array.isArray(linkPayload?.breadcrumbs) ? linkPayload.breadcrumbs : [])
              .map((x: any) => String(x ?? '').trim())
              .filter(Boolean);
            const breadcrumbText = breadcrumbs.join(' / ');
            const isClickable = m.messageType === 'file' || m.messageType === 'deep_link';
            return (
              <div
                key={m.id}
                data-chat-message={mine ? 'mine' : 'other'}
                style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', marginBottom: 10 }}
              >
                <div
                  style={{
                    maxWidth: 'min(78%, 640px)',
                    minWidth: 120,
                    padding: '8px 10px',
                    borderRadius: 12,
                    // Свои — на белом, собеседника — на голубоватом: различие
                    // видно даже боковым зрением, не вчитываясь в имя.
                    background: mine ? theme.colors.chatMineBg : theme.colors.chatOtherBg,
                    border: `1px solid ${mine ? theme.colors.chatMineBorder : theme.colors.chatOtherBorder}`,
                  }}
                >
                  {!mine && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      {onlineDot(info.online, 8)}
                      <span style={{ fontWeight: 800, fontSize: 12, color: theme.colors.text }}>{info.name}</span>
                      {info.role ? <span style={{ fontSize: 11, color: theme.colors.muted }}>({info.role})</span> : null}
                    </div>
                  )}
                  <div
                    onClick={() => {
                      if (m.messageType === 'file') {
                        const fileId = (m.payload as any)?.id ? String((m.payload as any).id) : '';
                        if (fileId) void window.matrica.files.open({ fileId });
                      }
                      if (m.messageType === 'deep_link') {
                        const link = m.payload as any;
                        if (link && link.kind === 'app_link') props.onNavigate(link as ChatDeepLinkPayload);
                      }
                    }}
                    style={{
                      color: theme.colors.text,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      cursor: isClickable ? 'pointer' : 'text',
                      textDecoration: isClickable ? 'underline' : 'none',
                    }}
                  >
                    {(m.messageType === 'text' || m.messageType === 'text_notify') && (m.bodyText || '')}
                    {m.messageType === 'file' && `📎 ${m.bodyText || 'Файл'}`}
                    {m.messageType === 'deep_link' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {/* Подпись к ссылке (например, «Правка программы») — текст и
                            переход на экран приходят одним сообщением. */}
                        <span>{m.bodyText?.trim() || 'Ссылка на раздел'}</span>
                        {breadcrumbText ? <span style={{ fontSize: 12, color: theme.colors.muted }}>{breadcrumbText}</span> : null}
                      </div>
                    )}
                  </div>
                </div>
                {/* Действия — сразу под сообщением, без разворачивания: раньше они
                    прятались за кнопкой «i», и оператор о них не знал. */}
                <div
                  data-chat-actions
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 3,
                    padding: mine ? '0 4px 0 0' : '0 0 0 4px',
                    fontSize: 11,
                    color: theme.colors.muted,
                  }}
                >
                  <span title={new Date(m.createdAt).toISOString()}>{formatMoscowTime(m.createdAt)}</span>
                  {!props.viewMode && !adminMode ? (
                    <>
                      <ChatActionLink onClick={() => handleReply(m)}>Ответить</ChatActionLink>
                      <ChatActionLink onClick={() => handleReplyPrivate(m)}>Ответить лично</ChatActionLink>
                      <ChatActionLink onClick={() => openNoteDialog(m)}>В заметки</ChatActionLink>
                    </>
                  ) : null}
                  {canDelete ? <ChatActionLink onClick={() => void handleDeleteMessage(m)}>Удалить</ChatActionLink> : null}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {busyNote ? (
          <div style={{ padding: '4px 10px', fontSize: 12, color: theme.colors.muted, borderTop: `1px solid ${theme.colors.border}` }}>
            {busyNote}
          </div>
        ) : null}

        <div style={{ borderTop: `1px solid ${theme.colors.border}`, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input
            ref={inputRef}
            value={text}
            // Поле сообщения занимает всю ширину: авто-подгонка по длине текста
            // (общая для полей форм) ужимала бы его до ширины плейсхолдера.
            data-autogrow="off"
            onChange={(e) => setText(e.target.value)}
            placeholder={composerDisabled ? 'Отправка недоступна в этом режиме' : 'Введите сообщение… (файлы можно перетащить сюда)'}
            disabled={composerDisabled}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendText();
              }
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button onClick={() => void sendText()} disabled={composerDisabled || !text.trim()}>
              Отправить
            </Button>
            <Button variant="ghost" onClick={() => void sendTextEverywhere()} disabled={composerDisabled || !text.trim()}>
              Отправить везде
            </Button>
            <Button variant="ghost" onClick={() => void sendFile()} disabled={composerDisabled}>
              Файл…
            </Button>
          </div>
        </div>

        {dropActive && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 5,
              border: `2px dashed ${theme.colors.chatMineBorder}`,
              background: 'rgba(37, 99, 235, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              fontWeight: 800,
              color: theme.colors.text,
            }}
          >
            Отпустите файлы — отправлю их в переписку
          </div>
        )}
      </div>

      {noteDialog.open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div style={{ background: theme.colors.surface, border: `1px solid ${theme.colors.border}`, borderRadius: 12, padding: 16, width: 420 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Новая заметка</div>
            <Input
              value={noteDialog.title}
              onChange={(e) => setNoteDialog((prev) => ({ ...prev, title: e.target.value }))}
              placeholder="Заголовок заметки"
              onKeyDown={(e: any) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitNoteFromMessage();
                }
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Button variant="primary" onClick={() => void submitNoteFromMessage()}>
                Добавить
              </Button>
              <Button variant="ghost" onClick={closeNoteDialog}>
                Отмена
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Мелкая текстовая кнопка-действие под сообщением. */
function ChatActionLink(props: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        border: 'none',
        background: 'transparent',
        padding: 0,
        color: theme.colors.muted,
        fontSize: 11,
        cursor: 'pointer',
        textDecoration: 'underline',
      }}
    >
      {props.children}
    </button>
  );
}
