import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { matchesQueryInRecord } from '../utils/search.js';
import { parseIdArray } from '../utils/groupBrandIds.js';

type GroupRow = { id: string; name: string; description: string; brandCount: number };

export function EngineBrandGroupsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canViewMasterData: boolean;
}) {
  const [entityTypeId, setEntityTypeId] = useState<string | null>(null);
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const { confirm } = useConfirm();

  const refresh = useCallback(async () => {
    if (!props.canViewMasterData) return;
    try {
      setStatus('Загрузка...');
      const types = (await window.matrica.admin.entityTypes.list()) as Array<{ id: string; code: string }>;
      const gt = types.find((t) => String(t.code) === 'engine_brand_group');
      if (!gt?.id) {
        setEntityTypeId(null);
        setRows([]);
        setStatus('Тип «Группы марок двигателей» не найден (перезапустите клиент для инициализации).');
        return;
      }
      setEntityTypeId(gt.id);
      const list = (await window.matrica.admin.entities.listByEntityType(gt.id)) as Array<{ id: string; displayName?: string }>;
      // Групп немного (справочник оператора) — грузим детали каждой для описания и числа марок.
      const details = await Promise.all(
        list.map(async (r) => {
          const det = await window.matrica.admin.entities.get(String(r.id), gt.id).catch(() => null);
          const attrs = (det as { attributes?: Record<string, unknown> } | null)?.attributes ?? {};
          return {
            id: String(r.id),
            name: String(attrs.name ?? r.displayName ?? '').trim() || String(r.id),
            description: String(attrs.description ?? '').trim(),
            brandCount: parseIdArray(attrs.engine_brand_ids).length,
          };
        }),
      );
      setRows(details);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.canViewMasterData]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useLiveDataRefresh(refresh, { enabled: props.canViewMasterData, intervalMs: 20000 });

  const filtered = useMemo(
    () => rows.filter((r) => matchesQueryInRecord(query, { name: r.name, description: r.description, id: r.id })),
    [rows, query],
  );
  const sorted = useMemo(() => [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'ru')), [filtered]);

  async function addGroup() {
    if (!props.canCreate || !entityTypeId) return;
    setStatus('');
    // Deferred-create: пустая карточка на клиентском id; строка материализуется при первом сохранении.
    await props.onOpen(crypto.randomUUID()).catch((e) => setStatus(`Ошибка: ${String(e)}`));
  }

  async function removeGroup(row: GroupRow) {
    const ok = await confirm({
      title: 'Удалить группу марок?',
      detail: `Группа «${row.name}» будет удалена. Уже привязанные к маркам детали останутся как есть (группа — только удобный список).`,
      confirmLabel: 'Удалить',
      confirmTone: 'danger',
    });
    if (!ok) return;
    const r = await window.matrica.admin.entities.softDelete(row.id);
    if (r?.ok) {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
    } else {
      setStatus(`Ошибка удаления: ${String((r as { error?: string })?.error ?? 'unknown')}`);
    }
  }

  if (!props.canViewMasterData) {
    return <div style={{ color: 'var(--subtle)' }}>Недостаточно прав для просмотра групп марок.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate ? (
          <Button onClick={() => void addGroup()} disabled={!entityTypeId}>
            Создать группу
          </Button>
        ) : null}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию или описанию..." />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
        Группа — удобный список марок двигателей. Используется, чтобы разом привязать деталь ко всем маркам группы (в карточке
        детали → «Применяемость»). Марка может входить в несколько групп.
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid #e5e7eb', overflowX: 'clip' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th data-col-kind="name" style={{ textAlign: 'left' }}>Название группы</th>
              <th data-col-kind="num" style={{ textAlign: 'right', width: 90 }} title="Сколько марок в группе">Марок</th>
              <th data-col-kind="text" style={{ textAlign: 'left' }}>Описание</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => void props.onOpen(row.id)}>
                <td data-col-kind="name">{row.name}</td>
                <td data-col-kind="num" style={{ textAlign: 'right' }}>{row.brandCount}</td>
                <td data-col-kind="text">{row.description || <span style={{ color: 'var(--subtle)' }}>—</span>}</td>
                <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                  {props.canCreate ? (
                    <Button variant="ghost" size="sm" tone="danger" onClick={() => void removeGroup(row)} title="Удалить группу">
                      ✕
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={4}>
                  Групп марок пока нет. Нажмите «Создать группу».
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {sorted.length}</div>
    </div>
  );
}
