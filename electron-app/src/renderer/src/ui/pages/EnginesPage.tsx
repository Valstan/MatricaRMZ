import React, { useMemo } from 'react';

import type { EngineListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { useListUiState, usePersistedScrollTop } from '../hooks/useListBehavior.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { matchesQueryInRecord } from '../utils/search.js';

const PAGE_SIZE = 25;
type EngineRow = EngineListItem & {
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
};

export type EnginesPageUiState = {
  query: string;
  sortKey: 'engineNumber' | 'engineBrand' | 'customerName' | 'arrivalDate' | 'shippingDate';
  sortDir: 'asc' | 'desc';
  page: number;
  showPreviews: boolean;
  contractDateFrom: string;
  contractDateTo: string;
};

export function createDefaultEnginesPageUiState(): EnginesPageUiState {
  return {
    query: '',
    sortKey: 'arrivalDate',
    sortDir: 'desc',
    page: 0,
    showPreviews: true,
    contractDateFrom: '',
    contractDateTo: '',
  };
}

function fromInputDate(value: string): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(`${text}T00:00:00`);
  return Number.isFinite(ms) ? ms : null;
}

function endOfInputDate(value: string): number | null {
  const startMs = fromInputDate(value);
  if (startMs == null) return null;
  return startMs + 24 * 60 * 60 * 1000 - 1;
}

function toDateLabel(ms?: number | null) {
  if (!ms) return '';
  const dt = new Date(ms);
  return Number.isNaN(dt.getTime()) ? '' : formatMoscowDate(dt);
}

