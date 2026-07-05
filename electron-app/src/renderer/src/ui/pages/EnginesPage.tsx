import React, { useMemo } from 'react';

import { classifyEngineContractBinding, findArchivedArrivalIds } from '@matricarmz/shared';
import type { EngineListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { Input } from '../components/Input.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { useListDeepFilter } from '../hooks/useListDeepFilter.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { listHeaderKindProps, listCellKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';
import { useListUiState, usePersistedScrollTop } from '../hooks/useListBehavior.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { formatMoscowDate } from '../utils/dateUtils.js';


type EngineRow = EngineListItem & {
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
};

// Колонка «Привязка» (вынесена из номера двигателя): 🟢 договор · 🟢🟢 ДС · 🔴 не привязан.
// ДС подразумевает договор → два зелёных. Бесхозный двигатель = красный (надо привязать).
const BINDING_GREEN = '#16a34a';
const BINDING_RED = '#dc2626';
// Синяя точка «рекламационный» — рядом с точками привязки (план reclamation-mvp-2026-07 Ф1).
const RECLAMATION_BLUE = '#2563eb';

function bindingDot(color: string): React.ReactNode {
  return (
    <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color, flex: '0 0 auto' }} />
  );
}

// Ранг для сортировки по привязке: договор → ДС → не привязан.
function bindingRank(e: EngineListItem): number {
  switch (classifyEngineContractBinding(e)) {
    case 'contract':
      return 0;
    case 'addon':
      return 1;
    default:
      return 2;
  }
}

