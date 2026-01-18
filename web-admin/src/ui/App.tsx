import React, { useEffect, useState } from 'react';

import { login, logout, me, register } from '../api/auth.js';
import { clearTokens } from '../api/client.js';
import { presenceMe } from '../api/presence.js';
import { deriveCaps } from '../auth/permissions.js';
import { MasterdataPage } from './AdminPage.js';
import { AdminUsersPage } from './AdminUsersPage.js';
import { ChatPanel } from './ChatPanel.js';
import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { Tabs } from './components/Tabs.js';
import { UserSettingsPage, type UiPrefs } from './UserSettingsPage.js';

type AuthUser = { id: string; username: string; role: string };

const PREFS_KEY = 'matrica_webadmin_prefs';
const LOG_KEY = 'matrica_webadmin_log';

function loadPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      return { theme: 'auto', chatSide: 'right', chatDocked: false, loggingEnabled: false };
    }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'auto' ? parsed.theme : 'auto',
      chatSide: parsed.chatSide === 'left' || parsed.chatSide === 'right' ? parsed.chatSide : 'right',
      chatDocked: parsed.chatDocked === true,
      loggingEnabled: parsed.loggingEnabled === true,
    };
  } catch {
    return { theme: 'auto', chatSide: 'right', chatDocked: false, loggingEnabled: false };
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
  const [tab, setTab] = useState<'masterdata' | 'admin' | 'chat' | 'settings' | 'auth'>('auth');
  const [prefs, setPrefs] = useState<UiPrefs>(() => loadPrefs());
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => resolveTheme(loadPrefs().theme));

  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [registerForm, setRegisterForm] = useState({ login: '', password: '', fullName: '', position: '' });

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
  const visibleTabs = [
    ...(caps.canViewMasterData ? ([{ id: 'masterdata', label: 'Справочники' }] as const) : []),
    ...(caps.canManageUsers ? ([{ id: 'admin', label: 'Админ' }] as const) : []),
    ...(caps.canChatUse ? ([{ id: 'chat', label: 'Чат' }] as const) : []),
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

  if (loading) {
    return (
      <div className="page">
        <div className="card">Загрузка…</div>
      </div>
    );
  }

  return (
    <div className="page">
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
        />
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
        {user && caps.canChatUse && prefs.chatDocked && prefs.chatSide === 'left' && tab !== 'chat' && (
          <div className="card" style={{ flex: '0 0 320px', overflow: 'hidden' }}>
            <ChatPanel meUserId={user.id} meRole={user.role} canExport={caps.canChatExport} canAdminViewAll={caps.canChatAdminView} />
          </div>
        )}
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          {tab === 'masterdata' && <MasterdataPage canViewMasterData={caps.canViewMasterData} canEditMasterData={caps.canEditMasterData} />}
          {tab === 'admin' && <AdminUsersPage canManageUsers={caps.canManageUsers} me={user} />}
          {tab === 'chat' && user && (
            <ChatPanel meUserId={user.id} meRole={user.role} canExport={caps.canChatExport} canAdminViewAll={caps.canChatAdminView} />
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
                >
                  {authMode === 'login' ? 'Войти' : 'Зарегистрироваться'}
                </Button>
              </div>
            </div>
          )}
        </div>
        {user && caps.canChatUse && prefs.chatDocked && prefs.chatSide === 'right' && tab !== 'chat' && (
          <div className="card" style={{ flex: '0 0 320px', overflow: 'hidden' }}>
            <ChatPanel meUserId={user.id} meRole={user.role} canExport={caps.canChatExport} canAdminViewAll={caps.canChatAdminView} />
          </div>
        )}
      </div>
    </div>
  );
}

