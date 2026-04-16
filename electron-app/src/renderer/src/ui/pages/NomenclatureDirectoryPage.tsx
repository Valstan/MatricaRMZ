import React, { useCallback, useEffect, useState } from 'react';
import type { NomenclatureItemType, WarehouseNomenclatureListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { buildNomenclatureCode } from '../utils/nomenclatureCode.js';

type CreateConfig = {
  codePrefix: string;
  name: string;
  itemType: NomenclatureItemType;
  category: string;
};

export function NomenclatureDirectoryPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canView?: boolean;
  noAccessText?: string;
  directoryKind: string;
  emptyText: string;
  searchPlaceholder: string;
  createButtonText: string;
  createConfig: CreateConfig;
  secondaryAction?: React.ReactNode;
}) {
  const [rows, setRows] = useState<WarehouseNomenclatureListItem[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const canView = props.canView !== false;

  const refresh = useCallback(async () => {
    if (!canView) return;
    try {
      setStatus('Загрузка...');
      const result = await window.matrica.warehouse.nomenclatureList({
        directoryKind: props.directoryKind,
        ...(query.trim() ? { search: query.trim() } : {}),
        limit: 1000,
        offset: 0,
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows((result.rows ?? []) as WarehouseNomenclatureListItem[]);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [canView, props.directoryKind, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!canView) {
    return <div style={{ color: 'var(--subtle)' }}>{props.noAccessText ?? 'Недостаточно прав для просмотра.'}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate ? (
          <Button
            onClick={async () => {
              const created = await window.matrica.warehouse.nomenclatureUpsert({
                code: buildNomenclatureCode(props.createConfig.codePrefix),
                name: props.createConfig.name,
                itemType: props.createConfig.itemType,
                category: props.createConfig.category,
                directoryKind: props.directoryKind,
                isActive: true,
              });
              if (!created?.ok) {
                setStatus(`Ошибка: ${String(created.error ?? 'не удалось создать')}`);
                return;
              }
              if (!created.id) {
                setStatus('Ошибка: не удалось создать');
                return;
              }
              await refresh();
              await props.onOpen(String(created.id));
            }}
          >
            {props.createButtonText}
          </Button>
        ) : null}

        {props.secondaryAction}

        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={props.searchPlaceholder} />
        </div>
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
              <th style={{ textAlign: 'left' }}>SKU</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  {props.emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => void props.onOpen(String(row.id))}>
                  <td>{row.code || '—'}</td>
                  <td>{row.name || '—'}</td>
                  <td>{row.sku || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
