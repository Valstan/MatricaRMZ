import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { AuthStatus } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';

type Person = { login: string; fullName?: string };

function normalize(s: string) {
  return String(s ?? '').trim().toLowerCase().replaceAll('ё', 'е');
}

function initialsOf(fullName: string, login: string) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  if (parts.length === 1 && parts[0]!.length > 0) return parts[0]!.slice(0, 2).toUpperCase();
  return String(login ?? '?').slice(0, 2).toUpperCase();
}

/**
 * Смена аккаунта без выхода на экран входа: недавние на этом компе + поиск-подсказка
 * (server typeahead, без полного списка-оракула) → пароль → штатный logout+login
 * (одна живая сессия; права и workspace-профиль нового пользователя подгружаются
 * обычным login-циклом).
 */
export function AccountSwitchDialog(props: {
  open: boolean;
  currentLogin: string;
  onClose: () => void;
  onSwitched: (s: AuthStatus) => void;
}) {
  const [recent, setRecent] = useState<Person[]>([]);
  const [suggestions, setSuggestions] = useState<Person[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Person | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const passwordRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!props.open) {
      setQuery('');
      setSelected(null);
      setPassword('');
      setMsg('');
      setSuggestions([]);
      return;
    }
    void window.matrica.auth
      .loginMru()
      .then((r) => {
        if (r?.ok) {
          const entries = Array.isArray(r.entries)
            ? (r.entries as Person[])
            : (r.logins ?? []).map((login) => ({ login }));
          setRecent(entries);
        }
      })
      .catch(() => {});
  }, [props.open]);

  // Debounced server typeahead (only login+fullName, capped, rate-limited).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const r = await window.matrica.auth.loginSuggest({ q }).catch(() => null);
      if (alive && r?.ok) setSuggestions(r.rows);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const people = useMemo(() => {
    const cur = normalize(props.currentLogin);
    const base = query.trim().length >= 2 ? suggestions : recent;
    const seen = new Set<string>();
    return base
      .filter((o) => normalize(o.login) !== cur && o.login.trim())
      .filter((o) => {
        const k = normalize(o.login);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }, [recent, suggestions, query, props.currentLogin]);

  async function submitSwitch() {
    if (!selected || !password || busy) return;
    setBusy(true);
    setMsg('Переключаем...');
    try {
      // Сначала проверяем пароль логином нового пользователя; logout текущего —
      // внутри login-цикла main-процесса (сессия одна, перезаписывается).
      const r = await window.matrica.auth.login({ username: selected.login, password });
      if (!r.ok) {
        setMsg(`Ошибка: ${r.error}`);
        return;
      }
      const s = await window.matrica.auth.status();
      props.onSwitched(s);
      props.onClose();
    } finally {
      setBusy(false);
    }
  }

  if (!props.open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 12000,
        background: 'rgba(2, 6, 23, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: 14,
          boxShadow: '0 18px 40px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 15, flex: 1 }}>Смена аккаунта</div>
          <Button variant="ghost" onClick={props.onClose} style={{ minWidth: 28, padding: '2px 8px' }}>
            ✕
          </Button>
        </div>

        {!selected ? (
          <>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по логину или фамилии"
              data-autogrow="off"
              data-input-assist="component-suggestions"
              style={{ width: '100%', marginBottom: 8 }}
            />
            {query.trim().length < 2 && recent.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.03em', margin: '0 0 4px' }}>
                НЕДАВНИЕ НА ЭТОМ КОМПЬЮТЕРЕ
              </div>
            )}
            <div style={{ overflowY: 'auto', flex: 1, minHeight: 120 }}>
              {people.map((o) => (
                <div
                  key={o.login}
                  onClick={() => {
                    setSelected(o);
                    setMsg('');
                    setTimeout(() => passwordRef.current?.focus(), 50);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 10, cursor: 'pointer' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'var(--surface-2, rgba(99,102,241,0.08))')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'transparent')}
                >
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      flex: '0 0 auto',
                      background: 'rgba(99,102,241,0.18)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    {initialsOf(o.fullName ?? '', o.login)}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {o.fullName || o.login}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {o.login}
                    </div>
                  </div>
                </div>
              ))}
              {people.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: 16 }}>
                  {query.trim().length >= 2 ? 'Никого не нашли' : 'Введите минимум 2 символа для поиска'}
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 13 }}>
              Вход как <b>{selected.fullName || selected.login}</b>
            </div>
            <Input
              ref={passwordRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="пароль"
              data-autogrow="off"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitSwitch();
              }}
              style={{ width: '100%' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => void submitSwitch()} disabled={busy || !password} style={{ flex: 1 }}>
                {busy ? 'Входим…' : 'Войти'}
              </Button>
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Назад
              </Button>
            </div>
          </div>
        )}

        {msg && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>{msg}</div>}
      </div>
    </div>
  );
}
