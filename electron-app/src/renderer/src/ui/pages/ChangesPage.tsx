import React, { useEffect, useMemo, useState } from 'react';

import type { AuthUserInfo, ChangeRequestRow } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

function safePreviewJson(s: string | null | undefined): string {
  const raw = String(s ?? '');
  if (!raw.trim()) return '—';
  try {
    const obj = JSON.parse(raw);
    const pretty = JSON.stringify(obj, null, 2);
    return pretty.length > 800 ? pretty.slice(0, 800) + '\n…' : pretty;
  } catch {
    return raw.length > 800 ? raw.slice(0, 800) + '…' : raw;
  }
}

export function ChangesPage(props: { me: AuthUserInfo; canDecideAsAdmin: boolean }) {
  const [status, setStatus] = useState<'pending' | 'applied' | 'rejected'>('pending');
  const [query, setQuery] = useState<string>('');
  const [rows, setRows] = useState<ChangeRequestRow[]>([]);
  const [msg, setMsg] = useState<string>('');

  async function refresh() {
    setMsg('Загрузка…');
    const r = await window.matrica.changes.list({ status, limit: 2000 });
    if (!r.ok) {
      setMsg(`Ошибка: ${r.error}`);
      setRows([]);
      return;
    }
    setRows(r.changes ?? []);
    setMsg('');
  }

  useEffect(() => {
    void refresh();
  }, [status]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) => {
      const hay = `${c.tableName} ${c.rowId} ${c.rootEntityId ?? ''} ${c.recordOwnerUsername ?? ''} ${c.changeAuthorUsername ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  function canDecide(c: ChangeRequestRow): boolean {
    if (props.canDecideAsAdmin) return true;
    if (c.recordOwnerUserId && c.recordOwnerUserId === props.me.id) return true;
    return false;
  }

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Изменения</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Здесь отображаются правки, которые требуют подтверждения. Применять/отклонять может только автор исходных данных или администратор.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as any)}
          style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
        >
          <option value="pending">Ожидают</option>
          <option value="applied">Применены</option>
          <option value="rejected">Отклонены</option>
        </select>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск…" />
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
        <div style={{ flex: 1 }} />
        <div style={{ color: '#6b7280', fontSize: 12 }}>
          Всего: <span style={{ fontWeight: 800, color: '#111827' }}>{filtered.length}</span>
        </div>
      </div>

      {msg && <div style={{ marginTop: 10, color: msg.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{msg}</div>}

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'linear-gradient(135deg, #16a34a 0%, #15803d 120%)', color: '#fff' }}>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Раздел</th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Что было</th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Автор записи</th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Как стало</th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Автор изменений</th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)', width: 220 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const allow = canDecide(c);
              const owner = c.recordOwnerUsername ?? '—';
              const changer = c.changeAuthorUsername ?? '—';
              return (
                <tr key={c.id}>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                    <div style={{ fontWeight: 800, color: '#111827' }}>{c.tableName}</div>
                    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#6b7280' }}>
                      {c.rootEntityId ? `root=${c.rootEntityId.slice(0, 8)} ` : ''}
                      id={c.rowId.slice(0, 8)}
                    </div>
                  </td>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, verticalAlign: 'top' }}>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, color: '#334155' }}>{safePreviewJson(c.beforeJson)}</pre>
                  </td>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{owner}</td>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, verticalAlign: 'top' }}>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, color: '#0f172a' }}>{safePreviewJson(c.afterJson)}</pre>
                  </td>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{changer}</td>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <Button
                        disabled={!allow || status !== 'pending'}
                        onClick={async () => {
                          if (!confirm('Применить изменения?')) return;
                          setMsg('Применяю…');
                          const r = await window.matrica.changes.apply({ id: c.id });
                          setMsg(r.ok ? 'Применено' : `Ошибка: ${r.error}`);
                          await refresh();
                        }}
                        style={{ background: '#15803d', border: '1px solid #166534' }}
                      >
                        Применить
                      </Button>
                      <Button
                        disabled={!allow || status !== 'pending'}
                        onClick={async () => {
                          if (!confirm('Отклонить изменения?')) return;
                          setMsg('Отклоняю…');
                          const r = await window.matrica.changes.reject({ id: c.id });
                          setMsg(r.ok ? 'Отклонено' : `Ошибка: ${r.error}`);
                          await refresh();
                        }}
                        style={{ background: '#b91c1c', border: '1px solid #991b1b' }}
                      >
                        Отменить
                      </Button>
                    </div>
                    {!allow && status === 'pending' && (
                      <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>Недоступно: только автор/админ</div>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td style={{ padding: 12, color: '#6b7280' }} colSpan={6}>
                  Изменений нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


