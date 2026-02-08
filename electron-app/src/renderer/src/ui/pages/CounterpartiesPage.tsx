import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';

type Row = {
  id: string;
  displayName?: string;
  inn?: string;
  updatedAt: number;
};

export function CounterpartiesPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
  canViewMasterData: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [typeId, setTypeId] = useState<string>('');
  const width = useWindowWidth();
  const twoCol = width >= 1400;
  const queryTimer = useRef<number | null>(null);

  async function loadType() {
    if (!props.canViewMasterData) return;
    const types = await window.matrica.admin.entityTypes.list();
    const type = (types as any[]).find((t) => String(t.code) === 'customer');
    setTypeId(type?.id ? String(type.id) : '');
  }

  async function refresh() {
    if (!props.canViewMasterData) return;
    if (!typeId) {
      setStatus('Справочник контрагентов не найден (customer).');
      setRows([]);
      return;
    }
    try {
      setStatus('Загрузка…');
      const list = await window.matrica.admin.entities.listByEntityType(typeId);
      const baseRows = list as any[];
      const details = await Promise.all(
        baseRows.map((r) => window.matrica.admin.entities.get(String(r.id)).catch(() => null)),
      );
      const enriched: Row[] = baseRows.map((r, idx) => {
        const attrs = (details[idx] as any)?.attributes ?? {};
        const inn = typeof attrs.inn === 'string' ? attrs.inn : attrs.inn == null ? '' : String(attrs.inn);
        return {
          id: String(r.id),
          displayName: r.displayName ? String(r.displayName) : undefined,
          inn: inn.trim() || undefined,
          updatedAt: Number(r.updatedAt ?? 0),
        };
      });
      setRows(enriched);
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
      const label = `${r.displayName ?? ''} ${r.inn ?? ''} ${r.id}`;
      return label.toLowerCase().includes(q);
    });
  }, [rows, query]);

  const tableHeader = (
    <thead>
      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Название</th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>ИНН</th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Обновлено</th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', width: 140 }}>Действия</th>
      </tr>
    </thead>
  );

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет контрагентов' : 'Не найдено'}
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
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.inn || '—'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>
                  {row.updatedAt ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}
                </td>
                <td style={{ padding: '10px 12px' }}>
                  {props.canDelete && (
                    <Button
                      variant="ghost"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm('Удалить контрагента?')) return;
                        try {
                          setStatus('Удаление…');
                          const r = await window.matrica.admin.entities.softDelete(row.id);
                          if (!r.ok) {
                            setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
                            return;
                          }
                          setStatus('Удалено');
                          setTimeout(() => setStatus(''), 900);
                          await refresh();
                        } catch (err) {
                          setStatus(`Ошибка: ${String(err)}`);
                        }
                      }}
                      style={{ color: '#b91c1c' }}
                    >
                      Удалить
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
        {props.canCreate && (
          <Button
            onClick={async () => {
              if (!typeId) return;
              try {
                setStatus('Создание контрагента...');
                const created = await window.matrica.admin.entities.create(typeId);
                if (!created?.ok || !created.id) {
                  setStatus('Ошибка: не удалось создать контрагента');
                  return;
                }
                await window.matrica.admin.entities.setAttr(created.id, 'name', 'Новый контрагент');
                setStatus('');
                await refresh();
                await props.onOpen(created.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Добавить контрагента
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию/ИНН…" />
        </div>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={filtered} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}
