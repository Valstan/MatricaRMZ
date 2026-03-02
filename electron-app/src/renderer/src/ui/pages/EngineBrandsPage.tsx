import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { listAllParts } from '../utils/partsPagination.js';
import {
  createEngineBrandSummarySyncState,
  PARTS_KINDS_COUNT_ATTR_CODE,
  PARTS_TOTAL_QTY_ATTR_CODE,
  persistBrandSummary,
  toStoredInteger,
  type EngineBrandSummarySyncState,
} from '../utils/engineBrandSummary.js';

type Row = {
  id: string;
  displayName?: string;
  searchText?: string;
  updatedAt: number;
  partsCount?: number | null;
  partsKindsCount?: number | null;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
};
type SortKey = 'displayName' | 'partsCount' | 'updatedAt';

function getBrandPartsStats(parts: unknown[]): Map<string, { kinds: number; totalQty: number }> {
  const map = new Map<string, { partIds: Set<string>; totalQty: number }>();

  for (const item of parts) {
    const part = item as Record<string, unknown>;
    const partId = String(part?.id || '').trim();
    if (!partId) continue;

    const brandLinks = Array.isArray(part?.brandLinks) ? (part?.brandLinks as Array<Record<string, unknown>>) : [];
    for (const link of brandLinks) {
      const brandId = String(link?.engineBrandId || '').trim();
      if (!brandId) continue;

      const current = map.get(brandId) ?? { partIds: new Set<string>(), totalQty: 0 };
      const rawQty = Number(link?.quantity);
      const qty = Number.isFinite(rawQty) ? Math.max(0, Math.floor(rawQty)) : 0;

      current.partIds.add(partId);
      current.totalQty += qty;
      map.set(brandId, current);
    }
  }

  const out = new Map<string, { kinds: number; totalQty: number }>();
  for (const [brandId, value] of map.entries()) {
    out.set(brandId, { kinds: value.partIds.size, totalQty: value.totalQty });
  }
  return out;
}

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
  const persistedSummaryState = useRef<EngineBrandSummarySyncState>(createEngineBrandSummarySyncState());
  const summaryDeps = useMemo(
    () => ({
      entityTypesList: async () => (await window.matrica.admin.entityTypes.list()) as unknown[],
      upsertAttributeDef: async (args: {
        entityTypeId: string;
        code: string;
        name: string;
        dataType: 'number';
        sortOrder: number;
      }) => window.matrica.admin.attributeDefs.upsert(args),
      setEntityAttr: async (entityId: string, code: string, value: number) =>
        window.matrica.admin.entities.setAttr(entityId, code, value) as Promise<{ ok: boolean; error?: string }>,
      listPartsByBrand: async (args: { engineBrandId: string; limit: number; offset?: number }) =>
        window.matrica.parts.list(args)
          .then((r) => r as { ok: boolean; parts?: unknown[]; error?: string })
          .catch((error) => ({ ok: false as const, error: String(error) })),
    }),
    [],
  );
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

  async function persistBrandSummaries(summaries: Array<{ id: string; kinds: number; totalQty: number }>): Promise<void> {
    if (!summaries.length || !persistedSummaryState.current.canPersist) return;
    await Promise.all(
      summaries.map((s) => persistBrandSummary(summaryDeps, persistedSummaryState.current, s.id, s.kinds, s.totalQty)),
    );
  }

  async function loadType() {
    if (!props.canViewMasterData) return;
    const types = await window.matrica.admin.entityTypes.list();
    const type = (types as any[]).find((t) => String(t.code) === 'engine_brand');
    const nextTypeId = type?.id ? String(type.id) : '';
    setTypeId(nextTypeId);
    persistedSummaryState.current.typeId = nextTypeId;
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
        const storedKinds = toStoredInteger((attrs as any)[PARTS_KINDS_COUNT_ATTR_CODE]);
        const storedQty = toStoredInteger((attrs as any)[PARTS_TOTAL_QTY_ATTR_CODE]);
        return {
          id: String(row.id),
          displayName: row.displayName ? String(row.displayName) : '',
          searchText: row.searchText ? String(row.searchText) : '',
          updatedAt: Number(row.updatedAt ?? 0),
          partsCount: storedQty,
          partsKindsCount: storedKinds,
          ...(attachmentPreviews.length > 0 ? { attachmentPreviews } : {}),
        };
      });

      const hasMissingSummary = nextRows.some((row) => row.partsCount == null || row.partsKindsCount == null);
      if (!hasMissingSummary) {
        setRows(nextRows);
        if (!silent) setStatus('');
        return;
      }

      try {
        const r = await listAllParts();
        if (!r.ok) {
          if (!silent) setStatus(r.error ? `Ошибка: ${r.error}` : 'Ошибка загрузки статистики по деталям');
          setRows(nextRows);
          return;
        }

        const stats = getBrandPartsStats(r.parts);
        const withStats = nextRows.map((row) => {
          const value = stats.get(row.id);
          return {
            ...row,
            partsKindsCount: value?.kinds ?? 0,
            partsCount: value ? value.totalQty : 0,
          };
        });
        const prevRowsById = new Map(nextRows.map((row) => [row.id, row]));
        const toPersist = withStats
          .filter((row) => {
            const prev = prevRowsById.get(row.id);
            if (!prev) return false;
            return prev.partsKindsCount !== row.partsKindsCount || prev.partsCount !== row.partsCount;
          })
          .filter((row) => row.partsKindsCount != null && row.partsCount != null)
          .map((row) => ({ id: row.id, kinds: row.partsKindsCount!, totalQty: row.partsCount! }));
        setRows(withStats);
        void persistBrandSummaries(toPersist);
        if (!silent) setStatus('');
      } catch {
        setRows((prev) => prev.map((row) => ({ ...row, partsCount: row.partsCount ?? null, partsKindsCount: row.partsKindsCount ?? null })));
        if (!silent) setStatus('');
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
          Количество деталей (видов / шт.) {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'partsCount')}
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
                  {row.partsCount == null || row.partsKindsCount == null ? '—' : `${row.partsKindsCount} / ${row.partsCount}`}
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
