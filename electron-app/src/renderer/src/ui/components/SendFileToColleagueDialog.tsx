import React, { useEffect, useMemo, useState } from 'react';

import { Button } from './Button.js';
import { Input } from './Input.js';

type Colleague = { id: string; username: string; fullName?: string | null };

/**
 * «Отправить файл…» — выбор коллеги, которому файл ляжет на Верстак.
 *
 * Отправка не кладёт ярлык чужому напрямую: секция Верстака чужая и LWW, а ярлык сам по себе
 * доступа к файлу не даёт. Уходит личное сообщение с файлом — оно и доезжает, и выдаёт доступ,
 * а получатель сам решает, брать ли («Принять N файлов от …»), чтобы Верстак нельзя было
 * засыпать чужими плитками.
 */
export function SendFileToColleagueDialog(props: {
  open: boolean;
  fileName: string;
  onClose: () => void;
  onSend: (recipientUserId: string) => Promise<void> | void;
}) {
  const [users, setUsers] = useState<Colleague[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setQuery('');
    void (async () => {
      try {
        const r = await window.matrica.chat.usersList();
        setUsers(r.ok ? (r.users as Colleague[]) : []);
      } catch {
        setUsers([]);
      }
    })();
  }, [props.open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = users.filter((u) => u.id && u.username);
    if (!q) return list.slice(0, 50);
    return list
      .filter((u) => `${u.fullName ?? ''} ${u.username}`.toLowerCase().includes(q))
      .slice(0, 50);
  }, [users, query]);

  if (!props.open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1200,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        data-send-file-dialog
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          width: 'min(520px, 100%)',
          display: 'grid',
          gap: 10,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 17 }}>📤 Отправить файл</div>
        <div className="ui-muted" title={props.fileName}>
          {props.fileName}
        </div>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Кому — фамилия или логин" autoFocus />
        <div style={{ maxHeight: 320, overflowY: 'auto', display: 'grid', gap: 4 }}>
          {filtered.length === 0 ? (
            <div className="ui-muted">Никого не нашлось.</div>
          ) : (
            filtered.map((u) => (
              <button
                key={u.id}
                type="button"
                data-colleague={u.id}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void Promise.resolve(props.onSend(u.id)).finally(() => setBusy(false));
                }}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--surface-2)',
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                <div style={{ fontWeight: 600 }}>{u.fullName?.trim() || u.username}</div>
                {u.fullName?.trim() ? <div style={{ fontSize: 12, color: 'var(--subtle)' }}>{u.username}</div> : null}
              </button>
            ))
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Отмена
          </Button>
        </div>
      </div>
    </div>
  );
}
