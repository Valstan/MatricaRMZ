import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { accessSectionMeta, type UiScreenListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { theme } from '../theme.js';

function fmtDate(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * «Мои экраны» — список экранов, собранных операторами (UI builder pilot).
 * Показываются только экраны разделов, где у пользователя есть доступ
 * (фильтрует main в uiScreens:list).
 */
export function UserScreensPage(props: {
  onOpen: (id: string) => void;
  onEdit: (id: string | null) => void;
}) {
  const [rows, setRows] = useState<UiScreenListItem[]>([]);
  // Свежеправленный экран — первым: список короткий, но искать в нём глазами всё равно приходится.
  const [sortDesc, setSortDesc] = useState(true);
  const sortedRows = useMemo(
    () => rows.slice().sort((a, b) => (Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0)) * (sortDesc ? -1 : 1)),
    [rows, sortDesc],
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.matrica.uiScreens.list();
      if (res.ok) {
        setRows(res.rows);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const th: React.CSSProperties = {
    textAlign: 'left',
    padding: '6px 10px',
    fontSize: 12,
    color: theme.colors.muted,
    borderBottom: `1px solid ${theme.colors.border}`,
  };
  const td: React.CSSProperties = { padding: '6px 10px', fontSize: 13, borderBottom: `1px solid ${theme.colors.border}` };

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button onClick={() => props.onEdit(null)}>Создать экран</Button>
        <Button variant="ghost" onClick={() => void reload()}>
          Обновить
        </Button>
        {loading ? <span style={{ fontSize: 13, color: theme.colors.muted }}>Загрузка…</span> : null}
        {error ? <span style={{ fontSize: 13, color: 'var(--tone-danger-text, #dc2626)' }}>{error}</span> : null}
      </div>
      {!loading && rows.length === 0 && !error ? (
        <div style={{ fontSize: 13, color: theme.colors.muted }}>
          Пока нет ни одного экрана. Нажмите «Создать экран», соберите его из блоков и сохраните — экран увидят все,
          у кого есть доступ к выбранному разделу.
        </div>
      ) : null}
      {rows.length > 0 ? (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={th}>Название</th>
              <th style={th}>Раздел</th>
              <th style={th}>Автор</th>
              <th style={{ ...th, cursor: 'pointer' }} onClick={() => setSortDesc((v) => !v)}>
                {`Дата изменения ${sortDesc ? '↓' : '↑'}`}
              </th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => (
              <tr key={r.id}>
                <td style={td}>
                  <button
                    type="button"
                    onClick={() => props.onOpen(r.id)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: theme.colors.text,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                  >
                    {r.name || '(без названия)'}
                  </button>
                </td>
                <td style={td}>{accessSectionMeta(r.sectionId)?.titleRu ?? r.sectionId}</td>
                <td style={td}>{r.createdBy}</td>
                <td style={td}>{fmtDate(r.updatedAt)}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  {r.canEdit ? (
                    <Button size="sm" variant="ghost" onClick={() => props.onEdit(r.id)}>
                      Редактировать
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export default UserScreensPage;
