import React, { useEffect, useState } from 'react';

import type { AuthStatus } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

export function AuthPage(props: { onChanged?: (s: AuthStatus) => void }) {
  const [status, setStatus] = useState<AuthStatus>({ loggedIn: false, user: null });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string>('');

  async function refresh() {
    const s = await window.matrica.auth.status();
    setStatus(s);
    props.onChanged?.(s);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Вход</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Синхронизация теперь требует авторизации. Локальные данные доступны без входа, но push/pull будут работать только после входа.
      </div>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, maxWidth: 560 }}>
        <div style={{ marginBottom: 10, color: '#111827' }}>
          Статус: {status.loggedIn ? `вошли как ${status.user?.username ?? '?'}` : 'не выполнен вход'}
        </div>

        {!status.loggedIn ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
              <div style={{ color: '#6b7280' }}>Логин</div>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
              <div style={{ color: '#6b7280' }}>Пароль</div>
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

        {msg && <div style={{ marginTop: 10, color: '#6b7280' }}>{msg}</div>}
      </div>
    </div>
  );
}


