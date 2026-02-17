import React, { useMemo } from 'react';

import type { EngineListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useListUiState, usePersistedScrollTop } from '../hooks/useListBehavior.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';

export type EnginesPageUiState = {
  query: string;
  showReport: boolean;
  periodFrom: string;
  periodTo: string;
  arrivalFrom: string;
  arrivalTo: string;
  shippingFrom: string;
  shippingTo: string;
  contractIds: string[];
  brandIds: string[];
  scrapFilter: 'all' | 'yes' | 'no';
  onSiteFilter: 'all' | 'yes' | 'no';
  sortKey: 'engineNumber' | 'engineBrand' | 'customerName' | 'arrivalDate' | 'shippingDate';
  sortDir: 'asc' | 'desc';
};

export function createDefaultEnginesPageUiState(): EnginesPageUiState {
  return {
    query: '',
    showReport: false,
    periodFrom: '',
    periodTo: '',
    arrivalFrom: '',
    arrivalTo: '',
    shippingFrom: '',
    shippingTo: '',
    contractIds: [],
    brandIds: [],
    scrapFilter: 'all',
    onSiteFilter: 'all',
    sortKey: 'arrivalDate',
    sortDir: 'desc',
  };
}

function toDateLabel(ms?: number | null) {
  if (!ms) return '';
  const dt = new Date(ms);
  return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('ru-RU');
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function inDateRange(ms: number | null | undefined, from: string, to: string) {
  if (!from && !to) return true;
  if (!ms) return false;
  const fromMs = fromInputDate(from);
  const toMs = fromInputDate(to);
  if (fromMs != null && ms < fromMs) return false;
  if (toMs != null && ms > toMs + 24 * 60 * 60 * 1000 - 1) return false;
  return true;
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
  const showReport = listState.showReport;
  const periodFrom = listState.periodFrom;
  const periodTo = listState.periodTo;
  const arrivalFrom = listState.arrivalFrom;
  const arrivalTo = listState.arrivalTo;
  const shippingFrom = listState.shippingFrom;
  const shippingTo = listState.shippingTo;
  const contractIds = listState.contractIds;
  const brandIds = listState.brandIds;
  const scrapFilter = listState.scrapFilter;
  const onSiteFilter = listState.onSiteFilter;
  const sortKey = listState.sortKey;
  const sortDir = listState.sortDir;
  const width = useWindowWidth();
  const twoCol = width >= 1400;

  const contractOptions = useMemo(() => {
    const map = new Map<string, string>();
    props.engines.forEach((e) => {
      if (!e.contractId) return;
      map.set(e.contractId, e.contractName || e.contractId);
    });
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [props.engines]);

  const brandOptions = useMemo(() => {
    const map = new Map<string, string>();
    props.engines.forEach((e) => {
      const key = e.engineBrandId || e.engineBrand || '';
      if (!key) return;
      map.set(key, e.engineBrand || key);
    });
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [props.engines]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.engines.filter((e) => {
      const n = (e.engineNumber ?? '').toLowerCase();
      const b = (e.engineBrand ?? '').toLowerCase();
      const c = (e.customerName ?? '').toLowerCase();
      const matchesQuery = !q || n.includes(q) || b.includes(q) || c.includes(q);
      if (!matchesQuery) return false;

      const createdAt = e.createdAt ?? e.updatedAt;
      if (!inDateRange(createdAt, periodFrom, periodTo)) return false;
      if (!inDateRange(e.arrivalDate ?? null, arrivalFrom, arrivalTo)) return false;
      if (!inDateRange(e.shippingDate ?? null, shippingFrom, shippingTo)) return false;

      if (contractIds.length > 0 && (!e.contractId || !contractIds.includes(e.contractId))) return false;
      const brandKey = e.engineBrandId || e.engineBrand || '';
      if (brandIds.length > 0 && (!brandKey || !brandIds.includes(brandKey))) return false;

      if (scrapFilter === 'yes' && !e.isScrap) return false;
      if (scrapFilter === 'no' && e.isScrap) return false;

      const onSite = e.shippingDate == null;
      if (onSiteFilter === 'yes' && !onSite) return false;
      if (onSiteFilter === 'no' && onSite) return false;

      return true;
    });
  }, [
    props.engines,
    query,
    periodFrom,
    periodTo,
    arrivalFrom,
    arrivalTo,
    shippingFrom,
    shippingTo,
    contractIds,
    brandIds,
    scrapFilter,
    onSiteFilter,
  ]);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) {
      patchState({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' });
      return;
    }
    patchState({ sortKey: key, sortDir: 'asc' });
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
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={5}>
                  Ничего не найдено
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  function buildReportHtml(items: EngineListItem[]) {
    const rows = items
      .map((e) => {
        const cells = [
          escapeHtml(e.engineNumber ?? ''),
          escapeHtml(e.engineBrand ?? ''),
          escapeHtml(e.customerName ?? ''),
          escapeHtml(toDateLabel(e.arrivalDate) || ''),
          escapeHtml(toDateLabel(e.shippingDate) || ''),
          escapeHtml(e.isScrap ? 'Да' : 'Нет'),
        ]
          .map((cell) => `<td>${cell || '—'}</td>`)
          .join('');
        const rowStyle = e.isScrap ? ' style="background:#fee2e2;"' : '';
        return `<tr${rowStyle}>${cells}</tr>`;
      })
      .join('');
    return `<table><thead><tr>
<th>Номер</th><th>Марка</th><th>Контрагент</th><th>Дата прихода</th><th>Дата отгрузки</th><th>Утиль</th>
</tr></thead><tbody>${rows || '<tr><td colspan="6">Нет данных</td></tr>'}</tbody></table>`;
  }

  function openReport(kind: 'print' | 'pdf') {
    const labels: string[] = [];
    if (periodFrom || periodTo) labels.push(`Период: ${periodFrom || '—'}..${periodTo || '—'}`);
    if (arrivalFrom || arrivalTo) labels.push(`Приход: ${arrivalFrom || '—'}..${arrivalTo || '—'}`);
    if (shippingFrom || shippingTo) labels.push(`Отгрузка: ${shippingFrom || '—'}..${shippingTo || '—'}`);
    if (contractIds.length > 0) {
      const contractLabel = contractIds
        .map((id) => contractOptions.find((o) => o.id === id)?.label ?? id)
        .join(', ');
      labels.push(`Контракты: ${contractLabel}`);
    }
    if (brandIds.length > 0) {
      const brandLabel = brandIds.map((id) => brandOptions.find((o) => o.id === id)?.label ?? id).join(', ');
      labels.push(`Марки: ${brandLabel}`);
    }
    if (scrapFilter !== 'all') labels.push(`Утиль: ${scrapFilter === 'yes' ? 'да' : 'нет'}`);
    if (onSiteFilter !== 'all') labels.push(`На заводе: ${onSiteFilter === 'yes' ? 'да' : 'нет'}`);

    openPrintPreview({
      title: kind === 'pdf' ? 'Отчет по двигателям (PDF)' : 'Отчет по двигателям',
      subtitle: labels.length ? labels.join(' · ') : 'Без фильтров',
      sections: [
        {
          id: 'list',
          title: 'Список двигателей',
          html: buildReportHtml(filtered),
        },
      ],
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
        {props.canCreate && <Button onClick={props.onCreate}>Добавить двигатель</Button>}
        <Button variant="ghost" onClick={() => patchState({ showReport: !showReport })}>
          Отчет
        </Button>
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по номеру или марке…" />
        </div>
      </div>

      {showReport && (
        <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 220px) 1fr', gap: 10, alignItems: 'center' }}>
            <div style={{ color: '#6b7280' }}>Период (создание)</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
              <Input type="date" value={periodFrom} onChange={(e) => patchState({ periodFrom: e.target.value })} />
              <Input type="date" value={periodTo} onChange={(e) => patchState({ periodTo: e.target.value })} />
            </div>

            <div style={{ color: '#6b7280' }}>Контракты</div>
            <MultiSearchSelect values={contractIds} options={contractOptions} placeholder="Все" onChange={(next) => patchState({ contractIds: next })} />

            <div style={{ color: '#6b7280' }}>Марки двигателя</div>
            <MultiSearchSelect values={brandIds} options={brandOptions} placeholder="Все" onChange={(next) => patchState({ brandIds: next })} />

            <div style={{ color: '#6b7280' }}>Дата прихода</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
              <Input type="date" value={arrivalFrom} onChange={(e) => patchState({ arrivalFrom: e.target.value })} />
              <Input type="date" value={arrivalTo} onChange={(e) => patchState({ arrivalTo: e.target.value })} />
            </div>

            <div style={{ color: '#6b7280' }}>Дата отгрузки</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
              <Input type="date" value={shippingFrom} onChange={(e) => patchState({ shippingFrom: e.target.value })} />
              <Input type="date" value={shippingTo} onChange={(e) => patchState({ shippingTo: e.target.value })} />
            </div>

            <div style={{ color: '#6b7280' }}>Утиль</div>
            <select
              value={scrapFilter}
              onChange={(e) => patchState({ scrapFilter: e.target.value as 'all' | 'yes' | 'no' })}
              style={{ padding: '7px 10px', borderRadius: 10, border: '1px solid var(--input-border)' }}
            >
              <option value="all">Все</option>
              <option value="yes">Только утиль</option>
              <option value="no">Только не утиль</option>
            </select>

            <div style={{ color: '#6b7280' }}>Наличие на заводе</div>
            <select
              value={onSiteFilter}
              onChange={(e) => patchState({ onSiteFilter: e.target.value as 'all' | 'yes' | 'no' })}
              style={{ padding: '7px 10px', borderRadius: 10, border: '1px solid var(--input-border)' }}
            >
              <option value="all">Все</option>
              <option value="yes">На заводе</option>
              <option value="no">Отгруженные</option>
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button variant="ghost" onClick={() => openReport('print')}>
              Печать
            </Button>
            <Button variant="ghost" onClick={() => openReport('pdf')}>
              PDF
            </Button>
            <div style={{ flex: 1 }} />
            <Button
              variant="ghost"
              onClick={() => {
                patchState({
                  periodFrom: '',
                  periodTo: '',
                  arrivalFrom: '',
                  arrivalTo: '',
                  shippingFrom: '',
                  shippingTo: '',
                  contractIds: [],
                  brandIds: [],
                  scrapFilter: 'all',
                  onSiteFilter: 'all',
                });
              }}
            >
              Сбросить фильтры
            </Button>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}
        onScroll={onScroll}
      >
        <TwoColumnList
          items={sorted}
          enabled={twoCol}
          renderColumn={(items) => renderTable(items)}
        />
      </div>
    </div>
  );
}


