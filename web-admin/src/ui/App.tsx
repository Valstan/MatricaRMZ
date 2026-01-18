import React, { useEffect, useState } from 'react';

import { login, logout, me } from '../api/auth.js';
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
    if (!u || (role !== 'admin' && role !== 'superadmin')) {
      setAuthError('Доступ только для администраторов.');
      clearTokens();
      setUser(null);
      setPermissions({});
      setLoading(false);
      return;
    }
    setUser(u);
    setPermissions(r.permissions ?? {});
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

  if (loading) {
    return (
      <div className="page">
        <div className="card">Загрузка…</div>
      </div>
    );
  }

  const caps = deriveCaps(permissions);
  const userTab = user ? 'settings' : 'auth';
  const userLabel = user ? user.username : 'Вход';
  const visibleTabs = [
    ...(caps.canViewMasterData ? ([{ id: 'masterdata', label: 'Справочники' }] as const) : []),
    ...(caps.canManageUsers ? ([{ id: 'admin', label: 'Админ' }] as const) : []),
    ...(caps.canChatUse ? ([{ id: 'chat', label: 'Чат' }] as const) : []),
  ];

  useEffect(() => {
    if (!user && tab !== 'auth') setTab('auth');
  }, [user, tab]);

  useEffect(() => {
    if (tab === userTab) return;
    const ids = visibleTabs.map((t) => t.id);
    if (ids.includes(tab)) return;
    setTab(userTab);
  }, [tab, visibleTabs.map((t) => t.id).join('|'), userTab]);

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
            <ChatPanel meUserId={user.id} canExport={caps.canChatExport} canAdminViewAll={caps.canChatAdminView} />
          </div>
        )}
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          {tab === 'masterdata' && <MasterdataPage canViewMasterData={caps.canViewMasterData} canEditMasterData={caps.canEditMasterData} />}
          {tab === 'admin' && <AdminUsersPage canManageUsers={caps.canManageUsers} me={user} />}
          {tab === 'chat' && user && <ChatPanel meUserId={user.id} canExport={caps.canChatExport} canAdminViewAll={caps.canChatAdminView} />}
          {tab === 'settings' && (
            <UserSettingsPage user={user} prefs={prefs} onPrefsChange={(next) => setPrefs(next)} onLogout={() => void doLogout()} />
          )}
          {tab === 'auth' && (
            <div className="card" style={{ maxWidth: 420 }}>
              <h2>Вход в админ‑панель</h2>
              <div style={{ display: 'grid', gap: 10 }}>
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
                {authError && <div className="danger">{authError}</div>}
                <Button onClick={() => void doLogin()}>Войти</Button>
              </div>
            </div>
          )}
        </div>
        {user && caps.canChatUse && prefs.chatDocked && prefs.chatSide === 'right' && tab !== 'chat' && (
          <div className="card" style={{ flex: '0 0 320px', overflow: 'hidden' }}>
            <ChatPanel meUserId={user.id} canExport={caps.canChatExport} canAdminViewAll={caps.canChatAdminView} />
          </div>
        )}
      </div>
    </div>
  );
}

