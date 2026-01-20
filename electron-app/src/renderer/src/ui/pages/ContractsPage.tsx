import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';

type Row = {
  id: string;
  number: string;
  internalNumber: string;
  dateMs: number | null;
  updatedAt: number;
};

function normalize(s: string) {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function ContractsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [contractTypeId, setContractTypeId] = useState<string>('');
  const width = useWindowWidth();
  const twoCol = width >= 1400;

  async function loadContracts() {
    try {
      setStatus('Загрузка…');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'contract') ?? null;
      if (!type?.id) {
        setContractTypeId('');
        setRows([]);
        setStatus('Справочник «Контракты» не найден (contract).');
        return;
      }
      setContractTypeId(String(type.id));
      const list = await window.matrica.admin.entities.listByEntityType(String(type.id));
      if (!Array.isArray(list) || list.length === 0) {
        setRows([]);
        setStatus('');
        return;
      }
      const details = await Promise.all(
        list.map(async (row: any) => {
          try {
            const d = await window.matrica.admin.entities.get(String(row.id));
            const attrs = (d as any).attributes ?? {};
            const numberRaw = attrs.number ?? row.displayName ?? '';
            const internalRaw = attrs.internal_number ?? '';
            const dateMs = typeof attrs.date === 'number' ? Number(attrs.date) : null;
            return {
              id: String(row.id),
              number: numberRaw == null ? '' : String(numberRaw),
              internalNumber: internalRaw == null ? '' : String(internalRaw),
              dateMs,
              updatedAt: Number(row.updatedAt ?? 0),
            };
          } catch {
            return {
              id: String(row.id),
              number: row.displayName ? String(row.displayName) : String(row.id).slice(0, 8),
              internalNumber: '',
              dateMs: null,
              updatedAt: Number(row.updatedAt ?? 0),
            };
          }
        }),
      );
      setRows(details);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void loadContracts();
  }, []);

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return rows;
    return rows.filter((r) => normalize(r.number).includes(q) || normalize(r.internalNumber).includes(q));
  }, [rows, query]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [filtered]);

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #0f766e 0%, #1d4ed8 120%)', color: '#fff' }}>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Номер</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Внутр. номер</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Дата</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Обновлено</th>
      </tr>
    </thead>
  );

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          {tableHeader}
          <tbody>
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
                <td style={{ padding: '8px 10px' }}>{row.number || '(без номера)'}</td>
                <td style={{ padding: '8px 10px', color: '#6b7280' }}>{row.internalNumber || '—'}</td>
                <td style={{ padding: '8px 10px', color: '#6b7280' }}>
                  {row.dateMs ? new Date(row.dateMs).toLocaleDateString('ru-RU') : '—'}
                </td>
                <td style={{ padding: '8px 10px', color: '#6b7280' }}>
                  {row.updatedAt ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: 10, color: '#6b7280' }}>
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
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate && (
          <Button
            onClick={async () => {
              if (!contractTypeId) return;
              try {
                setStatus('Создание контракта…');
                const r = await window.matrica.admin.entities.create(contractTypeId);
                if (!r?.ok || !r?.id) {
                  setStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
                  return;
                }
                setStatus('');
                await loadContracts();
                await props.onOpen(String(r.id));
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Создать контракт
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по номеру/внутреннему номеру…" />
        </div>
        <Button variant="ghost" onClick={() => void loadContracts()}>
          Обновить
        </Button>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 8 }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}
