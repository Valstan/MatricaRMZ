import React, { useEffect, useState } from 'react';

import type { AuthStatus } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

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

export function AuthPage(props: { onChanged?: (s: AuthStatus) => void }) {
  const [status, setStatus] = useState<AuthStatus>({ loggedIn: false, user: null });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string>('');
  const [presence, setPresence] = useState<{ online: boolean; lastActivityAt: number | null } | null>(null);

  async function refresh() {
    const s = await window.matrica.auth.status();
    setStatus(s);
    props.onChanged?.(s);
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!status.loggedIn) {
      setPresence(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      const r = await window.matrica.presence.me().catch(() => null);
      if (!alive) return;
      if (r && (r as any).ok) {
        setPresence({ online: !!(r as any).online, lastActivityAt: (r as any).lastActivityAt ?? null });
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [status.loggedIn]);

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Вход</h2>
      <div style={{ color: 'var(--muted)', marginBottom: 12 }}>
        Синхронизация теперь требует авторизации. Локальные данные доступны без входа, но push/pull будут работать только после входа.
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, maxWidth: 560, background: 'var(--surface)' }}>
        <div style={{ marginBottom: 10, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>Статус:</span>
          {presence ? (
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                display: 'inline-block',
                background: presence.online ? 'var(--success)' : 'var(--danger)',
                boxShadow: '0 0 0 2px rgba(0,0,0,0.08)',
              }}
              title={presence.online ? 'В сети' : 'Не в сети'}
            />
          ) : null}
          {status.loggedIn ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span>вошли как</span>
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: `1px solid ${roleStyles(status.user?.role ?? '').border}`,
                  background: roleStyles(status.user?.role ?? '').background,
                  color: roleStyles(status.user?.role ?? '').color,
                  fontWeight: 800,
                }}
              >
                {status.user?.username ?? '?'} ({status.user?.role ?? 'user'})
              </span>
            </span>
          ) : (
            <span>не выполнен вход</span>
          )}
        </div>

        {!status.loggedIn ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
              <div style={{ color: 'var(--muted)' }}>Логин</div>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
              <div style={{ color: 'var(--muted)' }}>Пароль</div>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <Button
                onClick={async () => {
                  setMsg('Входим...');
                  const r = await window.matrica.auth.login({ username, password });
                  if (!r.ok) {
                    setMsg(`Ошибка: ${r.error}`);
                    return;
                  }
                  setPassword('');
                  setMsg('OK: вход выполнен.');
                  await refresh();
                }}
              >
                Войти
              </Button>
              <Button variant="ghost" onClick={() => void refresh()}>
                Обновить
              </Button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            <Button
              variant="ghost"
              onClick={async () => {
                setMsg('Выходим...');
                const r = await window.matrica.auth.logout({});
                setMsg(r.ok ? 'OK: выход выполнен.' : `Ошибка: ${r.error ?? 'unknown'}`);
                await refresh();
              }}
            >
              Выйти
            </Button>
            <Button variant="ghost" onClick={() => void refresh()}>
              Обновить
            </Button>
          </div>
        )}

        {msg && <div style={{ marginTop: 10, color: 'var(--muted)' }}>{msg}</div>}
      </div>
    </div>
  );
}


