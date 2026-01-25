import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';

type Row = {
  id: string;
  requestNumber: string;
  compiledAt: number;
  status: string;
  title: string;
  departmentId: string;
  workshopId: string | null;
  sectionId: string | null;
  updatedAt: number;
};

function statusLabel(s: string): string {
  switch (s) {
    case 'draft':
      return 'Черновик';
    case 'signed':
      return 'Подписана начальником цеха';
    case 'director_approved':
      return 'Одобрена директором';
    case 'accepted':
      return 'Принята к исполнению';
    case 'fulfilled_full':
      return 'Исполнена полностью';
    case 'fulfilled_partial':
      return 'Исполнена частично';
    default:
      return s;
  }
}

export function SupplyRequestsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const [query, setQuery] = useState<string>('');
  const [month, setMonth] = useState<string>(''); // YYYY-MM
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const width = useWindowWidth();
  const twoCol = width >= 1600;

  async function refresh() {
    try {
      setStatus('Загрузка…');
      const r = await window.matrica.supplyRequests.list({ q: query.trim() || undefined, month: month || undefined });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows(r.requests as any);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [rows]);

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #a21caf 0%, #7c3aed 120%)', color: '#fff' }}>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Номер</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Дата</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Статус</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Описание</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Подразделение</th>
        {props.canDelete && (
          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, width: 100 }}>Действия</th>
        )}
      </tr>
    </thead>
  );

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          {tableHeader}
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {r.requestNumber || r.id}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {r.compiledAt ? new Date(r.compiledAt).toLocaleDateString('ru-RU') : '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {statusLabel(r.status)}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {r.title || '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {r.departmentId || '-'}
                </td>
                {props.canDelete && (
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }} onClick={(ev) => ev.stopPropagation()}>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm('Удалить заявку?')) return;
                        const result = await window.matrica.supplyRequests.delete(r.id);
                        if (!result.ok) {
                          alert(`Ошибка удаления: ${result.error}`);
                          return;
                        }
                        void refresh();
                      }}
                      style={{ color: '#b91c1c' }}
                    >
                      Удалить
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={props.canDelete ? 6 : 5}>
                  Ничего не найдено
                </td>
              </tr>
            )}
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
              const r = await window.matrica.supplyRequests.create();
              if (!r.ok) {
                setStatus(`Ошибка: ${r.error}`);
                return;
              }
              await props.onOpen(r.id);
            }}
          >
            Создать заявку
          </Button>
        )}
        <div style={{ width: '50%', minWidth: 260 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию/тексту/товарам…" />
        </div>
        <div style={{ width: 180 }}>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Поиск
        </Button>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}


