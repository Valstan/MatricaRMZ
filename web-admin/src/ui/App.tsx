import React, { useEffect, useState } from 'react';
import type { NoteItem, NoteShareItem } from '@matricarmz/shared';

import { login, logout, me, register } from '../api/auth.js';
import { clearTokens } from '../api/client.js';
import { presenceMe } from '../api/presence.js';
import * as masterdata from '../api/masterdata.js';
import { deriveCaps } from '../auth/permissions.js';
import { MasterdataPage } from './AdminPage.js';
import { AuditPage } from './AuditPage.js';
import { AdminUsersPage } from './AdminUsersPage.js';
import { ClientAdminPage } from './ClientAdminPage.js';
import { DiagnosticsPage } from './DiagnosticsPage.js';
import { ChatPanel } from './ChatPanel.js';
import { sendText } from '../api/chat.js';
import { ContractsPage } from './ContractsPage.js';
import { EnginesPage } from './EnginesPage.js';
import { NotesPage } from './NotesPage.js';
import { listNotes } from '../api/notes.js';
import { listAudit } from '../api/audit.js';
import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { Tabs } from './components/Tabs.js';
import { UserSettingsPage, type UiPrefs } from './UserSettingsPage.js';

type AuthUser = { id: string; username: string; role: string };
type MasterdataTypeRow = { id: string; code: string; name: string };

const PREFS_KEY = 'matrica_webadmin_prefs';
const LOG_KEY = 'matrica_webadmin_log';

function loadPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      return { theme: 'auto', chatSide: 'right', chatDocked: false, loggingEnabled: false, pinnedMasterdataTypeIds: [] };
    }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    const pinned = Array.isArray(parsed.pinnedMasterdataTypeIds)
      ? parsed.pinnedMasterdataTypeIds.filter((id) => typeof id === 'string')
      : [];
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'auto' ? parsed.theme : 'auto',
      chatSide: parsed.chatSide === 'left' || parsed.chatSide === 'right' ? parsed.chatSide : 'right',
      chatDocked: parsed.chatDocked === true,
      loggingEnabled: parsed.loggingEnabled === true,
      pinnedMasterdataTypeIds: pinned,
    };
  } catch {
    return { theme: 'auto', chatSide: 'right', chatDocked: false, loggingEnabled: false, pinnedMasterdataTypeIds: [] };
  }
}

function savePrefs(prefs: UiPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  localStorage.setItem(LOG_KEY, prefs.loggingEnabled ? 'true' : 'false');
}

