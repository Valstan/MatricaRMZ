import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatDeepLinkPayload, ChatMessageItem, ChatUnreadCountResult, ChatUserItem } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { theme } from '../theme.js';

function dot(color: string) {
  return (
    <span
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
      background: 'var(--role-superadmin-bg)',
      border: 'var(--role-superadmin-border)',
      color: 'var(--role-superadmin-text)',
    };
  }
  if (role === 'admin') {
    return { background: 'var(--role-admin-bg)', border: 'var(--role-admin-border)', color: 'var(--role-admin-text)' };
  }
  return { background: 'var(--role-user-bg)', border: 'var(--role-user-border)', color: 'var(--role-user-text)' };
}

type MenuState = {
  message: ChatMessageItem;
  x: number;
  y: number;
  mode: 'hover' | 'context';
};

function formatMessageDate(ts: number) {
  const dt = new Date(ts);
  const parts = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(dt);
  const get = (type: 'day' | 'month' | 'year' | 'hour' | 'minute') => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${get('day')} ${get('month')} ${get('year')}`;
  const time = `${get('hour')}:${get('minute')}`;
  return `${date}, ${time}`;
}

export function ChatPanel(props: {
  meUserId: string;
  meRole: string;
  canExport: boolean;
  canAdminViewAll: boolean;
  onHide: () => void;
  onNavigate: (link: ChatDeepLinkPayload) => void;
  viewMode: boolean;
}) {
  const [users, setUsers] = useState<ChatUserItem[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [adminMode, setAdminMode] = useState<boolean>(false);
  const [adminPair, setAdminPair] = useState<{ aId: string; bId: string }>({ aId: '', bId: '' });
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [text, setText] = useState<string>('');
  const [unread, setUnread] = useState<ChatUnreadCountResult | null>(null);
  const [exportRange, setExportRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hoverCloseTimer = useRef<number | null>(null);

  const modeLabel = adminMode ? `Админ просмотр` : selectedUserId ? `Приватный чат` : `Общий чат`;
  const privateWith = !adminMode && selectedUserId ? users.find((u) => u.id === selectedUserId) ?? null : null;

  const byUserUnread = useMemo(() => {
    if (!unread || (unread as any).ok !== true) return {};
    return (unread as any).byUser as Record<string, number>;
  }, [unread]);

  const usersById = useMemo(() => {
    const map = new Map<string, ChatUserItem>();
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);

  const isAdmin = ['admin', 'superadmin'].includes(String(props.meRole ?? '').toLowerCase());

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

    const r = await window.matrica.chat.list({ mode: selectedUserId ? 'private' : 'global', withUserId: selectedUserId, limit: 200 }).catch(() => null);
    if (r && (r as any).ok) {
      const msgs = (r as any).messages as ChatMessageItem[];
      setMessages(msgs);
      // mark read (best-effort)
      const ids = msgs.filter((m) => m.senderUserId !== props.meUserId).map((m) => m.id);
      if (ids.length > 0) void window.matrica.chat.markRead({ messageIds: ids }).catch(() => {});
    }
  }

  // When chat is open: more frequent sync & refresh for responsiveness.
  useEffect(() => {
    if (props.viewMode) return;
    const id = setInterval(() => {
      void window.matrica.sync.run().catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, [props.viewMode]);

  // Poll users/unread/messages.
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
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current && menuRef.current.contains(t)) return;
      setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  function clearHoverCloseTimer() {
    if (hoverCloseTimer.current != null) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  }

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

  function openMenuAt(message: ChatMessageItem, x: number, y: number, mode: MenuState['mode']) {
    setMenu({ message, x, y, mode });
  }

  function handleReply(message: ChatMessageItem) {
    const info = getMessageUser(message);
    insertMention(info.name);
    setMenu(null);
  }

  function handleReplyPrivate(message: ChatMessageItem) {
    const info = getMessageUser(message);
    const targetUserId =
      message.senderUserId === props.meUserId ? (message.recipientUserId ? String(message.recipientUserId) : null) : message.senderUserId;
    if (!targetUserId) return;
    setAdminMode(false);
    setSelectedUserId(targetUserId);
    insertMention(info.name);
    setMenu(null);
  }

  async function handleDeleteMessage(message: ChatMessageItem) {
    const r = await window.matrica.chat.deleteMessage({ messageId: message.id }).catch(() => null);
    if (r && (r as any).ok) {
      setMenu(null);
      await refreshMessages();
      await refreshUnread();
    } else {
      setMenu(null);
    }
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

  async function sendFile() {
    if (adminMode) return;
    const picked = await window.matrica.files.pick().catch(() => null);
    if (!picked || !(picked as any).ok) return;
    const paths = (picked as any).paths as string[];
    const path = paths?.[0] ? String(paths[0]) : '';
    if (!path) return;
    const r = await window.matrica.chat.sendFile({ recipientUserId: selectedUserId, path });
    if ((r as any)?.ok && !props.viewMode) void window.matrica.sync.run().catch(() => {});
    await refreshMessages();
    await refreshUnread();
  }

  async function exportChats() {
    if (!props.canExport || !props.canAdminViewAll) return;
    const startMs = exportRange.start ? new Date(exportRange.start).getTime() : NaN;
    const endMs = exportRange.end ? new Date(exportRange.end).getTime() : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    void window.matrica.chat.export({ startMs, endMs });
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ padding: 10, borderBottom: `1px solid ${theme.colors.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 900, color: theme.colors.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Чат с пользователями
        </div>
        {props.canAdminViewAll && (
          <Button variant="ghost" onClick={() => setAdminMode((v) => !v)} title="Админ просмотр всех чатов">
            {adminMode ? 'Обычный режим' : 'Админ режим'}
          </Button>
        )}
        <Button variant="ghost" onClick={props.onHide}>
          Скрыть Чат
        </Button>
      </div>

      <div style={{ padding: 10, borderBottom: `1px solid ${theme.colors.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!adminMode ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Button
              variant={selectedUserId == null ? 'primary' : 'ghost'}
              onClick={() => setSelectedUserId(null)}
              title="Перейти в общий чат"
            >
              Общий чат{unread && (unread as any).ok === true && (unread as any).global > 0 ? ` (${(unread as any).global})` : ''}
            </Button>
            {users
              .filter((u) => u.isActive)
              .map((u) => {
                const uUnread = byUserUnread[u.id] ?? 0;
                const isSel = selectedUserId === u.id;
                const indicator = u.online ? dot('var(--success)') : dot('var(--danger)');
                const display = u.chatDisplayName || u.username;
                const label = `${display}${uUnread > 0 ? ` (${uUnread})` : ''}`;
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
                      boxShadow: isSel ? '0 0 0 2px rgba(15, 23, 42, 0.35)' : undefined,
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
                            background: 'var(--danger)',
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
        <div style={{ color: theme.colors.muted, fontSize: 12 }}>
          {modeLabel}
          {privateWith ? `: ${privateWith.chatDisplayName || privateWith.username}` : ''}
        </div>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 10 }}>
        {messages.length === 0 && <div style={{ color: theme.colors.muted }}>Сообщений пока нет.</div>}
        {messages.map((m) => {
          const mine = m.senderUserId === props.meUserId;
          const info = getMessageUser(m);
          const roleStyle = roleStyles(info.role);
          const canDelete = (mine || isAdmin) && !props.viewMode;
          const menuOpen = menu?.message.id === m.id;
          const infoText =
            m.messageType === 'file'
              ? m.bodyText || 'Файл'
              : m.messageType === 'deep_link'
                ? 'Ссылка на раздел'
                : m.bodyText || '';
          const isClickable = m.messageType === 'file' || m.messageType === 'deep_link';
          return (
            <div key={m.id} style={{ marginBottom: 6 }}>
              <div
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenuAt(m, e.clientX + 6, e.clientY + 6, 'context');
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: '6px 8px',
                  border: `1px solid ${mine ? theme.colors.chatMineBorder : theme.colors.chatOtherBorder}`,
                  background: mine ? theme.colors.chatMineBg : theme.colors.chatOtherBg,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '2px 8px',
                      border: `1px solid ${roleStyle.border}`,
                      background: roleStyle.background,
                      color: roleStyle.color,
                      fontWeight: 800,
                      fontSize: 12,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {info.online == null ? null : (
                        <span
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: 999,
                            display: 'inline-block',
                            background: info.online ? 'var(--success)' : 'var(--danger)',
                            boxShadow: '0 0 0 2px rgba(0,0,0,0.08)',
                          }}
                          title={info.online ? 'В сети' : 'Не в сети'}
                        />
                      )}
                      <span>{info.name}</span>
                      {info.role ? <span style={{ fontSize: 11, opacity: 0.9 }}>({info.role})</span> : null}
                      {info.online != null ? (
                        <span style={{ fontSize: 11, opacity: 0.85 }}>{info.online ? 'В сети' : 'Не в сети'}</span>
                      ) : null}
                    </span>
                  </span>
                  <span style={{ flex: 1 }} />
                  <button
                    onMouseEnter={(e) => {
                      clearHoverCloseTimer();
                      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                      openMenuAt(m, Math.round(rect.right + 8), Math.round(rect.top), 'hover');
                    }}
                    onMouseLeave={() => {
                      if (menu?.mode === 'hover' && menu?.message.id === m.id) {
                        hoverCloseTimer.current = window.setTimeout(() => setMenu(null), 120);
                      }
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                      openMenuAt(m, Math.round(rect.right + 8), Math.round(rect.top), 'context');
                    }}
                    title="Доп. сведения"
                    style={{
                      border: `1px solid ${theme.colors.border}`,
                      background: theme.colors.surface2,
                      color: theme.colors.text,
                      width: 22,
                      height: 22,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    i
                  </button>
                </div>
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
                  {infoText}
                </div>
              </div>
              {menuOpen && (
                <div
                  ref={menuRef}
                  onMouseEnter={() => clearHoverCloseTimer()}
                  onMouseLeave={() => {
                    if (menu?.mode === 'hover') setMenu(null);
                  }}
                  style={{
                    position: 'fixed',
                    left: menu?.x ?? 0,
                    top: menu?.y ?? 0,
                    minWidth: 220,
                    background: theme.colors.chatMenuBg,
                    border: `1px solid ${theme.colors.chatMenuBorder}`,
                    boxShadow: theme.colors.chatMenuShadow,
                    padding: 10,
                    zIndex: 1000,
                  }}
                >
                  <div style={{ color: theme.colors.muted, fontSize: 12, marginBottom: 8 }}>{formatMessageDate(m.createdAt)}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Button variant="ghost" onClick={() => handleReply(m)}>
                      Ответить
                    </Button>
                    <Button variant="ghost" onClick={() => handleReplyPrivate(m)}>
                      Ответить лично
                    </Button>
                    {canDelete ? (
                      <Button variant="ghost" onClick={() => void handleDeleteMessage(m)}>
                        Удалить
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div style={{ borderTop: `1px solid ${theme.colors.border}`, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
          <Button variant="ghost" onClick={() => void sendFile()} disabled={adminMode}>
            Файл…
          </Button>
        </div>

        {props.canAdminViewAll && props.canExport && (
          <div style={{ marginTop: 4, paddingTop: 10, borderTop: `1px dashed ${theme.colors.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 900, color: theme.colors.text }}>Админ: экспорт чатов</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                value={exportRange.start}
                onChange={(e) => setExportRange((s) => ({ ...s, start: e.target.value }))}
                placeholder="start (например, 2026-01-01)"
              />
              <Input
                value={exportRange.end}
                onChange={(e) => setExportRange((s) => ({ ...s, end: e.target.value }))}
                placeholder="end (например, 2026-01-31)"
              />
            </div>
            <Button variant="ghost" onClick={() => void exportChats()}>
              Выгрузить в файл…
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

