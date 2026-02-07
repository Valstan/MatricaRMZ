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
  const [loginOptions, setLoginOptions] = useState<Array<{ login: string; fullName: string; role: string }>>([]);
  const [loginOptionsStatus, setLoginOptionsStatus] = useState<string>('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [regLogin, setRegLogin] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regFullName, setRegFullName] = useState('');
  const [regPosition, setRegPosition] = useState('');
  const [msg, setMsg] = useState<string>('');
  const [presence, setPresence] = useState<{ online: boolean; lastActivityAt: number | null } | null>(null);
  const regPasswordValid = regPassword.trim().length >= 6;
  const palette = {
    formBg: '#0b1f3a',
    formBorder: '#1c3a66',
    text: '#ffffff',
    hint: '#facc15',
    inputBg: '#0f2b55',
    inputBorder: '#1f3b66',
    buttonBg: '#0f5132',
    buttonBorder: '#0b3d26',
  };

  async function submitLogin() {
    setMsg('Входим...');
    const r = await window.matrica.auth.login({ username, password });
    if (!r.ok) {
      setMsg(`Ошибка: ${r.error}`);
      return;
    }
    setPassword('');
    setMsg('OK: вход выполнен.');
    await refresh();
  }

  async function submitRegister() {
    setMsg('Регистрируем...');
    const r = await window.matrica.auth.register({
      login: regLogin,
      password: regPassword,
      fullName: regFullName,
      position: regPosition,
    });
    if (!r.ok) {
      setMsg(`Ошибка: ${r.error}`);
      return;
    }
    setRegPassword('');
    setMsg('OK: регистрация выполнена.');
    await refresh();
  }

  function clearRegisterFields() {
    setRegLogin('');
    setRegPassword('');
    setRegFullName('');
    setRegPosition('');
  }

  async function refresh() {
    const s = await window.matrica.auth.status();
    setStatus(s);
    props.onChanged?.(s);
  }

  async function refreshLoginOptions() {
    setLoginOptionsStatus('');
    const r = await window.matrica.auth.loginOptions().catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r?.ok) {
      setLoginOptions([]);
      setLoginOptionsStatus(r?.error ? `Ошибка списка логинов: ${r.error}` : 'Ошибка списка логинов');
      return;
    }
    setLoginOptions(Array.isArray(r.rows) ? r.rows : []);
  }

  useEffect(() => {
    void refresh();
    void refreshLoginOptions();
  }, []);

  useEffect(() => {
    if (!status.loggedIn) {
      setPresence(null);
      void refreshLoginOptions();
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
    <div style={{ minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div
        style={{
          border: `1px solid ${palette.formBorder}`,
          borderRadius: 16,
          padding: 20,
          width: '100%',
          maxWidth: 560,
          background: palette.formBg,
          color: palette.text,
          boxShadow: '0 18px 40px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <Button
            onClick={() => setMode('login')}
            style={{
              background: palette.buttonBg,
              color: palette.text,
              border: `1px solid ${palette.buttonBorder}`,
              opacity: mode === 'login' ? 1 : 0.7,
            }}
          >
            Вход
          </Button>
          <Button
            onClick={() => setMode('register')}
            style={{
              background: palette.buttonBg,
              color: palette.text,
              border: `1px solid ${palette.buttonBorder}`,
              opacity: mode === 'register' ? 1 : 0.7,
            }}
          >
            Регистрация нового пользователя
          </Button>
        </div>

        <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
            <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
              {mode === 'login' ? (
                <>
                  <div style={{ width: '100%', maxWidth: 360, textAlign: 'center' }}>
                    <div style={{ marginBottom: 6, fontWeight: 700 }}>Логин</div>
                    <Input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="логин"
                      list="login-options"
                      onFocus={() => void refreshLoginOptions()}
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}` }}
                    />
                    <datalist id="login-options">
                      {loginOptions.map((opt) => {
                        const label = opt.fullName ? `${opt.login} — ${opt.fullName} (${opt.role})` : `${opt.login} (${opt.role})`;
                        return <option key={opt.login} value={opt.login} label={label} />;
                      })}
                    </datalist>
                    {loginOptionsStatus && (
                      <div style={{ marginTop: 6, fontSize: 12, color: palette.hint }}>{loginOptionsStatus}</div>
                    )}
                  </div>
                  <div style={{ width: '100%', maxWidth: 360, textAlign: 'center' }}>
                    <div style={{ marginBottom: 6, fontWeight: 700 }}>Пароль</div>
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="пароль"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitLogin();
                      }}
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}` }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div style={{ width: '100%', maxWidth: 360, textAlign: 'center' }}>
                    <div style={{ marginBottom: 6, fontWeight: 700 }}>Логин</div>
                    <Input
                      value={regLogin}
                      onChange={(e) => setRegLogin(e.target.value)}
                      placeholder="логин"
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}` }}
                    />
                  </div>
                  <div style={{ width: '100%', maxWidth: 360, textAlign: 'center' }}>
                    <div style={{ marginBottom: 6, fontWeight: 700 }}>Пароль</div>
                    <Input
                      type="password"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="пароль"
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}` }}
                    />
                    <div style={{ marginTop: 6, fontSize: 12, color: palette.hint }}>Минимум 6 символов</div>
                    {!regPasswordValid && regPassword && (
                      <div style={{ marginTop: 4, fontSize: 12, color: palette.hint }}>Пароль слишком короткий</div>
                    )}
                  </div>
                  <div style={{ width: '100%', maxWidth: 360, textAlign: 'center' }}>
                    <div style={{ marginBottom: 6, fontWeight: 700 }}>ФИО</div>
                    <Input
                      value={regFullName}
                      onChange={(e) => setRegFullName(e.target.value)}
                      placeholder="Фамилия Имя Отчество"
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}` }}
                    />
                  </div>
                  <div style={{ width: '100%', maxWidth: 360, textAlign: 'center' }}>
                    <div style={{ marginBottom: 6, fontWeight: 700 }}>Должность</div>
                    <Input
                      value={regPosition}
                      onChange={(e) => setRegPosition(e.target.value)}
                      placeholder="Должность на заводе"
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}` }}
                    />
                  </div>
                </>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
              <Button
                onClick={mode === 'login' ? submitLogin : submitRegister}
                disabled={mode === 'register' && !regPasswordValid}
                style={{ background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.buttonBorder}` }}
              >
                {mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
              </Button>
              {mode === 'register' && (
                <Button
                  onClick={clearRegisterFields}
                  style={{ background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.buttonBorder}` }}
                >
                  Очистить
                </Button>
              )}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Button
              variant="ghost"
              onClick={async () => {
                setMsg('Выходим...');
                const r = await window.matrica.auth.logout({});
                setMsg(r.ok ? 'OK: выход выполнен.' : `Ошибка: ${r.error ?? 'unknown'}`);
                await refresh();
              }}
              style={{ background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.buttonBorder}` }}
            >
              Выйти
            </Button>
            <Button
              variant="ghost"
              onClick={() => void refresh()}
              style={{ background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.buttonBorder}` }}
            >
              Обновить
            </Button>
          </div>
        )}

        {msg && <div style={{ marginTop: 12, textAlign: 'center', color: palette.hint }}>{msg}</div>}
      </div>
    </div>
  );
}


