import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { matchesQueryInRecord } from '../utils/search.js';

type Row = {
  id: string;
  displayName?: string;
  updatedAt: number;
  partsCount?: number | null;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
};
type SortKey = 'displayName' | 'partsCount' | 'updatedAt';

function toAttachmentPreviews(raw: unknown): Array<{ id: string; name: string; mime: string | null }> {
  if (!Array.isArray(raw)) return [];
  const previews: Array<{ id: string; name: string; mime: string | null }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.isObsolete === true) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name) continue;
    const mime = typeof entry.mime === 'string' ? entry.mime : null;
    previews.push({ id, name, mime });
    if (previews.length >= 5) break;
  }
  return previews;
}

function collectAttachmentPreviews(attrs: Record<string, unknown>): Array<{ id: string; name: string; mime: string | null }> {
  const out: Array<{ id: string; name: string; mime: string | null }> = [];
  const seen = new Set<string>();
  for (const value of Object.values(attrs)) {
    for (const preview of toAttachmentPreviews(value)) {
      if (seen.has(preview.id)) continue;
      seen.add(preview.id);
      out.push(preview);
      if (out.length >= 5) return out;
    }
  }
  return out;
}

export function EngineBrandsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canViewMasterData: boolean;
}) {
  const { state: listState, patchState } = useListUiState('list:engine_brands', {
    query: '',
    sortKey: 'displayName' as SortKey,
    sortDir: 'asc' as const,
    showPreviews: true,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:engine_brands');
  const query = String(listState.query ?? '');
  const showPreviews = listState.showPreviews !== false;
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [typeId, setTypeId] = useState<string>('');
  const width = useWindowWidth();
  const { isMultiColumn, toggle: toggleColumnsMode } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;

  async function loadType() {
    if (!props.canViewMasterData) return;
    const types = await window.matrica.admin.entityTypes.list();
    const type = (types as any[]).find((t) => String(t.code) === 'engine_brand');
    setTypeId(type?.id ? String(type.id) : '');
  }

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!props.canViewMasterData) return;
    if (!typeId) {
      if (!silent) setStatus('Справочник марок двигателя не найден (engine_brand).');
      setRows([]);
      return;
    }
    try {
      if (!silent) setStatus('Загрузка…');
      const list = await window.matrica.admin.entities.listByEntityType(typeId);
      const baseRows = list as any[];
      const details = await Promise.all(baseRows.map((row) => window.matrica.admin.entities.get(String(row.id)).catch(() => null)));
      const nextRows = baseRows.map((row, idx) => {
        const attrs = (details[idx] as any)?.attributes ?? {};
        const attachmentPreviews = collectAttachmentPreviews(attrs);
        return {
          id: String(row.id),
          displayName: row.displayName ? String(row.displayName) : '',
          updatedAt: Number(row.updatedAt ?? 0),
          partsCount: null,
          ...(attachmentPreviews.length > 0 ? { attachmentPreviews } : {}),
        };
      });
      setRows(nextRows);
      if (!silent) setStatus('');
      try {
        const counts = await Promise.all(
          nextRows.map(async (row) => {
            const r = await window.matrica.parts.list({ engineBrandId: row.id, limit: 5000 }).catch((e) => ({
              ok: false as const,
              error: String(e),
            }));
            if (!r.ok) return { id: row.id, count: null };
            return { id: row.id, count: Array.isArray((r as any).parts) ? (r as any).parts.length : null };
          }),
        );
        const countMap = new Map(counts.map((c) => [c.id, c.count]));
        setRows((prev) => prev.map((row) => ({ ...row, partsCount: countMap.get(row.id) ?? row.partsCount ?? null })));
      } catch {
        // ignore parts count errors
      }
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.canViewMasterData, typeId]);

  useEffect(() => {
    void loadType();
  }, [props.canViewMasterData]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useLiveDataRefresh(
    useCallback(async () => {
      await refresh({ silent: true });
    }, [refresh]),
    { enabled: !!typeId && props.canViewMasterData, intervalMs: 15000 },
  );

  const filtered = useMemo(() => {
    return rows.filter((row) => matchesQueryInRecord(query, row));
  }, [rows, query]);

  const sorted = useSortedItems(
    filtered,
    listState.sortKey as SortKey,
    listState.sortDir,
    (row, key) => {
      if (key === 'partsCount') return Number(row.partsCount ?? 0);
      if (key === 'updatedAt') return Number(row.updatedAt ?? 0);
      return String(row.displayName ?? '').toLowerCase();
    },
    (row) => row.id,
  );
  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const tableHeader = (
    <thead>
      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('displayName')}>
          Наименование марки двигателя {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'displayName')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('partsCount')}>
          Количество деталей {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'partsCount')}
        </th>
        {showPreviews && <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontSize: 14, color: '#374151', width: 220 }}>Превью</th>}
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
                <td
                  colSpan={showPreviews ? 3 : 2}
                  style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}
                >
                  {rows.length === 0 ? 'Нет марок' : 'Не найдено'}
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
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>
                  {row.partsCount == null ? '—' : row.partsCount}
                </td>
                {showPreviews && (
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                    <ListRowThumbs files={row.attachmentPreviews ?? []} />
                  </td>
                )}
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
                setStatus('Создание марки...');
                const created = await window.matrica.admin.entities.create(typeId);
                if (!created?.ok || !created.id) {
                  setStatus('Ошибка: не удалось создать марку');
                  return;
                }
                await window.matrica.admin.entities.setAttr(created.id, 'name', 'Новая марка');
                setStatus('');
                await refresh();
                await props.onOpen(created.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Добавить марку
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным марки…" />
        </div>
        <Button variant="ghost" onClick={() => patchState({ showPreviews: !showPreviews })}>
          {showPreviews ? 'Отключить превью' : 'Включить превью'}
        </Button>
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}
