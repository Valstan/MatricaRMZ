import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import * as chatApi from '../api/chat.js';
import { upsertNote } from '../api/notes.js';

type ChatUserItem = {
  id: string;
  username: string;
  role: string;
  isActive: boolean;
  lastActivityAt: number | null;
  online: boolean;
};

type ChatMessageItem = {
  id: string;
  senderUserId: string;
  senderUsername: string;
  recipientUserId: string | null;
  messageType: 'text' | 'file' | 'deep_link';
  bodyText: string | null;
  payload: any;
  createdAt: number;
  updatedAt: number;
};

type ChatUnread = { ok: boolean; total: number; global: number; byUser: Record<string, number> };

function dot(color: string, blinking: boolean) {
  return (
    <span
      className={blinking ? 'chatBlink' : undefined}
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        display: 'inline-block',
        background: color,
        boxShadow: '0 0 0 2px rgba(0,0,0,0.08)',
      }}
    />
  );
}

function roleStyles(roleRaw: string) {
  const role = String(roleRaw ?? '').toLowerCase();
  if (role === 'superadmin') {
    return {
      background: 'linear-gradient(135deg, #9ca3af 0%, #d1d5db 45%, #6b7280 100%)',
      border: '#4b5563',
      color: '#ffffff',
    };
  }
  if (role === 'admin') {
    return { background: '#ffffff', border: '#1d4ed8', color: '#1d4ed8' };
  }
  return { background: '#ffffff', border: '#16a34a', color: '#16a34a' };
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function ChatPanel(props: {
  meUserId: string;
  meRole?: string;
  canExport: boolean;
  canAdminViewAll: boolean;
  onChatContextChange?: (ctx: { selectedUserId: string | null; adminMode: boolean }) => void;
}) {
  const apiBase = (import.meta as any).env?.VITE_API_BASE_URL ?? '';
  const [users, setUsers] = useState<ChatUserItem[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [adminMode, setAdminMode] = useState<boolean>(false);
  const [adminPair, setAdminPair] = useState<{ aId: string; bId: string }>({ aId: '', bId: '' });
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [text, setText] = useState<string>('');
  const [unread, setUnread] = useState<ChatUnread | null>(null);
  const role = String(props.meRole ?? '').toLowerCase();
  const isPending = role === 'pending';
  const [exportRange, setExportRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [linkDraft, setLinkDraft] = useState<{ tab: string; engineId: string; requestId: string; partId: string }>({
    tab: 'masterdata',
    engineId: '',
    requestId: '',
    partId: '',
  });
  const [noteDialog, setNoteDialog] = useState<{ open: boolean; message: ChatMessageItem | null; title: string }>({
    open: false,
    message: null,
    title: '',
  });
  const [linkDialog, setLinkDialog] = useState<{ open: boolean; title: string }>({ open: false, title: 'Ссылка на раздел' });

  useEffect(() => {
    props.onChatContextChange?.({ selectedUserId, adminMode });
  }, [selectedUserId, adminMode]);
  const [sendingFile, setSendingFile] = useState(false);
  const [openInfoId, setOpenInfoId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const othersButtonRef = useRef<HTMLButtonElement | null>(null);
  const othersMenuRef = useRef<HTMLDivElement | null>(null);
  const [othersMenuPos, setOthersMenuPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const modeLabel = adminMode ? `Админ просмотр` : selectedUserId ? `Приватный чат` : `Общий чат`;
  const privateWith = !adminMode && selectedUserId ? users.find((u) => u.id === selectedUserId) ?? null : null;

  const byUserUnread = useMemo(() => {
    if (!unread || unread.ok !== true) return {};
    return unread.byUser as Record<string, number>;
  }, [unread]);
  const onlineUsers = useMemo(() => {
    const base = isPending ? users.filter((u) => u.role === 'superadmin') : users;
    return base.filter((u) => u.isActive && u.online);
  }, [users, isPending]);
  const otherUsers = useMemo(() => {
    const base = isPending ? users.filter((u) => u.role === 'superadmin') : users;
    return base.filter((u) => u.isActive && !u.online);
  }, [users, isPending]);

  async function refreshUsers() {
    const r = await chatApi.listChatUsers().catch(() => null);
    if (r && r.ok) setUsers(r.users ?? []);
  }

  async function refreshUnread() {
    const r = await chatApi.unreadCount().catch(() => null);
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
      const r = await chatApi.adminPair({ userAId: aId, userBId: bId, limit: 400 }).catch(() => null);
      if (r && r.ok) setMessages(r.messages as ChatMessageItem[]);
      return;
    }

    if (isPending && !selectedUserId) return;
    const r = await chatApi
      .listMessages({ mode: selectedUserId ? 'private' : 'global', withUserId: selectedUserId, limit: 200 })
      .catch(() => null);
    if (r && r.ok) {
      const msgs = r.messages as ChatMessageItem[];
      setMessages(msgs);
      const ids = msgs.filter((m) => m.senderUserId !== props.meUserId).map((m) => m.id);
      if (ids.length > 0) void chatApi.markRead(ids).catch(() => {});
    }
  }

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await refreshUsers();
      await refreshUnread();
      await refreshMessages();
    };
    void tick();
    const id = setInterval(() => void tick(), 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [selectedUserId, adminMode, adminPair.aId, adminPair.bId]);

  useEffect(() => {
    if (!isPending) return;
    if (adminMode) setAdminMode(false);
    const superadmin = users.find((u) => u.role === 'superadmin') ?? null;
    if (superadmin && selectedUserId !== superadmin.id) setSelectedUserId(superadmin.id);
  }, [isPending, users, selectedUserId, adminMode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length]);

  useLayoutEffect(() => {
    if (!othersOpen) return;
    const updatePosition = () => {
      const btn = othersButtonRef.current;
      const menu = othersMenuRef.current;
      if (!btn || !menu) return;
      const rect = btn.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const padding = 8;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const maxHeight = Math.min(360, viewportH - padding * 2);
      let left = rect.right - menuRect.width;
      if (left < padding) left = padding;
      if (left + menuRect.width > viewportW - padding) left = viewportW - padding - menuRect.width;
      let top = rect.bottom + 6;
      if (top + menuRect.height > viewportH - padding) {
        top = rect.top - menuRect.height - 6;
      }
      if (top < padding) top = padding;
      setOthersMenuPos({ left, top, maxHeight });
    };
    const id = requestAnimationFrame(updatePosition);
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [othersOpen, otherUsers.length]);

  useEffect(() => {
    if (!othersOpen) return;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const menu = othersMenuRef.current;
      const btn = othersButtonRef.current;
      if (menu && menu.contains(target)) return;
      if (btn && btn.contains(target)) return;
      setOthersOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [othersOpen]);

  function shortId(id: string | null) {
    if (!id) return '';
    return id.length > 10 ? `${id.slice(0, 8)}…` : id;
  }

  function buildLinkBreadcrumbs() {
    const labels: Record<string, string> = {
      masterdata: 'Справочники',
      contracts: 'Контракты',
      contract: 'Карточка контракта',
      changes: 'Изменения',
      engines: 'Двигатели',
      engine: 'Карточка двигателя',
      requests: 'Заявки',
      request: 'Карточка заявки',
      parts: 'Детали',
      part: 'Карточка детали',
      employees: 'Сотрудники',
      employee: 'Карточка сотрудника',
      reports: 'Отчёты',
      admin: 'Админ',
      audit: 'Журнал',
      settings: 'Настройки',
      auth: 'Вход',
    };
    const parent: Record<string, string> = {
      engine: 'Двигатели',
      request: 'Заявки',
      part: 'Детали',
      contract: 'Контракты',
      employee: 'Сотрудники',
    };
    const crumbs: string[] = [];
    const parentLabel = parent[linkDraft.tab];
    if (parentLabel) crumbs.push(parentLabel);
    const label = labels[linkDraft.tab] ?? linkDraft.tab;
    if (label) crumbs.push(label);
    if (linkDraft.engineId.trim()) crumbs.push(`ID ${shortId(linkDraft.engineId.trim())}`);
    if (linkDraft.requestId.trim()) crumbs.push(`ID ${shortId(linkDraft.requestId.trim())}`);
    if (linkDraft.partId.trim()) crumbs.push(`ID ${shortId(linkDraft.partId.trim())}`);
    return crumbs.filter(Boolean);
  }

  function insertMention(name: string) {
    const mention = `@${String(name ?? '').trim()}`.trim();
    if (!mention) return;
    setText((prev) => {
      const base = prev.trim();
      return base ? `${base} ${mention} ` : `${mention} `;
    });
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function sendText() {
    const t = text.trim();
    if (!t) return;
    if (adminMode) return;
    setText('');
    await chatApi.sendText({ recipientUserId: selectedUserId, text: t });
    await refreshMessages();
    await refreshUnread();
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
    if (msg.messageType === 'text') {
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
    await upsertNote({ title, body, importance: 'normal' });
    closeNoteDialog();
  }

  function buildLinkPayload() {
    return {
      kind: 'app_link',
      tab: linkDraft.tab,
      engineId: linkDraft.engineId.trim() || null,
      requestId: linkDraft.requestId.trim() || null,
      partId: linkDraft.partId.trim() || null,
      breadcrumbs: buildLinkBreadcrumbs(),
    };
  }

  async function sendLinkToChat() {
    if (adminMode) return;
    const payload = buildLinkPayload();
    await chatApi.sendLink({ recipientUserId: selectedUserId, link: payload });
    await refreshMessages();
    await refreshUnread();
  }

  async function sendLinkToNotes() {
    const title = linkDialog.title.trim() || 'Ссылка на раздел';
    const payload = buildLinkPayload();
    await upsertNote({ title, body: [{ id: crypto.randomUUID(), kind: 'link', appLink: payload }], importance: 'normal' });
    setLinkDialog({ open: false, title: 'Ссылка на раздел' });
  }

  async function handleFilePicked(file: File | null) {
    if (!file) return;
    setSendingFile(true);
    try {
      const scope = { ownerType: 'chat', ownerId: 'chat-files', category: 'chat-files' };
      if (file.size > 10 * 1024 * 1024) {
        const buf = await file.arrayBuffer();
        const sha256 = await sha256Hex(buf);
        const init = await chatApi.initLargeUpload({ name: file.name, size: file.size, sha256, mime: file.type || null, scope });
        if (!init?.ok) {
          setSendingFile(false);
          return;
        }
        if (init.uploadUrl) {
          await fetch(init.uploadUrl, { method: 'PUT', body: new Blob([buf]) });
        }
        await chatApi.sendFile({ recipientUserId: selectedUserId, fileId: init.file.id });
      } else {
        const up = await chatApi.uploadSmallFile(file, scope);
        if (up?.ok && up.file?.id) {
          await chatApi.sendFile({ recipientUserId: selectedUserId, fileId: up.file.id });
        }
      }
      await refreshMessages();
      await refreshUnread();
    } finally {
      setSendingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function openFile(fileId: string) {
    const u = await chatApi.fileUrl(fileId).catch(() => null);
    if (u?.ok && u.url) {
      window.open(u.url as string, '_blank', 'noopener,noreferrer');
      return;
    }
    const access = localStorage.getItem('matrica_access_token');
    const r = await fetch(`${apiBase}/files/${encodeURIComponent(fileId)}`, {
      headers: access ? { Authorization: `Bearer ${access}` } : undefined,
    });
    if (!r.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function exportChats() {
    if (!props.canExport || !props.canAdminViewAll) return;
    const startMs = exportRange.start ? new Date(exportRange.start).getTime() : NaN;
    const endMs = exportRange.end ? new Date(exportRange.end).getTime() : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const r = await chatApi.exportChats(startMs, endMs);
    if (!r.ok || typeof r.text !== 'string') return;
    const blob = new Blob([r.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat_export_${new Date(startMs).toISOString().slice(0, 10)}_${new Date(endMs).toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 20_000);
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ padding: 10, borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 900, color: '#111827', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Чат с пользователями
        </div>
        {props.canAdminViewAll && (
          <Button variant="ghost" onClick={() => setAdminMode((v) => !v)} title="Админ просмотр всех чатов">
            {adminMode ? 'Обычный режим' : 'Админ режим'}
          </Button>
        )}
        {!adminMode && (
          <div>
            <Button ref={othersButtonRef} variant="ghost" onClick={() => setOthersOpen((v) => !v)}>
              Другие
            </Button>
            {othersOpen &&
              otherUsers.length > 0 &&
              createPortal(
                <div
                  ref={othersMenuRef}
                  style={{
                    position: 'fixed',
                    left: othersMenuPos?.left ?? 0,
                    top: othersMenuPos?.top ?? 0,
                    zIndex: 10000,
                    minWidth: 220,
                    maxWidth: 320,
                    maxHeight: othersMenuPos?.maxHeight ?? 360,
                    overflowY: 'auto',
                    background: '#ffffff',
                    border: '1px solid #e5e7eb',
                    boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
                    borderRadius: 10,
                    padding: 8,
                  }}
                >
                  {otherUsers.map((u) => {
                    const uUnread = byUserUnread[u.id] ?? 0;
                    const label = `${u.username}${uUnread > 0 ? ` (${uUnread})` : ''}`;
                    const roleStyle = roleStyles(u.role);
                    return (
                      <button
                        key={u.id}
                        onClick={() => {
                          setSelectedUserId(u.id);
                          setOthersOpen(false);
                        }}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          marginBottom: 6,
                          padding: '6px 8px',
                          border: `1px solid ${roleStyle.border}`,
                          background: roleStyle.background,
                          color: roleStyle.color,
                          borderRadius: 8,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                        title="Оффлайн"
                      >
                        {dot('#dc2626', false)}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}
          </div>
        )}
      </div>

      <div style={{ padding: 10, borderBottom: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!adminMode ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {!isPending && (
              <Button variant={selectedUserId == null ? 'primary' : 'ghost'} onClick={() => setSelectedUserId(null)} title="Перейти в общий чат">
                Общий чат{unread && unread.ok === true && unread.global > 0 ? ` (${unread.global})` : ''}
              </Button>
            )}
            {onlineUsers
              .map((u) => {
                const uUnread = byUserUnread[u.id] ?? 0;
                const isSel = selectedUserId === u.id;
                const indicator = dot('#16a34a', true);
                const label = `${u.username}${uUnread > 0 ? ` (${uUnread})` : ''}`;
                const roleStyle = roleStyles(u.role);
                return (
                  <Button
                    key={u.id}
                    variant={isSel ? 'primary' : 'ghost'}
                    onClick={() => setSelectedUserId(u.id)}
                    title={u.online ? 'Онлайн' : 'Оффлайн'}
                    style={{
                      border: `1px solid ${roleStyle.border}`,
                      background: roleStyle.background,
                      color: roleStyle.color,
                      boxShadow: isSel ? '0 0 0 2px rgba(15, 23, 42, 0.2)' : undefined,
                    }}
                  >
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {indicator}
                      {uUnread > 0 ? (
                        <span
                          className="chatBlink"
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 999,
                            display: 'inline-block',
                            background: '#b91c1c',
                          }}
                          title="Непрочитанные сообщения"
                        />
                      ) : null}
                      <span>{label}</span>
                    </span>
                  </Button>
                );
              })}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={adminPair.aId} onChange={(e) => setAdminPair((s) => ({ ...s, aId: e.target.value }))} style={{ width: '100%', padding: 6 }} title="Пользователь A">
              <option value="">Пользователь A…</option>
              {users.filter((u) => u.isActive).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
            <select value={adminPair.bId} onChange={(e) => setAdminPair((s) => ({ ...s, bId: e.target.value }))} style={{ width: '100%', padding: 6 }} title="Пользователь B">
              <option value="">Пользователь B…</option>
              {users.filter((u) => u.isActive).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="muted" style={{ fontSize: 12 }}>
          {modeLabel}
          {privateWith ? `: ${privateWith.username}` : ''}
        </div>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 10 }}>
        {messages.length === 0 && <div className="muted">Сообщений пока нет.</div>}
        {messages.map((m) => {
          const mine = m.senderUserId === props.meUserId;
          const bubbleBg = mine ? '#ecfeff' : '#f8fafc';
          const border = mine ? '#a5f3fc' : '#e5e7eb';
          const infoOpen = openInfoId === m.id;
          const linkPayload = m.messageType === 'deep_link' ? (m.payload as any) : null;
          const breadcrumbsRaw = Array.isArray(linkPayload?.breadcrumbs) ? linkPayload.breadcrumbs : [];
          const breadcrumbs = breadcrumbsRaw.map((x: any) => String(x ?? '').trim()).filter(Boolean);
          const breadcrumbText = breadcrumbs.join(' / ');
          return (
            <div key={m.id} style={{ marginBottom: 8, display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '92%', border: `1px solid ${border}`, background: bubbleBg, borderRadius: 12, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: '#111827' }}>{m.senderUsername}</div>
                  <span style={{ flex: 1 }} />
                  <button
                    onClick={() => setOpenInfoId((prev) => (prev === m.id ? null : m.id))}
                    title="Доп. сведения"
                    style={{
                      border: '1px solid #e5e7eb',
                      background: '#ffffff',
                      color: '#111827',
                      width: 22,
                      height: 22,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 800,
                      cursor: 'pointer',
                      borderRadius: 6,
                    }}
                  >
                    i
                  </button>
                </div>
                {m.messageType === 'text' && <div style={{ whiteSpace: 'pre-wrap', color: '#111827' }}>{m.bodyText}</div>}
                {m.messageType === 'file' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ color: '#111827' }}>{m.bodyText || 'Файл'}</div>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const fileId = m.payload?.id ? String(m.payload.id) : '';
                        if (fileId) void openFile(fileId);
                      }}
                    >
                      Открыть файл
                    </Button>
                  </div>
                )}
                {m.messageType === 'deep_link' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ color: '#111827' }}>Ссылка на раздел</div>
                    {breadcrumbText ? <div className="muted" style={{ fontSize: 12 }}>{breadcrumbText}</div> : null}
                    <Button variant="ghost">Открыть в клиенте</Button>
                  </div>
                )}
                <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280', textAlign: mine ? 'right' : 'left' }}>
                  {new Date(m.createdAt).toLocaleString('ru-RU')}
                </div>
                {infoOpen && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e5e7eb', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {new Date(m.createdAt).toLocaleString('ru-RU')}
                    </div>
                    {breadcrumbText ? <div className="muted" style={{ fontSize: 12 }}>Путь: {breadcrumbText}</div> : null}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          insertMention(m.senderUsername);
                          setOpenInfoId(null);
                        }}
                      >
                        Ответить
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setOpenInfoId(null);
                          openNoteDialog(m);
                        }}
                      >
                        Отправить в заметки
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div style={{ borderTop: '1px solid #e5e7eb', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Введите сообщение…"
            disabled={adminMode}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendText();
              }
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button onClick={() => void sendText()} disabled={adminMode || !text.trim()}>
            Отправить
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              if (fileInputRef.current) fileInputRef.current.click();
            }}
            disabled={adminMode || sendingFile}
          >
            {sendingFile ? 'Загрузка…' : 'Файл…'}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              void handleFilePicked(file);
            }}
          />
        </div>

        {!adminMode && (
          <div style={{ marginTop: 4, paddingTop: 10, borderTop: '1px dashed #e5e7eb', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 900, color: '#111827' }}>Ссылка на раздел (для клиента Windows)</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select value={linkDraft.tab} onChange={(e) => setLinkDraft((s) => ({ ...s, tab: e.target.value }))} style={{ padding: 6 }}>
                <option value="masterdata">masterdata</option>
                <option value="contracts">contracts</option>
                <option value="contract">contract</option>
                <option value="admin">admin</option>
                <option value="engines">engines</option>
                <option value="engine">engine</option>
                <option value="requests">requests</option>
                <option value="request">request</option>
                <option value="parts">parts</option>
                <option value="part">part</option>
                <option value="employees">employees</option>
                <option value="employee">employee</option>
                <option value="changes">changes</option>
                <option value="reports">reports</option>
                <option value="audit">audit</option>
                <option value="notes">notes</option>
                <option value="settings">settings</option>
                <option value="auth">auth</option>
              </select>
              <Input value={linkDraft.engineId} onChange={(e) => setLinkDraft((s) => ({ ...s, engineId: e.target.value }))} placeholder="engineId (опц.)" />
              <Input value={linkDraft.requestId} onChange={(e) => setLinkDraft((s) => ({ ...s, requestId: e.target.value }))} placeholder="requestId (опц.)" />
              <Input value={linkDraft.partId} onChange={(e) => setLinkDraft((s) => ({ ...s, partId: e.target.value }))} placeholder="partId (опц.)" />
            </div>
            <Button variant="ghost" onClick={() => setLinkDialog({ open: true, title: 'Ссылка на раздел' })}>
              Отправить ссылку
            </Button>
          </div>
        )}

        {props.canAdminViewAll && props.canExport && (
          <div style={{ marginTop: 4, paddingTop: 10, borderTop: '1px dashed #e5e7eb', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 900, color: '#111827' }}>Админ: экспорт чатов</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={exportRange.start} onChange={(e) => setExportRange((s) => ({ ...s, start: e.target.value }))} placeholder="start (например, 2026-01-01)" />
              <Input value={exportRange.end} onChange={(e) => setExportRange((s) => ({ ...s, end: e.target.value }))} placeholder="end (например, 2026-01-31)" />
            </div>
            <Button variant="ghost" onClick={() => void exportChats()}>
              Выгрузить в файл…
            </Button>
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
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, width: 420 }}>
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

      {linkDialog.open && (
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
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, width: 420 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Отправить ссылку</div>
            <Input
              value={linkDialog.title}
              onChange={(e) => setLinkDialog((prev) => ({ ...prev, title: e.target.value }))}
              placeholder="Заголовок заметки (для заметок)"
              onKeyDown={(e: any) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void sendLinkToNotes();
                }
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Button
                variant="ghost"
                onClick={() => {
                  void sendLinkToChat();
                  setLinkDialog({ open: false, title: 'Ссылка на раздел' });
                }}
              >
                Отправить в чат
              </Button>
              <Button variant="primary" onClick={() => void sendLinkToNotes()}>
                Создать заметку
              </Button>
              <Button variant="ghost" onClick={() => setLinkDialog({ open: false, title: 'Ссылка на раздел' })}>
                Отмена
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