function renderBindingCell(e: EngineListItem): React.ReactNode {
  const status = classifyEngineContractBinding(e);
  // Точки привязки — первыми, синяя рекламационная — добавляется в конец
  // (не меняет семантику bindingRank).
  const recl = e.isReclamation ? bindingDot(RECLAMATION_BLUE) : null;
  const wrap = (dots: React.ReactNode, label: string, title: string) => (
    <span
      title={e.isReclamation ? `${title} · Рекламация` : title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        {dots}
        {recl}
      </span>
      <span>{label}</span>
    </span>
  );
  if (status === 'none') {
    return wrap(bindingDot(BINDING_RED), 'Не привязан', 'Двигатель не привязан к контракту');
  }
  const contractTitle = e.contractName ? `Договор: ${e.contractName}` : 'Привязан к договору';
  if (status === 'contract') {
    return wrap(bindingDot(BINDING_GREEN), 'Договор', contractTitle);
  }
  const section = String(e.contractSectionNumber ?? 'ДС').trim() || 'ДС';
  return wrap(
    <>
      {bindingDot(BINDING_GREEN)}
      {bindingDot(BINDING_GREEN)}
    </>,
    section,
    `${contractTitle} · ${section}`,
  );
}

export type EnginesPageUiState = {
  query: string;
  sortKey: 'engineNumber' | 'engineBrand' | 'customerName' | 'binding' | 'arrivalDate' | 'shippingDate';
  sortDir: 'asc' | 'desc';
  page: number;
  showPreviews: boolean;
  contractDateFrom: string;
  contractDateTo: string;
  onlyReclamation?: boolean;
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

type DedupeEngine = { id: string; engineNumber: string; engineBrand: string; createdAt: number; opsCount: number };
type DedupeGroup = { kind: 'exact' | 'similar'; engines: DedupeEngine[] };

// "Поиск дублей двигателей" — full server-side scan of duplicate groups (exact by
// canonical number + near-miss similar) with operator-chosen survivor merge. Mirrors the
// warehouse nomenclature dedupe. Exact groups are also auto-merged by the periodic job;
// this surfaces the similar groups it can't safely touch and allows immediate manual merge.
function EngineDedupeModal(props: { onClose: () => void; onOpenEngine: (id: string) => void; onAfterMerge: () => void }) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [groups, setGroups] = React.useState<DedupeGroup[]>([]);
  const [total, setTotal] = React.useState(0);
  const [survivorByGroup, setSurvivorByGroup] = React.useState<Record<number, string>>({});
  const [losersByGroup, setLosersByGroup] = React.useState<Record<number, Record<string, boolean>>>({});
  const [busyGroup, setBusyGroup] = React.useState<number | null>(null);
  const [status, setStatus] = React.useState('');

  const analyze = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus('');
    const r = await window.matrica.engines.dedupeAnalyze();
    if (!r.ok) {
      setError(r.error);
      setGroups([]);
      setLoading(false);
      return;
    }
    setTotal(r.totalEngines);
    setGroups(r.groups);
    const surv: Record<number, string> = {};
    const los: Record<number, Record<string, boolean>> = {};
    r.groups.forEach((g, i) => {
      surv[i] = g.engines[0]?.id ?? '';
      los[i] = {};
      g.engines.slice(1).forEach((e) => (los[i]![e.id] = true));
    });
    setSurvivorByGroup(surv);
    setLosersByGroup(los);
    setLoading(false);
  }, []);
  React.useEffect(() => {
    void analyze();
  }, [analyze]);

  const setSurvivor = (gi: number, id: string) => {
    setSurvivorByGroup((p) => ({ ...p, [gi]: id }));
    setLosersByGroup((p) => ({ ...p, [gi]: { ...(p[gi] ?? {}), [id]: false } }));
  };
  const toggleLoser = (gi: number, id: string) =>
    setLosersByGroup((p) => ({ ...p, [gi]: { ...(p[gi] ?? {}), [id]: !p[gi]?.[id] } }));

  const doMerge = async (gi: number, group: DedupeGroup) => {
    const survivorId = survivorByGroup[gi];
    const loserIds = group.engines.map((e) => e.id).filter((id) => id !== survivorId && losersByGroup[gi]?.[id]);
    if (!survivorId || loserIds.length === 0) {
      setStatus('Выберите основной двигатель и хотя бы один дубль для склейки.');
      return;
    }
    const survNum = group.engines.find((e) => e.id === survivorId)?.engineNumber ?? survivorId;
    if (
      !window.confirm(
        `Склеить ${loserIds.length} дубл(я/ей) в «${survNum}»?\n\nДубли будут помечены удалёнными, все их акты/операции перевешены на основной двигатель. Действие необратимо.`,
      )
    )
      return;
    setBusyGroup(gi);
    setStatus('');
    const r = await window.matrica.engines.dedupeMerge({ survivorId, loserIds });
    setBusyGroup(null);
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    const ops = r.report.merged.reduce((s, m) => s + m.opsRepointed, 0);
    setStatus(`Готово: склеено ${r.report.merged.length}, актов перевешено ${ops}.`);
    props.onAfterMerge();
    void analyze();
  };

  return (
    <div
      onClick={props.onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24, overflow: 'auto' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--card-bg, #fff)', color: 'var(--text)', borderRadius: 12, width: 'min(900px, 96vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid rgba(15,23,42,0.12)' }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Поиск дублей двигателей</div>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => void analyze()} disabled={loading}>
            Обновить
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Закрыть
          </Button>
        </div>
        <div style={{ padding: 16, overflow: 'auto' }}>
          {loading ? <div style={{ color: '#6b7280' }}>Сканирую двигатели…</div> : null}
          {error ? <div style={{ color: '#dc2626' }}>Ошибка: {error}</div> : null}
          {status ? <div style={{ marginBottom: 10, color: '#2563eb' }}>{status}</div> : null}
          {!loading && !error && groups.length === 0 ? (
            <div style={{ color: '#16a34a' }}>Дублей не найдено (просканировано {total} двигателей). Точные дубли склеиваются автоматически.</div>
          ) : null}
          {groups.map((g, gi) => (
            <div key={gi} style={{ border: '1px solid rgba(15,23,42,0.14)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span
                  style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: g.kind === 'exact' ? '#fee2e2' : '#fef3c7', color: g.kind === 'exact' ? '#b91c1c' : '#92400e' }}
                >
                  {g.kind === 'exact' ? 'Точные дубли' : 'Похожие'}
                </span>
                <span style={{ color: '#6b7280', fontSize: 12 }}>{g.engines.length} двигател(я/ей)</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {g.engines.map((e) => {
                  const isSurvivor = survivorByGroup[gi] === e.id;
                  return (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px', borderRadius: 6, background: isSurvivor ? 'rgba(37,99,235,0.08)' : 'transparent' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12 }} title="Оставить как основной">
                        <input type="radio" name={`surv-${gi}`} checked={isSurvivor} onChange={() => setSurvivor(gi, e.id)} /> основной
                      </label>
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: isSurvivor ? 'not-allowed' : 'pointer', fontSize: 12, opacity: isSurvivor ? 0.4 : 1 }}
                        title="Склеить в основной"
                      >
                        <input type="checkbox" disabled={isSurvivor} checked={!isSurvivor && !!losersByGroup[gi]?.[e.id]} onChange={() => toggleLoser(gi, e.id)} /> склеить
                      </label>
                      <span style={{ fontWeight: 600 }}>{e.engineNumber || '(без номера)'}</span>
                      {e.engineBrand ? <span style={{ color: '#6b7280' }}>{e.engineBrand}</span> : null}
                      <span style={{ color: '#9ca3af', fontSize: 12 }}>
                        актов: {e.opsCount}
                        {e.createdAt ? ` · ${formatMoscowDate(e.createdAt)}` : ''}
                      </span>
                      <div style={{ flex: 1 }} />
                      <button type="button" onClick={() => props.onOpenEngine(e.id)} style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>
                        Открыть
                      </button>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                <Button onClick={() => void doMerge(gi, g)} disabled={busyGroup === gi}>
                  {busyGroup === gi ? 'Склейка…' : 'Объединить выбранные'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function EnginesPage(props: {
  engines: EngineListItem[];
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onCreate: () => Promise<void>;
  canCreate: boolean;
}) {
  const [dedupeOpen, setDedupeOpen] = React.useState(false);
  const { state: listState, patchState } = useListUiState<EnginesPageUiState>('list:engines', createDefaultEnginesPageUiState());
  const { containerRef, onScroll } = usePersistedScrollTop('list:engines');
  const query = listState.query;
  const sortKey = listState.sortKey;
  const sortDir = listState.sortDir;
  const showPreviews = listState.showPreviews !== false;
  const contractDateFrom = String(listState.contractDateFrom ?? '');
  const contractDateTo = String(listState.contractDateTo ?? '');
  const onlyReclamation = listState.onlyReclamation === true;
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;

  // Ф2 (повторный заезд): старые заезды того же номера помечаются «архивный заезд».
  const archivedArrivalIds = useMemo(() => findArchivedArrivalIds(props.engines), [props.engines]);

  // Верхний поиск: tier-1 по полям строки + tier-2 внутрь карточек (EAV).
  const getRowId = React.useCallback((e: EngineListItem) => String(e.id), []);
  const getRowLabel = React.useCallback((e: EngineListItem) => String(e.engineNumber ?? ''), []);
  const deepFilter = useListDeepFilter(props.engines, getRowId, getRowLabel, query);
  const similarMode = deepFilter.similarMode;
  const filtered = useMemo(() => {
    const fromMs = fromInputDate(contractDateFrom);
    const toMs = endOfInputDate(contractDateTo);
    const hasDateFilter = fromMs != null || toMs != null;
    return deepFilter.filtered.filter((engine) => {
      if (onlyReclamation && engine.isReclamation !== true) return false;
      if (!hasDateFilter) return true;
      const arrivalDate = typeof engine.arrivalDate === 'number' && Number.isFinite(engine.arrivalDate) ? engine.arrivalDate : null;
      if (arrivalDate == null) return false;
      if (fromMs != null && arrivalDate < fromMs) return false;
      if (toMs != null && arrivalDate > toMs) return false;
      return true;
    });
  }, [deepFilter.filtered, contractDateFrom, contractDateTo, onlyReclamation]);

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
    // While a text query is active, results already arrive in relevance order
    // (exact → prefix → substring → … from the tiered matcher) — keep the most
    // relevant rows at the top instead of overriding with the column sort. The
    // column sort applies only when browsing without a query.
    if (String(query ?? '').trim()) return filtered;
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
        case 'binding': {
          const r = (bindingRank(a) - bindingRank(b)) * dir;
          return r !== 0 ? r : String(a.engineNumber ?? '').localeCompare(String(b.engineNumber ?? ''), 'ru');
        }
        case 'arrivalDate':
          return byDate(a.arrivalDate ?? null, b.arrivalDate ?? null);
        case 'shippingDate':
          return byDate(a.shippingDate ?? null, b.shippingDate ?? null);
        default:
          return 0;
      }
    });
    return items;
  }, [filtered, sortDir, sortKey, query]);

  const displayRows = sorted;

  type EngineColumn = ColumnDescriptor & {
    sortable: boolean;
    sortKey?: typeof sortKey;
    headerAlign?: 'left' | 'right';
    cellAlign?: 'left' | 'right';
    width?: number;
    kind?: ListColumnKind;
    requireShowPreviews?: boolean;
    render: (e: EngineListItem) => React.ReactNode;
  };

  const allColumns = useMemo<EngineColumn[]>(
    () => [
      {
        id: 'engineNumber',
        label: 'Номер',
        sortable: true,
        sortKey: 'engineNumber',
        kind: 'name',
        render: (e) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>{e.engineNumber ?? '-'}</span>
            {archivedArrivalIds.has(e.id) ? (
              <span
                title="Есть более свежий заезд с этим номером"
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 8,
                  background: 'rgba(107, 114, 128, 0.15)',
                  color: '#4b5563',
                  whiteSpace: 'nowrap',
                }}
              >
                архивный заезд
              </span>
            ) : null}
            {e.isRepeatArrival && !archivedArrivalIds.has(e.id) ? (
              <span
                title="Повторный заезд: новый ремонт двигателя с тем же номером"
                style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(37, 99, 235, 0.12)', color: '#1d4ed8', whiteSpace: 'nowrap' }}
              >
                🔁
              </span>
            ) : null}
          </span>
        ),
      },
      { id: 'engineBrand', label: 'Марка', sortable: true, sortKey: 'engineBrand', kind: 'name', render: (e) => e.engineBrand ?? '-' },
      { id: 'customerName', label: 'Контрагент', sortable: true, sortKey: 'customerName', kind: 'name', render: (e) => e.customerName ?? '-' },
      {
        id: 'binding',
        label: 'Привязка',
        sortable: true,
        sortKey: 'binding',
        kind: 'name',
        render: (e) => renderBindingCell(e),
      },
      { id: 'arrivalDate', label: 'Дата прихода', sortable: true, sortKey: 'arrivalDate', kind: 'date', render: (e) => toDateLabel(e.arrivalDate) || '-' },
      { id: 'shippingDate', label: 'Дата отгрузки', sortable: true, sortKey: 'shippingDate', kind: 'date', render: (e) => toDateLabel(e.shippingDate) || '-' },
      {
        id: 'previews',
        label: 'Превью',
        sortable: false,
        headerAlign: 'right',
        cellAlign: 'right',
        kind: 'thumbs',
        requireShowPreviews: true,
        render: (e) => <ListRowThumbs files={(e as EngineRow).attachmentPreviews ?? []} />,
      },
    ],
    [archivedArrivalIds],
  );
  const allColumnIds = useMemo(() => allColumns.map((c) => c.id), [allColumns]);
  const columnsById = useMemo(() => new Map(allColumns.map((c) => [c.id, c])), [allColumns]);
  const columnLayout = useColumnLayout('list:engines:columns', allColumnIds);
  const visibleColumns = useMemo(
    () =>
      columnLayout.order
        .map((id) => columnsById.get(id))
        .filter((col): col is EngineColumn => Boolean(col))
        .filter((col) => columnLayout.isVisible(col.id))
        .filter((col) => !col.requireShowPreviews || showPreviews),
    [columnLayout.order, columnLayout.hidden, columnsById, showPreviews],
  );
  const columnDescriptors = useMemo<ColumnDescriptor[]>(() => allColumns.map((c) => ({ id: c.id, label: c.label })), [allColumns]);

  const openEngine = (id: string) => {
    void props.onOpen(id);
  };

  function renderTableHeader() {
    return (
      <thead>
        <tr style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 120%)', color: '#fff' }}>
          {visibleColumns.map((col) => (
            <th
              key={col.id}
              {...listHeaderKindProps(col.kind, col.label)}
              style={{
                textAlign: col.headerAlign ?? 'left',
                borderBottom: '1px solid rgba(255,255,255,0.25)',
                padding: 8,
                position: 'sticky',
                top: 0,
                zIndex: 2,
                cursor: col.sortable ? 'pointer' : 'default',
                ...(col.width ? { width: col.width } : {}),
              }}
              onClick={col.sortable && col.sortKey ? () => toggleSort(col.sortKey as typeof sortKey) : undefined}
            >
              {col.label}
              {col.sortable && col.sortKey && sortArrow(col.sortKey as typeof sortKey) ? ` ${sortArrow(col.sortKey as typeof sortKey)}` : ''}
            </th>
          ))}
          <th className="list-col-filler" aria-hidden="true" />
        </tr>
      </thead>
    );
  }

  function renderEngineCells(e: EngineListItem) {
    return (
      <>
        {visibleColumns.map((col) => (
          <td key={col.id} {...listCellKindProps(col.kind)} style={{ borderBottom: '1px solid #f3f4f6', padding: 8, textAlign: col.cellAlign ?? 'left' }}>
            {col.render(e)}
          </td>
        ))}
        <td className="list-col-filler" aria-hidden="true" style={{ borderBottom: '1px solid #f3f4f6' }} />
      </>
    );
  }

  function engineRowProps(e: EngineListItem): VirtualTableRowProps {
    return {
      onClick: () => openEngine(e.id),
      style: { cursor: 'pointer', ...(e.isScrap ? { background: 'rgba(239, 68, 68, 0.18)' } : {}) },
    };
  }

  function renderTable(items: EngineListItem[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'clip' }}>
        <table className="list-table">
          {renderTableHeader()}
          <tbody>
            {items.map((e) => (
              <tr key={e.id} {...engineRowProps(e)}>
                {renderEngineCells(e)}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={Math.max(1, visibleColumns.length) + 1}>
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
            placeholder="Поиск по всем данным двигателя (и внутри карточек)…"
          />
        </div>
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {query.trim() ? `${displayRows.length} из ${props.engines.length}` : `${props.engines.length}`}
        </span>
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
        <Button
          variant="ghost"
          onClick={() => patchState({ onlyReclamation: !onlyReclamation, page: 0 })}
          title="Показать только двигатели, принятые по рекламации"
          style={onlyReclamation ? { background: 'rgba(37, 99, 235, 0.15)' } : undefined}
        >
          Рекламационные
        </Button>
        <Button variant="ghost" onClick={() => patchState({ showPreviews: !showPreviews })}>
          {showPreviews ? 'Отключить превью' : 'Включить превью'}
        </Button>
        <Button variant="ghost" onClick={() => setDedupeOpen(true)} title="Найти и склеить дубли двигателей">
          Поиск дублей
        </Button>
        <ColumnSettingsButton
          columns={columnDescriptors}
          order={columnLayout.order}
          isVisible={columnLayout.isVisible}
          onToggleVisible={columnLayout.setVisible}
          onMove={columnLayout.moveColumn}
          onReset={columnLayout.resetToDefault}
        />
      </div>

      {similarMode && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 10px',
            borderRadius: 8,
            background: 'rgba(245, 158, 11, 0.15)',
            color: '#92400e',
            fontSize: 13,
            flex: '0 0 auto',
          }}
        >
          Точных совпадений нет — показаны похожие.
        </div>
      )}

      <div
        ref={containerRef}
        style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}
        onScroll={onScroll}
      >
        {twoCol ? (
          <TwoColumnList items={displayRows} enabled renderColumn={(items) => renderTable(items)} />
        ) : (
          <VirtualTable
            scrollElementRef={containerRef}
            count={displayRows.length}
            header={renderTableHeader()}
            renderCells={(i) => renderEngineCells(displayRows[i]!)}
            getRowKey={(i) => String(displayRows[i]!.id)}
            getRowProps={(i) => engineRowProps(displayRows[i]!)}
            colCount={Math.max(1, visibleColumns.length) + 1}
            estimateSize={showPreviews ? 64 : 40}
            emptyState="Ничего не найдено"
          />
        )}
      </div>

      {dedupeOpen && (
        <EngineDedupeModal
          onClose={() => setDedupeOpen(false)}
          onOpenEngine={(id) => {
            setDedupeOpen(false);
            openEngine(id);
          }}
          onAfterMerge={() => void props.onRefresh()}
        />
      )}
    </div>
  );
}