export function EnginesPage(props: {
  engines: EngineListItem[];
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onCreate: () => Promise<void>;
  canCreate: boolean;
}) {
  const { state: listState, patchState } = useListUiState<EnginesPageUiState>('list:engines', createDefaultEnginesPageUiState());
  const { containerRef, onScroll } = usePersistedScrollTop('list:engines');
  const query = listState.query;
  const sortKey = listState.sortKey;
  const sortDir = listState.sortDir;
  const showPreviews = listState.showPreviews !== false;
  const contractDateFrom = String(listState.contractDateFrom ?? '');
  const contractDateTo = String(listState.contractDateTo ?? '');
  const width = useWindowWidth();
  const { isMultiColumn, toggle: toggleColumnsMode } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;

  const page = listState.page;

  const filtered = useMemo(() => {
    const fromMs = fromInputDate(contractDateFrom);
    const toMs = endOfInputDate(contractDateTo);
    const hasDateFilter = fromMs != null || toMs != null;
    return props.engines.filter((engine) => {
      if (!matchesQueryInRecord(query, engine)) return false;
      if (!hasDateFilter) return true;
      const arrivalDate = typeof engine.arrivalDate === 'number' && Number.isFinite(engine.arrivalDate) ? engine.arrivalDate : null;
      if (arrivalDate == null) return false;
      if (fromMs != null && arrivalDate < fromMs) return false;
      if (toMs != null && arrivalDate > toMs) return false;
      return true;
    });
  }, [props.engines, query, contractDateFrom, contractDateTo]);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) {
      patchState({ sortDir: sortDir === 'asc' ? 'desc' : 'asc', page: 0 });
      return;
    }
    patchState({ sortKey: key, sortDir: 'asc', page: 0 });
  }

  function sortArrow(key: typeof sortKey) {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? '▲' : '▼';
  }

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const byText = (a: string, b: string) => a.localeCompare(b, 'ru') * dir;
    const byDate = (a?: number | null, b?: number | null) => {
      const av = a ?? -1;
      const bv = b ?? -1;
      return (av - bv) * dir;
    };
    const items = [...filtered];
    items.sort((a, b) => {
      switch (sortKey) {
        case 'engineNumber':
          return byText(String(a.engineNumber ?? ''), String(b.engineNumber ?? ''));
        case 'engineBrand':
          return byText(String(a.engineBrand ?? ''), String(b.engineBrand ?? ''));
        case 'customerName':
          return byText(String(a.customerName ?? ''), String(b.customerName ?? ''));
        case 'arrivalDate':
          return byDate(a.arrivalDate ?? null, b.arrivalDate ?? null);
        case 'shippingDate':
          return byDate(a.shippingDate ?? null, b.shippingDate ?? null);
        default:
          return 0;
      }
    });
    return items;
  }, [filtered, sortDir, sortKey]);

  const totalFiltered = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const paged = useMemo(
    () => sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [sorted, safePage],
  );

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 120%)', color: '#fff' }}>
        <th
          style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
          onClick={() => toggleSort('engineNumber')}
        >
          Номер {sortArrow('engineNumber')}
        </th>
        <th
          style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
          onClick={() => toggleSort('engineBrand')}
        >
          Марка {sortArrow('engineBrand')}
        </th>
        <th
          style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
          onClick={() => toggleSort('customerName')}
        >
          Контрагент {sortArrow('customerName')}
        </th>
        <th
          style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
          onClick={() => toggleSort('arrivalDate')}
        >
          Дата прихода {sortArrow('arrivalDate')}
        </th>
        <th
          style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
          onClick={() => toggleSort('shippingDate')}
        >
          Дата отгрузки {sortArrow('shippingDate')}
        </th>
        {showPreviews && (
          <th
            style={{ textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2, width: 220 }}
          >
            Превью
          </th>
        )}
      </tr>
    </thead>
  );

  function renderTable(items: EngineListItem[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.map((e) => (
              <tr key={e.id} style={{ background: e.isScrap ? 'rgba(239, 68, 68, 0.18)' : undefined }}>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(e.id);
                  }}
                >
                  {e.engineNumber ?? '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(e.id);
                  }}
                >
                  {e.engineBrand ?? '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(e.id);
                  }}
                >
                  {e.customerName ?? '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(e.id);
                  }}
                >
                  {toDateLabel(e.arrivalDate) || '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(e.id);
                  }}
                >
                  {toDateLabel(e.shippingDate) || '-'}
                </td>
                {showPreviews && (
                  <td
                    style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer', textAlign: 'right' }}
                    onClick={() => {
                      void props.onOpen(e.id);
                    }}
                  >
                    <ListRowThumbs files={(e as EngineRow).attachmentPreviews ?? []} />
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={showPreviews ? 6 : 5}>
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
        {props.canCreate && <Button onClick={props.onCreate}>Добавить двигатель</Button>}
        <div style={{ flex: 1 }}>
          <Input
            value={query}
            onChange={(e) => patchState({ query: e.target.value, page: 0 })}
            placeholder="Поиск по всем данным двигателя…"
          />
        </div>
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          По дате привоза:
        </span>
        <div style={{ width: 170 }}>
          <Input
            type="date"
            value={contractDateFrom}
            onChange={(e) => patchState({ contractDateFrom: e.target.value, page: 0 })}
            title="Дата прихода двигателя: с"
          />
        </div>
        <div style={{ width: 170 }}>
          <Input
            type="date"
            value={contractDateTo}
            onChange={(e) => patchState({ contractDateTo: e.target.value, page: 0 })}
            title="Дата прихода двигателя: по"
          />
        </div>
        <Button
          variant="ghost"
          onClick={() => patchState({ contractDateFrom: '', contractDateTo: '', page: 0 })}
          disabled={!contractDateFrom && !contractDateTo}
        >
          Сбросить даты
        </Button>
        <Button variant="ghost" onClick={() => patchState({ showPreviews: !showPreviews })}>
          {showPreviews ? 'Отключить превью' : 'Включить превью'}
        </Button>
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
      </div>

      <div
        ref={containerRef}
        style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}
        onScroll={onScroll}
      >
        <TwoColumnList
          items={paged}
          enabled={twoCol}
          renderColumn={(items) => renderTable(items)}
        />
      </div>

      {totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: '8px 0 4px',
            flex: '0 0 auto',
            fontSize: 13,
            color: '#4b5563',
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={safePage === 0}
            onClick={() => patchState({ page: 0 })}
          >
            &laquo;
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={safePage === 0}
            onClick={() => patchState({ page: Math.max(0, safePage - 1) })}
          >
            &lsaquo; Назад
          </Button>
          <span>
            {safePage + 1} / {totalPages}
            <span style={{ marginLeft: 8, color: '#9ca3af' }}>
              ({totalFiltered} всего)
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={safePage >= totalPages - 1}
            onClick={() => patchState({ page: Math.min(totalPages - 1, safePage + 1) })}
          >
            Вперёд &rsaquo;
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={safePage >= totalPages - 1}
            onClick={() => patchState({ page: totalPages - 1 })}
          >
            &raquo;
          </Button>
        </div>
      )}
    </div>
  );
}
