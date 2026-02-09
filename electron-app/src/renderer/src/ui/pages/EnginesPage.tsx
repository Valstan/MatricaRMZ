import React, { useMemo, useState } from 'react';

import type { EngineListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';

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
  canDelete: boolean;
}) {
  const [query, setQuery] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');
  const [arrivalFrom, setArrivalFrom] = useState('');
  const [arrivalTo, setArrivalTo] = useState('');
  const [shippingFrom, setShippingFrom] = useState('');
  const [shippingTo, setShippingTo] = useState('');
  const [contractIds, setContractIds] = useState<string[]>([]);
  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [scrapFilter, setScrapFilter] = useState<'all' | 'yes' | 'no'>('all');
  const [onSiteFilter, setOnSiteFilter] = useState<'all' | 'yes' | 'no'>('all');
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

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 120%)', color: '#fff' }}>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Номер</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Марка</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Контрагент</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Дата прихода</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Дата отгрузки</th>
        {props.canDelete && (
          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, width: 100 }}>Действия</th>
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
                {props.canDelete && (
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8, width: 100 }} onClick={(ev) => ev.stopPropagation()}>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm('Удалить двигатель?')) return;
                        const r = await window.matrica.engines.delete(e.id);
                        if (!r.ok) {
                          alert(`Ошибка удаления: ${r.error}`);
                          return;
                        }
                        void props.onRefresh();
                      }}
                      style={{ color: '#b91c1c' }}
                    >
                      Удалить
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={props.canDelete ? 6 : 5}>
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
        <Button variant="ghost" onClick={() => setShowReport((v) => !v)}>
          Отчет
        </Button>
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по номеру или марке…" />
        </div>
      </div>

      {showReport && (
        <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 220px) 1fr', gap: 10, alignItems: 'center' }}>
            <div style={{ color: '#6b7280' }}>Период (создание)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} />
              <Input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
            </div>

            <div style={{ color: '#6b7280' }}>Контракты</div>
            <MultiSearchSelect values={contractIds} options={contractOptions} placeholder="Все" onChange={setContractIds} />

            <div style={{ color: '#6b7280' }}>Марки двигателя</div>
            <MultiSearchSelect values={brandIds} options={brandOptions} placeholder="Все" onChange={setBrandIds} />

            <div style={{ color: '#6b7280' }}>Дата прихода</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Input type="date" value={arrivalFrom} onChange={(e) => setArrivalFrom(e.target.value)} />
              <Input type="date" value={arrivalTo} onChange={(e) => setArrivalTo(e.target.value)} />
            </div>

            <div style={{ color: '#6b7280' }}>Дата отгрузки</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Input type="date" value={shippingFrom} onChange={(e) => setShippingFrom(e.target.value)} />
              <Input type="date" value={shippingTo} onChange={(e) => setShippingTo(e.target.value)} />
            </div>

            <div style={{ color: '#6b7280' }}>Утиль</div>
            <select
              value={scrapFilter}
              onChange={(e) => setScrapFilter(e.target.value as 'all' | 'yes' | 'no')}
              style={{ padding: '7px 10px', borderRadius: 10, border: '1px solid var(--input-border)' }}
            >
              <option value="all">Все</option>
              <option value="yes">Только утиль</option>
              <option value="no">Только не утиль</option>
            </select>

            <div style={{ color: '#6b7280' }}>Наличие на заводе</div>
            <select
              value={onSiteFilter}
              onChange={(e) => setOnSiteFilter(e.target.value as 'all' | 'yes' | 'no')}
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
                setPeriodFrom('');
                setPeriodTo('');
                setArrivalFrom('');
                setArrivalTo('');
                setShippingFrom('');
                setShippingTo('');
                setContractIds([]);
                setBrandIds([]);
                setScrapFilter('all');
                setOnSiteFilter('all');
              }}
            >
              Сбросить фильтры
            </Button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList
          items={filtered}
          enabled={twoCol}
          renderColumn={(items) => renderTable(items)}
        />
      </div>
    </div>
  );
}


