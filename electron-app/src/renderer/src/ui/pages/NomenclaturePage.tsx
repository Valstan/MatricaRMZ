import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type Row = {
  id: string;
  code?: string | null;
  name?: string | null;
  itemType?: string | null;
  barcode?: string | null;
  isActive?: boolean;
  updatedAt?: number;
};

const ITEM_TYPE_LABELS: Record<string, string> = {
  material: 'Материал',
  component: 'Комплектующая',
  product: 'Изделие',
  semi_product: 'Полуфабрикат',
  waste: 'Отходы',
  tool_consumable: 'Расходник',
};

export function NomenclaturePage(props: {
  onOpen: (id: string) => void;
  canEdit: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [itemType, setItemType] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка...');
      const result = await window.matrica.warehouse.nomenclatureList({
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(itemType ? { itemType } : {}),
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
  }, [itemType, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const byName = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
        if (byName !== 0) return byName;
        return String(a.code ?? '').localeCompare(String(b.code ?? ''), 'ru');
      }),
    [rows],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canEdit ? (
          <Button
            onClick={async () => {
              const now = Date.now();
              const code = `NM-${String(now).slice(-8)}`;
              const created = await window.matrica.warehouse.nomenclatureUpsert({
                code,
                name: 'Новая номенклатура',
                itemType: 'material',
                isActive: true,
              });
              if (!created?.ok || !created.id) {
                setStatus(`Ошибка: ${String(created?.error ?? 'не удалось создать')}`);
                return;
              }
              await refresh();
              props.onOpen(String(created.id));
            }}
          >
            Добавить позицию
          </Button>
        ) : null}
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по коду, наименованию, штрихкоду..." />
        <select value={itemType} onChange={(e) => setItemType(e.target.value)} style={{ minWidth: 180, padding: '8px 10px' }}>
          <option value="">Все типы</option>
          {Object.entries(ITEM_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Код</th>
              <th style={{ textAlign: 'left' }}>Наименование</th>
              <th style={{ textAlign: 'left' }}>Тип</th>
              <th style={{ textAlign: 'left' }}>Штрихкод</th>
              <th style={{ textAlign: 'left' }}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 14 }}>
                  Нет данных
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                  <td>{row.code || '—'}</td>
                  <td>{row.name || '—'}</td>
                  <td>{ITEM_TYPE_LABELS[String(row.itemType ?? '')] ?? String(row.itemType ?? '—')}</td>
                  <td>{row.barcode || '—'}</td>
                  <td>{row.isActive === false ? 'Неактивна' : 'Активна'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
