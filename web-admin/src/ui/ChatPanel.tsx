import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import * as chatApi from '../api/chat.js';

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
  const [sendingFile, setSendingFile] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const modeLabel = adminMode ? `Админ просмотр` : selectedUserId ? `Приватный чат` : `Общий чат`;
  const privateWith = !adminMode && selectedUserId ? users.find((u) => u.id === selectedUserId) ?? null : null;

  const byUserUnread = useMemo(() => {
    if (!unread || unread.ok !== true) return {};
    return unread.byUser as Record<string, number>;
  }, [unread]);

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

  async function sendText() {
    const t = text.trim();
    if (!t) return;
    if (adminMode) return;
    setText('');
    await chatApi.sendText({ recipientUserId: selectedUserId, text: t });
    await refreshMessages();
    await refreshUnread();
  }

  async function sendLink() {
    if (adminMode) return;
    const payload = {
      kind: 'app_link',
      tab: linkDraft.tab,
      engineId: linkDraft.engineId.trim() || null,
      requestId: linkDraft.requestId.trim() || null,
      partId: linkDraft.partId.trim() || null,
    };
    await chatApi.sendLink({ recipientUserId: selectedUserId, link: payload });
    await refreshMessages();
    await refreshUnread();
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
      </div>

      <div style={{ padding: 10, borderBottom: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!adminMode ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {!isPending && (
              <Button variant={selectedUserId == null ? 'primary' : 'ghost'} onClick={() => setSelectedUserId(null)} title="Перейти в общий чат">
                Общий чат{unread && unread.ok === true && unread.global > 0 ? ` (${unread.global})` : ''}
              </Button>
            )}
            {(isPending ? users.filter((u) => u.role === 'superadmin') : users.filter((u) => u.isActive))
              .map((u) => {
                const uUnread = byUserUnread[u.id] ?? 0;
                const isSel = selectedUserId === u.id;
                const indicator = u.online ? dot('#16a34a', true) : dot('#dc2626', false);
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

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 10 }}>
        {messages.length === 0 && <div className="muted">Сообщений пока нет.</div>}
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
                    <Button variant="ghost">Открыть в клиенте</Button>
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

      <div style={{ borderTop: '1px solid #e5e7eb', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                <option value="admin">admin</option>
                <option value="engines">engines</option>
                <option value="engine">engine</option>
                <option value="requests">requests</option>
                <option value="request">request</option>
                <option value="parts">parts</option>
                <option value="part">part</option>
                <option value="changes">changes</option>
                <option value="reports">reports</option>
                <option value="audit">audit</option>
                <option value="settings">settings</option>
                <option value="auth">auth</option>
              </select>
              <Input value={linkDraft.engineId} onChange={(e) => setLinkDraft((s) => ({ ...s, engineId: e.target.value }))} placeholder="engineId (опц.)" />
              <Input value={linkDraft.requestId} onChange={(e) => setLinkDraft((s) => ({ ...s, requestId: e.target.value }))} placeholder="requestId (опц.)" />
              <Input value={linkDraft.partId} onChange={(e) => setLinkDraft((s) => ({ ...s, partId: e.target.value }))} placeholder="partId (опц.)" />
            </div>
            <Button variant="ghost" onClick={() => void sendLink()}>
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
    </div>
  );
}