function resolveTheme(theme: UiPrefs['theme']) {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  return mq?.matches ? 'dark' : 'light';
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [presence, setPresence] = useState<{ online: boolean; lastActivityAt: number | null } | null>(null);
  const [tab, setTab] = useState<string>('auth');
  const [prefs, setPrefs] = useState<UiPrefs>(() => loadPrefs());
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => resolveTheme(loadPrefs().theme));
  const [masterdataTypes, setMasterdataTypes] = useState<MasterdataTypeRow[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [auditStatus, setAuditStatus] = useState<string>('');
  const [notesAlertCount, setNotesAlertCount] = useState<number>(0);
  const [chatContext, setChatContext] = useState<{ selectedUserId: string | null; adminMode: boolean }>({
    selectedUserId: null,
    adminMode: false,
  });

  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [registerForm, setRegisterForm] = useState({ login: '', password: '', fullName: '', position: '' });

  useEffect(() => {
    function openFromParams(params: URLSearchParams) {
      const typeCode = String(params.get('openType') ?? '').trim();
      const entityId = String(params.get('openId') ?? '').trim();
      if (!typeCode || !entityId) return;
      const payload = { typeCode, entityId, at: Date.now() };
      localStorage.setItem('diagnostics.openEntity', JSON.stringify(payload));
      if (typeCode === 'contract') {
        setTab('contracts');
        return;
      }
      if (typeCode === 'engine') {
        setTab('engines');
        return;
      }
      void (async () => {
        const res = await masterdata.listEntityTypes();
        if (!res?.ok) {
          setTab('masterdata');
          return;
        }
        const types = res.rows ?? [];
        const match = types.find((t: any) => String(t.code) === typeCode);
        if (!match?.id) {
          setTab('masterdata');
          return;
        }
        localStorage.setItem('diagnostics.openEntity', JSON.stringify({ ...payload, typeId: String(match.id) }));
        setTab(`masterdata:${String(match.id)}`);
      })();
    }

    function handleOpenEntity(e: Event) {
      const ce = e as CustomEvent<{ typeCode?: string; entityId?: string }>;
      const typeCode = String(ce?.detail?.typeCode ?? '').trim();
      const entityId = String(ce?.detail?.entityId ?? '').trim();
      if (!typeCode || !entityId) return;
      openFromParams(new URLSearchParams({ openType: typeCode, openId: entityId }));
    }

    const params = new URLSearchParams(window.location.search);
    openFromParams(params);

    const onPop = () => {
      const next = new URLSearchParams(window.location.search);
      openFromParams(next);
    };

    window.addEventListener('diagnostics:open-entity', handleOpenEntity as EventListener);
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('diagnostics:open-entity', handleOpenEntity as EventListener);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  async function refreshMe() {
    const r = await me();
    if (!r?.ok) {
      setUser(null);
      setPermissions({});
      setLoading(false);
      return;
    }
    const u = r.user as AuthUser;
    const role = String(u?.role ?? '').toLowerCase();
    if (!u) {
      setAuthError('Не удалось получить пользователя.');
      clearTokens();
      setUser(null);
      setPermissions({});
      setLoading(false);
      return;
    }
    const perms = (r.permissions ?? {}) as Record<string, boolean>;
    if (role !== 'admin' && role !== 'superadmin' && role !== 'pending') {
      setAuthError('Доступ только для администраторов или ожидающих одобрения.');
      clearTokens();
      setUser(null);
      setPermissions({});
      setLoading(false);
      return;
    }
    setUser(u);
    setPermissions(perms);
    setLoading(false);
  }

  useEffect(() => {
    void refreshMe();
  }, []);

  useEffect(() => {
    savePrefs(prefs);
    const next = resolveTheme(prefs.theme);
    setResolvedTheme(next);
  }, [prefs]);

  useEffect(() => {
    document.body.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    if (prefs.theme !== 'auto' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setResolvedTheme(resolveTheme('auto'));
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, [prefs.theme]);

  useEffect(() => {
    if (!user) {
      setPresence(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      const r = await presenceMe().catch(() => null);
      if (!alive) return;
      if (r && (r as any).ok) {
        setPresence({ online: !!(r as any).online, lastActivityAt: (r as any).lastActivityAt ?? null });
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [user?.id]);

  async function doLogin() {
    setAuthError(null);
    const r = await login(loginForm.username, loginForm.password);
    if (!r?.ok) {
      setAuthError(r?.error ?? 'Ошибка входа');
      return;
    }
    await refreshMe();
  }

  async function doLogout() {
    await logout();
    setUser(null);
    setPermissions({});
    setTab('auth');
  }

  const caps = deriveCaps(permissions);
  const userTab = user ? 'settings' : 'auth';
  const userLabel = user ? user.username : 'Вход';
  const masterdataTabPrefix = 'masterdata:';
  const pinnedTypeIds = prefs.pinnedMasterdataTypeIds ?? [];
  const pinnedTabs = caps.canViewMasterData
    ? pinnedTypeIds
        .map((typeId) => {
          const t = masterdataTypes.find((row) => row.id === typeId);
          if (!t) return null;
          return {
            id: `${masterdataTabPrefix}${typeId}`,
            label: t.name ?? `Справочник ${typeId.slice(0, 6)}`,
          };
        })
        .filter(Boolean)
    : [];
  const visibleTabs = [
    ...(caps.canViewMasterData ? ([{ id: 'masterdata', label: 'Справочники' }] as const) : []),
    ...pinnedTabs,
    ...(caps.canViewMasterData ? ([{ id: 'contracts', label: 'Контракты' }] as const) : []),
    ...(caps.canViewEngines ? ([{ id: 'engines', label: 'Двигатели' }] as const) : []),
    ...(caps.canManageUsers ? ([{ id: 'admin', label: 'Админ' }] as const) : []),
    ...(caps.canManageClients ? ([{ id: 'clients', label: 'Клиенты' }] as const) : []),
    ...(caps.canManageClients ? ([{ id: 'diagnostics', label: 'Диагностика' }] as const) : []),
    ...(caps.canChatUse ? ([{ id: 'chat', label: 'Чат' }] as const) : []),
    ...(user ? ([{ id: 'notes', label: 'Заметки' }] as const) : []),
    ...(caps.canViewAudit ? ([{ id: 'audit', label: 'Журнал' }] as const) : []),
  ];
  const visibleTabIds = visibleTabs.map((t) => t.id).join('|');

  useEffect(() => {
    if (!user && tab !== 'auth') setTab('auth');
  }, [user, tab]);

  useEffect(() => {
    const role = String(user?.role ?? '').toLowerCase();
    if (user && role === 'pending' && caps.canChatUse && tab !== 'chat') setTab('chat');
  }, [user, caps.canChatUse, tab]);

  useEffect(() => {
    if (tab === userTab) return;
    const ids = visibleTabs.map((t) => t.id);
    if (ids.includes(tab)) return;
    setTab(userTab);
  }, [tab, visibleTabIds, userTab]);

  useEffect(() => {
    if (!user || !caps.canViewMasterData) {
      setMasterdataTypes([]);
      return;
    }
    let alive = true;
    void (async () => {
      const r = await masterdata.listEntityTypes().catch(() => null);
      if (!alive) return;
      if (r && (r as any).ok) setMasterdataTypes((r as any).rows ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [user?.id, caps.canViewMasterData]);

  async function refreshAudit() {
    if (!caps.canViewAudit) return;
    try {
      setAuditStatus('Загрузка…');
      const r = await listAudit({ limit: 2000 });
      if (!r?.ok) {
        setAuditStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      setAudit(r.rows ?? []);
      setAuditStatus('');
    } catch (e) {
      setAuditStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    if (tab === 'audit') void refreshAudit();
  }, [tab, user?.id, caps.canViewAudit]);

  function noteToChatText(note: { title: string; body: Array<any> }) {
    const lines: string[] = [];
    lines.push(note.title || 'Заметка');
    lines.push('');
    for (const b of note.body ?? []) {
      if (b?.kind === 'text') lines.push(String(b.text ?? ''));
      if (b?.kind === 'link') {
        if (b.url) lines.push(String(b.url));
        if (b.appLink?.tab) lines.push(`app:${String(b.appLink.tab)}`);
      }
      if (b?.kind === 'image') lines.push(`[image:${String(b.name ?? b.fileId ?? '')}]`);
    }
    return lines.join('\n').trim();
  }

  async function sendNoteToChat(note: { title: string; body: Array<any> }) {
    const chatVisible = tab === 'chat' || (prefs.chatDocked && prefs.chatSide);
    if (!chatVisible) {
      setAuthError('Откройте чат, чтобы отправить заметку.');
      return;
    }
    if (chatContext.adminMode) {
      setAuthError('Нельзя отправить заметку в админ-режиме чата.');
      return;
    }
    const text = noteToChatText(note);
    if (!text) return;
    await sendText({ recipientUserId: chatContext.selectedUserId ?? null, text });
  }

  useEffect(() => {
    if (!user) {
      setNotesAlertCount(0);
      return;
    }
    let alive = true;
    const tick = async () => {
      const r = await listNotes().catch(() => null);
      if (!alive) return;
      if (!r || !(r as any).ok) return;
      const notes = ((r as any).notes ?? []) as NoteItem[];
      const shares = ((r as any).shares ?? []) as NoteShareItem[];
      const shareByNote = new Map<string, NoteShareItem>();
      for (const s of shares) {
        if (s.recipientUserId === user.id) shareByNote.set(String(s.noteId), s);
      }
      const visible = notes.filter((n) => {
        if (n.ownerUserId === user.id) return true;
        const share = shareByNote.get(String(n.id));
        return share ? !share.hidden : false;
      });
      const now = Date.now();
      const count = visible.filter((n) => n.importance === 'burning' || (n.dueAt != null && n.dueAt < now)).length;
      setNotesAlertCount(count);
    };
    void tick();
    const id = setInterval(() => void tick(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [user?.id]);

  if (loading) {
    return (
      <div className="page">
        <div className="card">Загрузка…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="app-header">
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontWeight: 800 }}>MatricaRMZ Admin</div>
            <span style={{ flex: 1 }} />
            <div className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {presence ? (
                <span
                  className={presence.online ? 'chatBlink' : undefined}
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    display: 'inline-block',
                    background: presence.online ? '#16a34a' : '#dc2626',
                  }}
                  title={presence.online ? 'В сети' : 'Не в сети'}
                />
              ) : null}
            </div>
            <Button variant="ghost" onClick={() => setTab(userTab)}>
              {userLabel}
            </Button>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <Tabs
            tabs={visibleTabs}
            active={tab}
            onChange={(id) => setTab(id as any)}
            notesAlertCount={notesAlertCount}
          />
        </div>
      </div>

      <div className="app-content">
        <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flex: '1 1 auto', minHeight: 0 }}>
        {user && caps.canChatUse && prefs.chatDocked && prefs.chatSide === 'left' && tab !== 'chat' && (
          <div className="card" style={{ flex: '0 0 320px', overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <ChatPanel
              meUserId={user.id}
              meRole={user.role}
              canExport={caps.canChatExport}
              canAdminViewAll={caps.canChatAdminView}
              onChatContextChange={(ctx) => setChatContext(ctx)}
            />
          </div>
        )}
        <div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {(tab === 'masterdata' || tab.startsWith(masterdataTabPrefix)) && (
            <MasterdataPage
              canViewMasterData={caps.canViewMasterData}
              canEditMasterData={caps.canEditMasterData}
              pinnedTypeIds={pinnedTypeIds}
              selectedTypeId={tab.startsWith(masterdataTabPrefix) ? tab.slice(masterdataTabPrefix.length) : null}
              onPinnedChange={(next) => setPrefs((p) => ({ ...p, pinnedMasterdataTypeIds: next }))}
              onTypesChange={(next) => setMasterdataTypes(next)}
            />
          )}
          {tab === 'contracts' && (
            <ContractsPage
              canViewMasterData={caps.canViewMasterData}
              canEditMasterData={caps.canEditMasterData}
              canViewFiles={caps.canViewFiles}
              canUploadFiles={caps.canUploadFiles}
            />
          )}
          {tab === 'engines' && (
            <EnginesPage
              canViewEngines={caps.canViewEngines}
              canEditEngines={caps.canEditEngines}
              canEditMasterData={caps.canEditMasterData}
              canViewOperations={caps.canViewOperations}
              canEditOperations={caps.canEditOperations}
              canExportReports={caps.canExportReports}
              canViewFiles={caps.canViewFiles}
              canUploadFiles={caps.canUploadFiles}
            />
          )}
          {tab === 'admin' && <AdminUsersPage canManageUsers={caps.canManageUsers} me={user} />}
          {tab === 'clients' && <ClientAdminPage />}
          {tab === 'diagnostics' && <DiagnosticsPage />}
          {tab === 'audit' && <AuditPage audit={audit} onRefresh={refreshAudit} status={auditStatus} />}
          {tab === 'chat' && user && (
            <div style={{ flex: '1 1 auto', minHeight: 0 }}>
              <ChatPanel
                meUserId={user.id}
                meRole={user.role}
                canExport={caps.canChatExport}
                canAdminViewAll={caps.canChatAdminView}
                onChatContextChange={(ctx) => setChatContext(ctx)}
              />
            </div>
          )}
          {tab === 'notes' && user && (
            <div style={{ flex: '1 1 auto', minHeight: 0 }}>
              <NotesPage meUserId={user.id} canEdit={true} onSendToChat={sendNoteToChat} onBurningCountChange={(count) => setNotesAlertCount(count)} />
            </div>
          )}
          {tab === 'settings' && (
            <UserSettingsPage user={user} prefs={prefs} onPrefsChange={(next) => setPrefs(next)} onLogout={() => void doLogout()} />
          )}
          {tab === 'auth' && (
            <div className="card" style={{ maxWidth: 420 }}>
              <h2>Вход</h2>
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant={authMode === 'login' ? 'primary' : 'ghost'} onClick={() => setAuthMode('login')}>
                    Вход
                  </Button>
                  <Button variant={authMode === 'register' ? 'primary' : 'ghost'} onClick={() => setAuthMode('register')}>
                    Регистрация
                  </Button>
                </div>

                {authMode === 'login' ? (
                  <>
                    <Input
                      value={loginForm.username}
                      onChange={(e) => setLoginForm((p) => ({ ...p, username: e.target.value }))}
                      placeholder="логин"
                    />
                    <Input
                      type="password"
                      value={loginForm.password}
                      onChange={(e) => setLoginForm((p) => ({ ...p, password: e.target.value }))}
                      placeholder="пароль"
                    />
                  </>
                ) : (
                  <>
                    <Input
                      value={registerForm.login}
                      onChange={(e) => setRegisterForm((p) => ({ ...p, login: e.target.value }))}
                      placeholder="логин"
                    />
                    <Input
                      type="password"
                      value={registerForm.password}
                      onChange={(e) => setRegisterForm((p) => ({ ...p, password: e.target.value }))}
                      placeholder="пароль"
                    />
                    <div
                      style={{
                        marginTop: -4,
                        fontSize: 12,
                        color: registerForm.password
                          ? registerForm.password.trim().length >= 6
                            ? 'var(--success)'
                            : 'var(--danger)'
                          : 'var(--muted)',
                      }}
                    >
                      Минимум 6 символов
                    </div>
                    {registerForm.password && registerForm.password.trim().length < 6 && (
                      <div style={{ marginTop: -4, fontSize: 12, color: 'var(--danger)' }}>Пароль слишком короткий</div>
                    )}
                    <Input
                      value={registerForm.fullName}
                      onChange={(e) => setRegisterForm((p) => ({ ...p, fullName: e.target.value }))}
                      placeholder="ФИО"
                    />
                    <Input
                      value={registerForm.position}
                      onChange={(e) => setRegisterForm((p) => ({ ...p, position: e.target.value }))}
                      placeholder="Должность"
                    />
                  </>
                )}
                {authError && <div className="danger">{authError}</div>}
                <Button
                  onClick={async () => {
                    setAuthError(null);
                    if (authMode === 'login') {
                      await doLogin();
                      return;
                    }
                    const r = await register(registerForm);
                    if (!r?.ok) {
                      setAuthError(r?.error ?? 'Ошибка регистрации');
                      return;
                    }
                    await refreshMe();
                    setRegisterForm({ login: '', password: '', fullName: '', position: '' });
                  }}
                  disabled={authMode === 'register' && registerForm.password.trim().length < 6}
                >
                  {authMode === 'login' ? 'Войти' : 'Зарегистрироваться'}
                </Button>
              </div>
            </div>
          )}
        </div>
        {user && caps.canChatUse && prefs.chatDocked && prefs.chatSide === 'right' && tab !== 'chat' && (
          <div className="card" style={{ flex: '0 0 320px', overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <ChatPanel
              meUserId={user.id}
              meRole={user.role}
              canExport={caps.canChatExport}
              canAdminViewAll={caps.canChatAdminView}
              onChatContextChange={(ctx) => setChatContext(ctx)}
            />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

