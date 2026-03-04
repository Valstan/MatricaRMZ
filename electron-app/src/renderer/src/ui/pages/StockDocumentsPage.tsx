import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';

type Row = {
  id: string;
  docType?: string;
  docNo?: string;
  docDate?: number;
  status?: string;
};

const DOC_TYPES = [
  { id: '', label: 'Все типы' },
  { id: 'stock_receipt', label: 'Приход' },
  { id: 'stock_issue', label: 'Расход' },
  { id: 'stock_transfer', label: 'Перемещение' },
  { id: 'stock_writeoff', label: 'Списание' },
  { id: 'stock_inventory', label: 'Инвентаризация' },
];

export function StockDocumentsPage(props: {
  defaultDocType?: string;
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [docType, setDocType] = useState(props.defaultDocType ?? '');

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка...');
      const result = await window.matrica.warehouse.documentsList({
        ...(docType ? { docType } : {}),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows((result.rows ?? []) as Row[]);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [docType]);

  useEffect(() => {
    setDocType(props.defaultDocType ?? '');
  }, [props.defaultDocType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.docDate ?? 0) - Number(a.docDate ?? 0)),
    [rows],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select value={docType} onChange={(e) => setDocType(e.target.value)} style={{ minWidth: 220, padding: '8px 10px' }}>
          {DOC_TYPES.map((item) => (
            <option key={item.id || 'all'} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        {props.canEdit ? (
          <Button
            onClick={async () => {
              const now = Date.now();
              const type = docType || props.defaultDocType || 'stock_receipt';
              const created = await window.matrica.warehouse.documentCreate({
                docType: type,
                docNo: `WH-${String(now).slice(-8)}`,
                docDate: now,
                payloadJson: JSON.stringify({ warehouseId: 'default' }),
                lines: [
                  {
                    qty: 1,
                    payloadJson: JSON.stringify({ warehouseId: 'default' }),
                  },
                ],
              });
              if (!created?.ok || !created.id) {
                setStatus(`Ошибка: ${String(created?.error ?? 'не удалось создать документ')}`);
                return;
              }
              await refresh();
              props.onOpen(String(created.id));
            }}
          >
            Создать документ
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Номер</th>
              <th style={{ textAlign: 'left' }}>Тип</th>
              <th style={{ textAlign: 'left' }}>Дата</th>
              <th style={{ textAlign: 'left' }}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 12 }}>
                  Нет документов
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                  <td>{row.docNo || '—'}</td>
                  <td>{DOC_TYPES.find((x) => x.id === row.docType)?.label ?? row.docType ?? '—'}</td>
                  <td>{row.docDate ? new Date(Number(row.docDate)).toLocaleString('ru-RU') : '—'}</td>
                  <td>{row.status || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
