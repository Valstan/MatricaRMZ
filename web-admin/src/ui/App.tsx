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

type AuthUser = { id: string; username: string; role: string };

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

export function App() {
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [presence, setPresence] = useState<{ online: boolean; lastActivityAt: number | null } | null>(null);
  const [tab, setTab] = useState<'masterdata' | 'admin' | 'chat'>('masterdata');

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
  }

  if (loading) {
    return (
      <div className="page">
        <div className="card">Загрузка…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="page">
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
      </div>
    );
  }

  const caps = deriveCaps(permissions);

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
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 999,
                border: `1px solid ${roleStyles(user.role).border}`,
                background: roleStyles(user.role).background,
                color: roleStyles(user.role).color,
                fontWeight: 800,
              }}
            >
              {user.username} ({user.role})
            </span>
          </div>
          <Button variant="ghost" onClick={() => void doLogout()}>
            Выйти
          </Button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <Tabs
          tabs={[
            { id: 'masterdata', label: 'Справочники' },
            { id: 'admin', label: 'Админ' },
            { id: 'chat', label: 'Чат' },
          ]}
          active={tab}
          onChange={(id) => setTab(id as any)}
        />
      </div>

      {tab === 'masterdata' && <MasterdataPage canViewMasterData={caps.canViewMasterData} canEditMasterData={caps.canEditMasterData} />}
      {tab === 'admin' && <AdminUsersPage canManageUsers={caps.canManageUsers} me={user} />}
      {tab === 'chat' && <ChatPanel meUserId={user.id} canExport={caps.canChatExport} canAdminViewAll={caps.canChatAdminView} />}
    </div>
  );
}

