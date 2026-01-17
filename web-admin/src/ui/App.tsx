import React, { useEffect, useState } from 'react';

import { login, logout, me } from '../api/auth.js';
import { clearTokens } from '../api/client.js';
import { deriveCaps } from '../auth/permissions.js';
import { AdminPage } from './AdminPage.js';
import { ChatPanel } from './ChatPanel.js';
import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { Tabs } from './components/Tabs.js';

type AuthUser = { id: string; username: string; role: string };

export function App() {
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<'admin' | 'chat'>('admin');

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
    if (!u || String(u.role ?? '').toLowerCase() !== 'admin') {
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
          <div className="muted">
            {user.username} ({user.role})
          </div>
          <Button variant="ghost" onClick={() => void doLogout()}>
            Выйти
          </Button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <Tabs
          tabs={[
            { id: 'admin', label: 'Справочники и права' },
            { id: 'chat', label: 'Чат' },
          ]}
          active={tab}
          onChange={(id) => setTab(id as any)}
        />
      </div>

      {tab === 'admin' && <AdminPage permissions={permissions} canViewMasterData={caps.canViewMasterData} canEditMasterData={caps.canEditMasterData} canManageUsers={caps.canManageUsers} />}
      {tab === 'chat' && <ChatPanel meUserId={user.id} canExport={caps.canChatExport} canAdminViewAll={caps.canChatAdminView} />}
    </div>
  );
}

