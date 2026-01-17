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

export function ChatPanel(props: {
  meUserId: string;
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

  const modeLabel = adminMode ? `Админ просмотр` : selectedUserId ? `Приватный чат` : `Общий чат`;
  const privateWith = !adminMode && selectedUserId ? users.find((u) => u.id === selectedUserId) ?? null : null;

  const byUserUnread = useMemo(() => {
    if (!unread || (unread as any).ok !== true) return {};
    return (unread as any).byUser as Record<string, number>;
  }, [unread]);

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
                const indicator = u.online ? dot('#16a34a') : dot('#dc2626');
                const label = `${u.username}${uUnread > 0 ? ` (${uUnread})` : ''}`;
                return (
                  <Button
                    key={u.id}
                    variant={isSel ? 'primary' : 'ghost'}
                    onClick={() => setSelectedUserId(u.id)}
                    title={u.online ? 'Онлайн' : 'Оффлайн'}
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
            <select
              value={adminPair.aId}
              onChange={(e) => setAdminPair((s) => ({ ...s, aId: e.target.value }))}
              style={{ width: '100%', padding: 6 }}
              title="Пользователь A"
            >
              <option value="">Пользователь A…</option>
              {users.filter((u) => u.isActive).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
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
                  {u.username}
                </option>
              ))}
            </select>
          </div>
        )}
        <div style={{ color: '#6b7280', fontSize: 12 }}>
          {modeLabel}
          {privateWith ? `: ${privateWith.username}` : ''}
        </div>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 10 }}>
        {messages.length === 0 && <div style={{ color: '#6b7280' }}>Сообщений пока нет.</div>}
        {messages.map((m) => {
          const mine = m.senderUserId === props.meUserId;
          const bubbleBg = mine ? '#ecfeff' : '#f8fafc';
          const border = mine ? '#a5f3fc' : '#e5e7eb';
          return (
            <div key={m.id} style={{ marginBottom: 8, display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '92%', border: `1px solid ${border}`, background: bubbleBg, borderRadius: 12, padding: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#111827' }}>{m.senderUsername}</div>
                {m.messageType === 'text' && <div style={{ whiteSpace: 'pre-wrap', color: '#111827' }}>{m.bodyText}</div>}
                {m.messageType === 'file' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ color: '#111827' }}>{m.bodyText || 'Файл'}</div>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const fileId = (m.payload as any)?.id ? String((m.payload as any).id) : '';
                        if (fileId) void window.matrica.files.open({ fileId });
                      }}
                    >
                      Открыть файл
                    </Button>
                  </div>
                )}
                {m.messageType === 'deep_link' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ color: '#111827' }}>Ссылка на раздел</div>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const link = m.payload as any;
                        if (link && link.kind === 'app_link') props.onNavigate(link as ChatDeepLinkPayload);
                      }}
                    >
                      Открыть
                    </Button>
                  </div>
                )}
                <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280', textAlign: mine ? 'right' : 'left' }}>
                  {new Date(m.createdAt).toLocaleString('ru-RU')}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div style={{ borderTop: `1px solid ${theme.colors.border}`, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
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

