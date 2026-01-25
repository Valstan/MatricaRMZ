import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';

type Row = {
  id: string;
  displayName?: string;
  position?: string | null;
  departmentName?: string | null;
  employmentStatus?: string | null;
  accessEnabled?: boolean;
  systemRole?: string | null;
  personnelNumber?: string | null;
  updatedAt: number;
};

export function EmployeesPage(props: { onOpen: (id: string) => Promise<void>; canCreate: boolean; canDelete: boolean; refreshKey?: number }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const width = useWindowWidth();
  const twoCol = width >= 1400;
  const queryTimer = useRef<number | null>(null);

  async function refresh() {
    try {
      setStatus('Загрузка…');
      const list = await window.matrica.employees.list();
      setRows(list as any);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (queryTimer.current) window.clearTimeout(queryTimer.current);
    queryTimer.current = window.setTimeout(() => void refresh(), 300);
    return () => {
      if (queryTimer.current) window.clearTimeout(queryTimer.current);
    };
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [props.refreshKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const name = (r.displayName ?? '').toLowerCase();
      const dept = String(r.departmentName ?? '').toLowerCase();
      const position = String(r.position ?? '').toLowerCase();
      const personnel = String(r.personnelNumber ?? '').toLowerCase();
      return (
        name.includes(q) ||
        dept.includes(q) ||
        position.includes(q) ||
        personnel.includes(q) ||
        r.id.toLowerCase().includes(q)
      );
    });
  }, [rows, query]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [filtered]);

  const tableHeader = (
    <thead>
      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Сотрудник</th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Должность</th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Подразделение</th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Статус</th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Доступ</th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', width: 140 }}>Действия</th>
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
                <td colSpan={6} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет сотрудников' : 'Не найдено'}
                </td>
              </tr>
            )}
            {items.map((row) => {
              const status = String(row.employmentStatus ?? '').toLowerCase();
              const statusLabel = status === 'fired' ? 'уволен' : status ? status : 'работает';
              const accessState = row.accessEnabled;
              const hasAccess = accessState === true;
              const accessLabel = accessState === true ? 'Доступ разрешён' : accessState === false ? 'Доступ запрещён' : 'Нет данных';
              const accessColor = accessState === true ? '#065f46' : accessState === false ? '#b91c1c' : '#6b7280';
              return (
                <tr
                  key={row.id}
                  style={{
                    borderBottom: '1px solid #f3f4f6',
                    cursor: 'pointer',
                  }}
                  onClick={() => void props.onOpen(row.id)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f9fafb';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.displayName || '(без ФИО)'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.position || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.departmentName || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{statusLabel}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: accessColor }}>
                    {accessLabel}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    {props.canDelete && (
                      <Button
                        variant="ghost"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!confirm('Удалить сотрудника?')) return;
                          try {
                            setStatus('Удаление…');
                            const r = await window.matrica.employees.delete(row.id);
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
              );
            })}
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
              try {
                setStatus('Создание сотрудника...');
                const r = await window.matrica.employees.create();
                if (!r.ok) {
                  setStatus(`Ошибка: ${r.error}`);
                  return;
                }
                setStatus('');
                await props.onOpen(r.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Создать сотрудника
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по ФИО…" />
        </div>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}
