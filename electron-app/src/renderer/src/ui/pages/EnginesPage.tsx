import React, { useMemo, useState } from 'react';

import type { EngineListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

export function EnginesPage(props: {
  engines: EngineListItem[];
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onCreate: () => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.engines;
    return props.engines.filter((e) => {
      const n = (e.engineNumber ?? '').toLowerCase();
      const b = (e.engineBrand ?? '').toLowerCase();
      return n.includes(q) || b.includes(q);
    });
  }, [props.engines, query]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по номеру или марке…" />
        </div>
        {props.canCreate && <Button onClick={props.onCreate}>Добавить двигатель</Button>}
        <Button variant="ghost" onClick={props.onRefresh}>
          Обновить
        </Button>
      </div>

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 120%)', color: '#fff' }}>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Номер</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Марка</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Синхр.</th>
              {props.canDelete && (
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 100 }}>
                  Действия
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id}>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 10, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(e.id);
                  }}
                >
                  {e.engineNumber ?? '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 10, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(e.id);
                  }}
                >
                  {e.engineBrand ?? '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 10, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(e.id);
                  }}
                >
                  {e.syncStatus ?? '-'}
                </td>
                {props.canDelete && (
                  <td
                    style={{ borderBottom: '1px solid #f3f4f6', padding: 10, width: 100 }}
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm('Удалить двигатель?')) return;
                        const r = await window.matrica.engines.delete(e.id);
                        if (!r.ok) {
                          alert(`Ошибка удаления: ${r.error}`);
                          return;
                        }
                        void props.onRefresh();
                      }}
                      style={{ color: '#b91c1c' }}
                    >
                      Удалить
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td style={{ padding: 12, color: '#6b7280' }} colSpan={props.canDelete ? 4 : 3}>
                  Ничего не найдено
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


