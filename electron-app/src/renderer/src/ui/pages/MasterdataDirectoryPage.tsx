import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type MasterdataRow = {
  id: string;
  displayName: string;
  searchText: string;
  updatedAt: number;
};

export function MasterdataDirectoryPage(props: {
  typeCode: string;
  titleLabel: string;
  emptyText: string;
  searchPlaceholder: string;
  createButtonText: string;
  defaultName: string;
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canView?: boolean;
  noAccessText?: string;
}) {
  const [rows, setRows] = useState<MasterdataRow[]>([]);
  const [typeId, setTypeId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const canView = props.canView !== false;

  const refresh = useCallback(async () => {
    if (!canView) return;
    try {
      setStatus('Загрузка...');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as Array<Record<string, unknown>>).find((row) => String(row.code ?? '') === props.typeCode);
      if (!type?.id) {
        setTypeId('');
        setRows([]);
        setStatus(`Справочник "${props.titleLabel}" не найден (${props.typeCode}).`);
        return;
      }
      const resolvedTypeId = String(type.id);
      setTypeId(resolvedTypeId);
      const list = await window.matrica.admin.entities.listByEntityType(resolvedTypeId);
      setRows(
        (Array.isArray(list) ? list : []).map((row: any) => ({
          id: String(row?.id ?? ''),
          displayName: String(row?.displayName ?? '').trim(),
          searchText: String(row?.searchText ?? '').trim(),
          updatedAt: Number(row?.updatedAt ?? 0),
        })),
      );
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [canView, props.titleLabel, props.typeCode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => `${row.displayName} ${row.searchText}`.toLowerCase().includes(q));
  }, [query, rows]);

  if (!canView) {
    return <div style={{ color: 'var(--subtle)' }}>{props.noAccessText ?? 'Недостаточно прав для просмотра.'}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate ? (
          <Button
            onClick={async () => {
              if (!typeId) return;
              try {
                const created = await window.matrica.admin.entities.create(typeId);
                if (!created?.ok || !created.id) {
                  setStatus('Ошибка: не удалось создать запись.');
                  return;
                }
                await window.matrica.admin.entities.setAttr(created.id, 'name', props.defaultName);
                await refresh();
                await props.onOpen(created.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            {props.createButtonText}
          </Button>
        ) : null}
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
              <th style={{ textAlign: 'left' }}>Название</th>
              <th style={{ textAlign: 'left' }}>Обновлено</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={2} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  {rows.length === 0 ? props.emptyText : 'Не найдено'}
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => void props.onOpen(row.id)}>
                  <td>{row.displayName || '(без названия)'}</td>
                  <td>{row.updatedAt > 0 ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

