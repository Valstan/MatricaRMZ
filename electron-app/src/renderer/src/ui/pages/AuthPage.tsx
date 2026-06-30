import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { AuthStatus } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type LoginSuggestion = { login: string; fullName: string };
type MruEntry = { login: string; fullName?: string; lastAt: number };

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

const AVATAR_COLORS = [
  { bg: '#10b981', fg: '#04342c' },
  { bg: '#60a5fa', fg: '#042c53' },
  { bg: '#f59e0b', fg: '#412402' },
  { bg: '#f472b6', fg: '#4b1528' },
  { bg: '#a78bfa', fg: '#26215c' },
  { bg: '#f87171', fg: '#501313' },
  { bg: '#34d399', fg: '#173404' },
  { bg: '#fbbf24', fg: '#633806' },
];

function avatarFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

function initialsOf(fullName: string, login: string) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  if (parts.length === 1 && parts[0]!.length > 0) return parts[0]!.slice(0, 2).toUpperCase();
  return String(login ?? '?').slice(0, 2).toUpperCase();
}

function relTimeRu(lastAt: number): string {
  const days = Math.floor((Date.now() - lastAt) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} дн. назад`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} нед. назад`;
  return `${Math.floor(days / 30)} мес. назад`;
}

export function AuthPage(props: { onChanged?: (s: AuthStatus) => void }) {
  const [status, setStatus] = useState<AuthStatus>({ loggedIn: false, user: null, permissions: {} });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  // Typeahead suggestions (server prefix search) + machine-local recent logins.
  // Replaces the old full-roster dropdown (a username enumeration oracle).
  const [suggestions, setSuggestions] = useState<LoginSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [mruEntries, setMruEntries] = useState<MruEntry[]>([]);
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);
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
    panelBg: '#0d2547',
    text: '#ffffff',
    muted: '#9db4d6',
    hint: '#facc15',
    inputBg: '#0f2b55',
    inputBorder: '#1f3b66',
    buttonBg: '#0f5132',
    buttonBorder: '#0b3d26',
    rowHover: '#123060',
  };

  async function submitLogin() {
    if (busy) return;
    setBusy(true);
    setMsg('Входим...');
    try {
      const r = await window.matrica.auth.login({ username, password });
      if (!r.ok) {
        setMsg(`Ошибка: ${r.error}`);
        return;
      }
      setPassword('');
      setMsg('OK: вход выполнен.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function submitRegister() {
    if (busy) return;
    setBusy(true);
    setMsg('Регистрируем...');
    try {
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
    } finally {
      setBusy(false);
    }
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

  async function refreshMru() {
    const r = await window.matrica.auth.loginMru().catch(() => null);
    if (r?.ok) {
      setMruEntries(
        Array.isArray(r.entries) ? (r.entries as MruEntry[]) : (r.logins ?? []).map((login) => ({ login, lastAt: 0 })),
      );
    }
  }

  async function probeServer() {
    const r = await window.matrica.server.health().catch(() => null);
    setServerReachable(!!(r && r.ok && r.serverOk));
  }

  useEffect(() => {
    void refresh();
    void probeServer();
    void window.matrica.app
      .version()
      .then((v: any) => setAppVersion(String((typeof v === 'object' && v != null ? v.version : v) ?? '')))
      .catch(() => {});
    void (async () => {
      await refreshMru();
      const r = await window.matrica.auth.loginMru().catch(() => null);
      const first = r?.ok ? (r.logins ?? [])[0] : null;
      // Типовой оператор машины: преселект последнего логина, курсор сразу в пароль.
      if (first) {
        setUsername((prev) => prev || first);
        passwordRef.current?.focus();
      }
    })();
    const id = setInterval(() => void probeServer(), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!status.loggedIn) {
      setPresence(null);
      void refreshMru();
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

  // Debounced typeahead: query the server for login suggestions as the user types
  // their surname/name/login prefix (>=2 chars). The server returns only
  // {login, fullName} (no role/position), capped and rate-limited.
  useEffect(() => {
    if (mode !== 'login') return;
    const q = username.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const r = await window.matrica.auth.loginSuggest({ q }).catch(() => null);
      if (!alive) return;
      if (r?.ok) {
        setSuggestions(r.rows);
        setServerReachable(true);
      } else if (r) {
        setServerReachable(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [username, mode]);

  const recentPeople = useMemo(() => mruEntries.filter((e) => e.login.trim()), [mruEntries]);

  function pickPerson(login: string) {
    setUsername(login);
    setPassword('');
    setMsg('');
    setSuggestOpen(false);
    setSuggestions([]);
    passwordRef.current?.focus();
  }

  function personRow(opt: { login: string; fullName?: string }, recentAt?: number) {
    const av = avatarFor(opt.login);
    const title = opt.fullName || opt.login;
    const subtitleParts: string[] = [];
    if (recentAt && recentAt > 0) subtitleParts.push(`был ${relTimeRu(recentAt)}`);
    const selected = username.toLowerCase() === opt.login.toLowerCase();
    return (
      <div
        key={opt.login}
        onClick={() => pickPerson(opt.login)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 8px',
          borderRadius: 10,
          cursor: 'pointer',
          background: selected ? palette.rowHover : 'transparent',
          border: selected ? `1px solid ${palette.inputBorder}` : '1px solid transparent',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = palette.rowHover;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = selected ? palette.rowHover : 'transparent';
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: '50%',
            flex: '0 0 auto',
            background: av.bg,
            color: av.fg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 800,
          }}
        >
          {initialsOf(opt.fullName ?? '', opt.login)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          <div style={{ fontSize: 12, color: palette.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {subtitleParts.join(' · ') || opt.login}
          </div>
        </div>
      </div>
    );
  }

  const serverOnline = serverReachable === true || presence != null;
  const showSuggest = suggestOpen && username.trim().length >= 2 && suggestions.length > 0;

  return (
    <div style={{ minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div
        style={{
          border: `1px solid ${palette.formBorder}`,
          borderRadius: 16,
          padding: 20,
          width: '100%',
          maxWidth: status.loggedIn || mode === 'register' ? 560 : 860,
          background: palette.formBg,
          color: palette.text,
          boxShadow: '0 18px 40px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: palette.inputBg,
              border: `1px solid ${palette.inputBorder}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 900,
              fontSize: 16,
            }}
          >
            М
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>Матрица РМЗ</div>
            <div style={{ fontSize: 12, color: palette.muted }}>
              {appVersion ? `v${appVersion} · ` : ''}
              сервер:{' '}
              <span style={{ color: serverOnline ? '#34d399' : '#f87171' }}>{serverOnline ? 'онлайн' : 'нет связи'}</span>
            </div>
          </div>
          {status.loggedIn ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {presence ? (
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    display: 'inline-block',
                    background: presence.online ? 'var(--success)' : 'var(--danger)',
                  }}
                  title={presence.online ? 'В сети' : 'Не в сети'}
                />
              ) : null}
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
          ) : null}
        </div>

        {!status.loggedIn ? (
          <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 320px', minWidth: 280 }}>
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  background: palette.inputBg,
                  borderRadius: 10,
                  padding: 3,
                  marginBottom: 14,
                }}
              >
                {(['login', 'register'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setMode(m);
                      setMsg('');
                    }}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      fontSize: 13,
                      fontWeight: 700,
                      padding: '7px 6px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: mode === m ? palette.formBg : 'transparent',
                      border: mode === m ? `1px solid ${palette.inputBorder}` : '1px solid transparent',
                      color: mode === m ? palette.text : palette.muted,
                    }}
                  >
                    {m === 'login' ? 'Вход' : 'Регистрация'}
                  </button>
                ))}
              </div>

              {mode === 'login' ? (
                <div style={{ display: 'grid', gap: 12 }}>
                  <div>
                    <div style={{ marginBottom: 6, fontWeight: 700, fontSize: 13 }}>Логин</div>
                    <div style={{ position: 'relative' }}>
                      <Input
                        value={username}
                        onChange={(e) => {
                          setUsername(e.target.value);
                          setSuggestOpen(true);
                        }}
                        onFocus={() => setSuggestOpen(true)}
                        onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                        placeholder="начните вводить логин или фамилию"
                        data-autogrow="off"
                        data-input-assist="component-suggestions"
                        style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}`, width: '100%' }}
                      />
                      {showSuggest && (
                        <div
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            right: 0,
                            marginTop: 4,
                            zIndex: 20,
                            background: palette.panelBg,
                            border: `1px solid ${palette.formBorder}`,
                            borderRadius: 10,
                            padding: 4,
                            maxHeight: 260,
                            overflowY: 'auto',
                            boxShadow: '0 12px 28px rgba(0,0,0,0.4)',
                          }}
                        >
                          {suggestions.map((s) => personRow(s))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div>
                    <div style={{ marginBottom: 6, fontWeight: 700, fontSize: 13 }}>Пароль</div>
                    <div style={{ position: 'relative' }}>
                      <Input
                        ref={passwordRef}
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="пароль"
                        data-autogrow="off"
                        onKeyDown={(e) => {
                          setCapsLockOn(e.getModifierState?.('CapsLock') ?? false);
                          if (e.key === 'Enter') void submitLogin();
                        }}
                        onKeyUp={(e) => setCapsLockOn(e.getModifierState?.('CapsLock') ?? false)}
                        style={{
                          background: palette.inputBg,
                          color: palette.text,
                          border: `1px solid ${palette.inputBorder}`,
                          width: '100%',
                          paddingRight: 36,
                        }}
                      />
                      <button
                        onClick={() => setShowPassword((v) => !v)}
                        title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                        style={{
                          position: 'absolute',
                          right: 6,
                          top: '50%',
                          transform: 'translateY(-50%)',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          color: palette.muted,
                          fontSize: 15,
                          padding: 4,
                        }}
                      >
                        {showPassword ? '🙈' : '👁'}
                      </button>
                    </div>
                    {capsLockOn && <div style={{ marginTop: 6, fontSize: 12, color: palette.hint }}>Caps Lock включён</div>}
                  </div>
                  <Button
                    onClick={() => void submitLogin()}
                    disabled={busy || !username.trim() || !password}
                    style={{ background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.buttonBorder}`, width: '100%' }}
                  >
                    {busy ? 'Входим…' : 'Войти'}
                  </Button>
                  <div style={{ fontSize: 11, color: palette.muted, textAlign: 'center' }}>
                    Забыли пароль — обратитесь к администратору
                  </div>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 12 }}>
                  <div>
                    <div style={{ marginBottom: 6, fontWeight: 700, fontSize: 13 }}>Логин</div>
                    <Input
                      value={regLogin}
                      onChange={(e) => setRegLogin(e.target.value)}
                      placeholder="логин"
                      data-autogrow="off"
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}`, width: '100%' }}
                    />
                  </div>
                  <div>
                    <div style={{ marginBottom: 6, fontWeight: 700, fontSize: 13 }}>Пароль</div>
                    <Input
                      type="password"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="минимум 6 символов"
                      data-autogrow="off"
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}`, width: '100%' }}
                    />
                    {!regPasswordValid && regPassword && (
                      <div style={{ marginTop: 4, fontSize: 12, color: palette.hint }}>Пароль слишком короткий</div>
                    )}
                  </div>
                  <div>
                    <div style={{ marginBottom: 6, fontWeight: 700, fontSize: 13 }}>ФИО</div>
                    <Input
                      value={regFullName}
                      onChange={(e) => setRegFullName(e.target.value)}
                      placeholder="Фамилия Имя Отчество"
                      data-autogrow="off"
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}`, width: '100%' }}
                    />
                  </div>
                  <div>
                    <div style={{ marginBottom: 6, fontWeight: 700, fontSize: 13 }}>Должность</div>
                    <Input
                      value={regPosition}
                      onChange={(e) => setRegPosition(e.target.value)}
                      placeholder="Должность на заводе"
                      data-autogrow="off"
                      style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}`, width: '100%' }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <Button
                      onClick={() => void submitRegister()}
                      disabled={busy || !regPasswordValid}
                      style={{ background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.buttonBorder}`, flex: 1 }}
                    >
                      Зарегистрироваться
                    </Button>
                    <Button
                      onClick={clearRegisterFields}
                      variant="ghost"
                      style={{ background: 'transparent', color: palette.muted, border: `1px solid ${palette.inputBorder}` }}
                    >
                      Очистить
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {mode === 'login' && recentPeople.length > 0 && (
              <div
                style={{
                  flex: '1 1 300px',
                  minWidth: 260,
                  background: palette.panelBg,
                  border: `1px solid ${palette.formBorder}`,
                  borderRadius: 12,
                  padding: 10,
                  maxHeight: 420,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div style={{ fontSize: 11, color: palette.muted, letterSpacing: '0.03em', margin: '2px 0 6px' }}>
                  НЕДАВНИЕ НА ЭТОМ КОМПЬЮТЕРЕ
                </div>
                <div style={{ overflowY: 'auto', flex: 1, paddingRight: 2 }}>
                  {recentPeople.map((e) => personRow(e, e.lastAt))}
                </div>
              </div>
            )}
          </div>
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

        <div
          style={{
            marginTop: 20,
            textAlign: 'center',
            fontSize: 10,
            fontStyle: 'italic',
            lineHeight: 1.4,
            color: palette.hint,
            opacity: 0.7,
          }}
        >
          «В мире, где всё работало само, люди ценились примерно как комнатные растения — вроде нужны, но никто не помнит уже зачем.»
        </div>
      </div>
    </div>
  );
}
