import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { useConfirm } from '../components/ConfirmContext.js';

type LocationRow = {
  id: string;
  type: 'system' | 'workshop' | 'regular';
  code: string;
  name: string;
  workshopId: string | null;
  isActive: boolean;
  sortOrder: number;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
};

type FilterType = 'all' | 'system' | 'workshop' | 'regular';

const TYPE_LABELS: Record<LocationRow['type'], string> = {
  system: 'Системная',
  workshop: 'Цех',
  regular: 'Прочая',
};

const TYPE_HELP: Record<LocationRow['type'], string> = {
  system: 'Зарезервированная системная локация (default, repair_fund, scrap, assembly_in_progress). Управляется миграциями БД, не редактируется здесь.',
  workshop: 'Цех. Редактируется в разделе «Контроль и аналитика → Цеха». Изменения там автоматически отражаются здесь.',
  regular: 'Пользовательский склад. Полный CRUD в этом разделе.',
};

export function WarehouseLocationsAdminPage(props: { canManage: boolean; onOpenWorkshops?: () => void }) {
  const [rows, setRows] = useState<LocationRow[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');

  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<Record<string, { name: string; code: string; isActive: boolean; sortOrder: number }>>({});

  const { confirm } = useConfirm();

  const refresh = useCallback(async () => {
    setStatus('Загрузка...');
    try {
      const [listRes, usageRes] = await Promise.all([
        window.matrica.warehouseLocations.list(),
        window.matrica.warehouseLocations.registerUsage(),
      ]);
      if (!listRes.ok) {
        setStatus(`Ошибка: ${listRes.error}`);
        return;
      }
      setRows(listRes.rows);
      setEditing({});
      if (usageRes.ok) setUsage(usageRes.usage);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter !== 'all' && row.type !== filter) return false;
      if (q) {
        const hay = `${row.name} ${row.code}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, query, filter]);

  function getEdit(row: LocationRow) {
    return (
      editing[row.id] ?? {
        name: row.name,
        code: row.code,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
      }
    );
  }

  function patchEdit(rowId: string, patch: Partial<{ name: string; code: string; isActive: boolean; sortOrder: number }>) {
    const base = rows.find((r) => r.id === rowId);
    if (!base) return;
    setEditing((prev) => ({
      ...prev,
      [rowId]: {
        ...(prev[rowId] ?? { name: base.name, code: base.code, isActive: base.isActive, sortOrder: base.sortOrder }),
        ...patch,
      },
    }));
  }

  async function saveRow(row: LocationRow) {
    if (!props.canManage) return;
    if (row.type !== 'regular') {
      setStatus('Локации этого типа редактируются в другом разделе');
      return;
    }
    const draft = editing[row.id];
    if (!draft) return;
    setStatus('Сохраняю...');
    const res = await window.matrica.warehouseLocations.upsert({
      id: row.id,
      type: 'regular',
      code: draft.code.trim(),
      name: draft.name.trim(),
      isActive: draft.isActive,
      sortOrder: draft.sortOrder,
    });
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    await refresh();
  }

  async function deleteRow(row: LocationRow) {
    if (!props.canManage) return;
    if (row.type !== 'regular') {
      setStatus('Локации этого типа удаляются в другом разделе');
      return;
    }
    const refs = usage[row.code] ?? 0;
    const ok = await confirm({
      title: 'Удалить локацию?',
      detail: refs > 0
        ? `Локация "${row.name}" используется в ${refs} строках остатков. Soft-delete: запись скрывается из списка, но исторические движения сохраняются. Действие необратимо.`
        : `Локация "${row.name}" будет скрыта (soft-delete). Действие необратимо.`,
      confirmLabel: 'Удалить',
    });
    if (!ok) return;
    setStatus('Удаляю...');
    const res = await window.matrica.warehouseLocations.delete(row.id);
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    await refresh();
  }

  /** Технический code для пользовательских складов — оператор его не видит и не задаёт. */
  function generateRegularCode(): string {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 8);
    return `wh_${ts}_${rnd}`;
  }

  async function createNew() {
    if (!props.canManage) return;
    const name = newName.trim();
    if (!name) {
      setStatus('Заполните «Название»');
      return;
    }
    setStatus('Создаю...');
    const maxOrder = rows.reduce((acc, r) => Math.max(acc, r.sortOrder), 0);
    const res = await window.matrica.warehouseLocations.upsert({
      type: 'regular',
      code: generateRegularCode(),
      name,
      isActive: true,
      sortOrder: maxOrder + 10,
    });
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    setNewName('');
    await refresh();
  }

  const counts = useMemo(() => {
    const c = { system: 0, workshop: 0, regular: 0 };
    for (const r of rows) c[r.type] += 1;
    return c;
  }, [rows]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Склады и цеха</h2>
        <Button variant="ghost" onClick={() => void refresh()}>Обновить</Button>
        <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
          Единый справочник складских локаций. Цеха автоматически синхронизируются из раздела «Цеха».
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12 }}>Тип:</span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterType)}
            style={{ height: 28, padding: '2px 8px' }}
          >
            <option value="all">Все ({rows.length})</option>
            <option value="system">Системные ({counts.system})</option>
            <option value="workshop">Цеха ({counts.workshop})</option>
            <option value="regular">Прочие ({counts.regular})</option>
          </select>
        </label>
        <div style={{ flex: 1, minWidth: 220 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск (название/код)" />
        </div>
        {props.onOpenWorkshops ? (
          <Button variant="ghost" onClick={props.onOpenWorkshops}>
            Открыть «Цеха» →
          </Button>
        ) : null}
      </div>

      {status ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>
      ) : null}

      {props.canManage ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 8, border: '1px solid var(--border)', borderRadius: 4 }}>
          <strong style={{ minWidth: 180 }}>Создать пользовательский склад:</strong>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createNew(); }}
            placeholder="Название (например, «Склад поставщика А»)"
            style={{ flex: 1 }}
          />
          <Button onClick={() => void createNew()}>Создать</Button>
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th data-col-kind="flag" title="Тип" style={{ width: 110 }}>Тип</th>
              <th data-col-kind="name" style={{ width: 220 }}>Код (warehouseId)</th>
              <th data-col-kind="name">Название</th>
              <th data-col-kind="flag" title="Активен" style={{ width: 80, textAlign: 'center' }}>Активен</th>
              <th data-col-kind="num" title="Порядок" style={{ width: 90, textAlign: 'right' }}>Порядок</th>
              <th data-col-kind="num" title="Остатков" style={{ width: 110, textAlign: 'right' }}>Остатков</th>
              <th style={{ width: 220 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  Нет локаций под фильтр
                </td>
              </tr>
            ) : (
              filtered.map((row) => {
                const isRegular = row.type === 'regular';
                const edit = getEdit(row);
                const dirty = editing[row.id] !== undefined;
                const refs = usage[row.code] ?? 0;
                return (
                  <tr key={row.id} title={TYPE_HELP[row.type]}>
                    <td data-col-kind="flag">
                      <span style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: 10,
                        fontSize: 11,
                        background: row.type === 'system' ? '#e0e7ff' : row.type === 'workshop' ? '#dcfce7' : '#fef3c7',
                        color: row.type === 'system' ? '#3730a3' : row.type === 'workshop' ? '#166534' : '#92400e',
                      }}>
                        {TYPE_LABELS[row.type]}
                      </span>
                    </td>
                    <td data-col-kind="name">
                      {isRegular && props.canManage ? (
                        <Input
                          value={edit.code}
                          onChange={(e) => patchEdit(row.id, { code: e.target.value })}
                          style={{ width: '100%' }}
                        />
                      ) : (
                        <code style={{ fontSize: 12 }}>{row.code}</code>
                      )}
                    </td>
                    <td data-col-kind="name">
                      {isRegular && props.canManage ? (
                        <Input
                          value={edit.name}
                          onChange={(e) => patchEdit(row.id, { name: e.target.value })}
                          style={{ width: '100%' }}
                        />
                      ) : (
                        row.name
                      )}
                    </td>
                    <td data-col-kind="flag" style={{ textAlign: 'center' }}>
                      {isRegular && props.canManage ? (
                        <input
                          type="checkbox"
                          checked={edit.isActive}
                          onChange={(e) => patchEdit(row.id, { isActive: e.target.checked })}
                        />
                      ) : row.isActive ? '✓' : '—'}
                    </td>
                    <td data-col-kind="num" style={{ textAlign: 'right' }}>
                      {isRegular && props.canManage ? (
                        <Input
                          type="number"
                          value={String(edit.sortOrder)}
                          onChange={(e) => patchEdit(row.id, { sortOrder: Number(e.target.value) || 0 })}
                          style={{ width: 80, textAlign: 'right' }}
                        />
                      ) : row.sortOrder}
                    </td>
                    <td data-col-kind="num" style={{ textAlign: 'right' }}>{refs > 0 ? refs : '—'}</td>
                    <td>
                      {isRegular && props.canManage ? (
                        <>
                          <Button onClick={() => void saveRow(row)} disabled={!dirty}>Сохранить</Button>{' '}
                          <Button variant="ghost" onClick={() => void deleteRow(row)}>Удалить</Button>
                        </>
                      ) : (
                        <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
                          {row.type === 'system' ? 'read-only (миграция)' : 'редактируется в «Цехах»'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
