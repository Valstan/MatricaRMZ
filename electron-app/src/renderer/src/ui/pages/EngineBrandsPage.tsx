import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';

type Row = {
  id: string;
  displayName?: string;
  updatedAt: number;
};

export function EngineBrandsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canViewMasterData: boolean;
}) {
  const [query, setQuery] = useState<string>('');
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [typeId, setTypeId] = useState<string>('');
  const width = useWindowWidth();
  const twoCol = width >= 1400;
  const queryTimer = useRef<number | null>(null);

  async function loadType() {
    if (!props.canViewMasterData) return;
    const types = await window.matrica.admin.entityTypes.list();
    const type = (types as any[]).find((t) => String(t.code) === 'engine_brand');
    setTypeId(type?.id ? String(type.id) : '');
  }

  async function refresh() {
    if (!props.canViewMasterData) return;
    if (!typeId) {
      setStatus('Справочник марок двигателя не найден (engine_brand).');
      setRows([]);
      return;
    }
    try {
      setStatus('Загрузка…');
      const list = await window.matrica.admin.entities.listByEntityType(typeId);
      setRows(list as any);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void loadType();
  }, [props.canViewMasterData]);

  useEffect(() => {
    void refresh();
  }, [typeId]);

  useEffect(() => {
    if (queryTimer.current) window.clearTimeout(queryTimer.current);
    queryTimer.current = window.setTimeout(() => void refresh(), 300);
    return () => {
      if (queryTimer.current) window.clearTimeout(queryTimer.current);
    };
  }, [query, typeId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const label = (r.displayName ? `${r.displayName} ` : '') + r.id;
      return label.toLowerCase().includes(q);
    });
  }, [rows, query]);

  const tableHeader = (
    <thead>
      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Название</th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Обновлено</th>
      </tr>
    </thead>
  );

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          {tableHeader}
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={2} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет марок' : 'Не найдено'}
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr
                key={row.id}
                style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                onClick={() => void props.onOpen(row.id)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f9fafb';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.displayName || '(без названия)'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>
                  {row.updatedAt ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate && (
          <Button
            onClick={async () => {
              if (!typeId) return;
              try {
                setStatus('Создание марки...');
                const created = await window.matrica.admin.entities.create(typeId);
                if (!created?.ok || !created.id) {
                  setStatus('Ошибка: не удалось создать марку');
                  return;
                }
                await window.matrica.admin.entities.setAttr(created.id, 'name', 'Новая марка');
                setStatus('');
                await refresh();
                await props.onOpen(created.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Добавить марку
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию…" />
        </div>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 8 }}>
        <TwoColumnList items={filtered} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}
