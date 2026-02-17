import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { SuggestInput } from '../components/SuggestInput.js';
import { SectionCard } from '../components/SectionCard.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

type Row = {
  id: string;
  toolNumber?: string;
  name?: string;
  serialNumber?: string;
  departmentName?: string | null;
  retiredAt?: number | null;
  updatedAt: number;
};
type SortKey = 'toolNumber' | 'name' | 'serialNumber' | 'departmentName' | 'retired' | 'updatedAt';

type ReportRow = {
  toolId: string;
  toolNumber?: string;
  name?: string;
  serialNumber?: string;
  departmentName?: string | null;
  lastMovementAt?: number | null;
  location: 'store' | 'in_use' | 'unknown';
};

type ReportTotals = { total: number; store: number; inUse: number; unknown: number };

export function ToolsPage(props: {
  onOpen: (id: string) => Promise<void>;
  onOpenProperties: () => void;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const { state: listState, patchState } = useListUiState('list:tools', {
    query: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:tools');
  const query = String(listState.query ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [reportOpen, setReportOpen] = useState(false);
  const [reportStatus, setReportStatus] = useState<string>('');
  const [reportRows, setReportRows] = useState<ReportRow[]>([]);
  const [reportTotals, setReportTotals] = useState<ReportTotals | null>(null);
  const [reportFrom, setReportFrom] = useState<string>('');
  const [reportTo, setReportTo] = useState<string>('');
  const [reportName, setReportName] = useState<string>('');
  const [reportPropertyId, setReportPropertyId] = useState<string>('');
  const [reportPropertyValue, setReportPropertyValue] = useState<string>('');
  const [reportLocation, setReportLocation] = useState<'all' | 'store' | 'in_use' | 'unknown'>('all');
  const [propertyOptions, setPropertyOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [reportPropertyValueHints, setReportPropertyValueHints] = useState<string[]>([]);
  const width = useWindowWidth();
  const twoCol = width >= 1400;
  const queryTimer = useRef<number | null>(null);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const r = await window.matrica.tools.list({ q: query.trim() || undefined });
      if (!r.ok) {
        if (!silent) setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows((r as any).tools ?? []);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!reportOpen) return;
    void window.matrica.tools.properties.list().then((r: any) => {
      if (!r?.ok) return;
      const list = (r.items ?? []).map((p: any) => ({ id: String(p.id), label: String(p.name ?? '(без названия)') }));
      setPropertyOptions(list);
    });
  }, [reportOpen]);

  useEffect(() => {
    if (!reportOpen || !reportPropertyId) {
      setReportPropertyValueHints([]);
      return;
    }
    void window.matrica.tools.properties.valueHints(reportPropertyId).then((r: any) => {
      if (!r?.ok) {
        setReportPropertyValueHints([]);
        return;
      }
      const values = Array.isArray(r.values) ? r.values.map((v: unknown) => String(v)).filter(Boolean) : [];
      setReportPropertyValueHints(values);
    });
  }, [reportOpen, reportPropertyId]);

  useEffect(() => {
    if (queryTimer.current) {
      window.clearTimeout(queryTimer.current);
    }
    queryTimer.current = window.setTimeout(() => {
      void refresh();
    }, 300);
    return () => {
      if (queryTimer.current) window.clearTimeout(queryTimer.current);
    };
  }, [query]);

  useLiveDataRefresh(
    useCallback(async () => {
      await refresh({ silent: true });
    }, [refresh]),
    { intervalMs: 15000 },
  );

  const sorted = useSortedItems(
    rows,
    listState.sortKey as SortKey,
    listState.sortDir,
    (row, key) => {
      if (key === 'toolNumber') return String(row.toolNumber ?? '').toLowerCase();
      if (key === 'name') return String(row.name ?? '').toLowerCase();
      if (key === 'serialNumber') return String(row.serialNumber ?? '').toLowerCase();
      if (key === 'departmentName') return String(row.departmentName ?? '').toLowerCase();
      if (key === 'retired') return row.retiredAt ? 1 : 0;
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );
  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }
  const reportNameHints = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => {
      const n = String(r.name ?? '').trim();
      if (n) s.add(n);
    });
    reportRows.forEach((r) => {
      const n = String(r.name ?? '').trim();
      if (n) s.add(n);
    });
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [rows, reportRows]);

  function fromInputDate(v: string): number | null {
    if (!v) return null;
    const [y, m, d] = v.split('-').map((x) => Number(x));
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
    const ms = dt.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  async function runReport() {
    const startMs = fromInputDate(reportFrom);
    const endMsRaw = fromInputDate(reportTo);
    const endMs = endMsRaw ? endMsRaw + 24 * 60 * 60 * 1000 - 1 : null;
    setReportStatus('Формирование отчета...');
    const r = await window.matrica.tools
      .report({
        startMs: startMs ?? null,
        endMs: endMs ?? null,
        nameQuery: reportName.trim() || null,
        propertyId: reportPropertyId || null,
        propertyValue: reportPropertyValue.trim() || null,
        location: reportLocation === 'all' ? null : reportLocation,
      })
      .catch(() => null);
    if (!r || !(r as any).ok) {
      setReportStatus(`Ошибка: ${(r as any)?.error ?? 'не удалось сформировать'}`);
      setReportRows([]);
      setReportTotals(null);
      return;
    }
    setReportRows((r as any).rows ?? []);
    setReportTotals((r as any).totals ?? null);
    setReportStatus('Готово.');
  }

  const tableHeader = (
    <thead>
      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('toolNumber')}>
          Таб. № {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'toolNumber')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('name')}>
          Наименование {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'name')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('serialNumber')}>
          Серийный № {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'serialNumber')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('departmentName')}>
          Подразделение {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'departmentName')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('retired')}>
          Статус {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'retired')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', width: 140 }}>
          Действия
        </th>
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
                <td colSpan={6} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет инструментов' : 'Не найдено'}
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr
                key={row.id}
                style={{
                  borderBottom: '1px solid #f3f4f6',
                  cursor: 'pointer',
                }}
                onClick={() => void props.onOpen(row.id)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f9fafb';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.toolNumber || '—'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.name || '(без названия)'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.serialNumber || '—'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.departmentName || '—'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: row.retiredAt ? '#b91c1c' : '#15803d' }}>
                  {row.retiredAt ? 'Снят с учета' : 'В учете'}
                </td>
                <td style={{ padding: '10px 12px' }}>
                  {props.canDelete && (
                    <Button
                      variant="ghost"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm('Удалить инструмент?')) return;
                        try {
                          setStatus('Удаление…');
                          const r = await window.matrica.tools.delete(row.id);
                          if (!r.ok) {
                            setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
                            return;
                          }
                          setStatus('Удалено');
                          setTimeout(() => setStatus(''), 900);
                          await refresh();
                        } catch (err) {
                          setStatus(`Ошибка: ${String(err)}`);
                        }
                      }}
                      style={{ color: '#b91c1c' }}
                    >
                      Удалить
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto', flexWrap: 'wrap' }}>
        {props.canCreate && (
          <Button
            onClick={async () => {
              try {
                setStatus('Создание инструмента...');
                const r = await window.matrica.tools.create();
                if (!r.ok) {
                  setStatus(`Ошибка: ${r.error}`);
                  return;
                }
                setStatus('');
                await props.onOpen((r as any).tool.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Создать инструмент
          </Button>
        )}
        <Button variant="ghost" onClick={props.onOpenProperties}>
          Справочник свойств
        </Button>
        <Button variant="ghost" onClick={() => setReportOpen((v) => !v)}>
          Отчет
        </Button>
        <div style={{ flex: 1, minWidth: 220 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по номеру/названию/серийному…" />
        </div>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      {reportOpen && (
        <SectionCard title="Сводный отчет по инструментам (подразделение)" style={{ marginTop: 10 }}>
          <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) minmax(180px, 1fr) minmax(180px, 1fr)', gap: 8, padding: '4px 6px' }}>
            <div>Интервал</div>
            <Input type="date" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} />
            <Input type="date" value={reportTo} onChange={(e) => setReportTo(e.target.value)} />
          </div>
          <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) minmax(180px, 1fr) minmax(180px, 1fr)', gap: 8, padding: '4px 6px' }}>
            <div>Фильтры</div>
            <SuggestInput
              value={reportName}
              onChange={setReportName}
              options={reportNameHints.map((v) => ({ value: v }))}
              placeholder="Название инструмента"
            />
            <select value={reportLocation} onChange={(e) => setReportLocation(e.target.value as any)} style={{ height: 32 }}>
              <option value="all">Все местоположения</option>
              <option value="store">На складе</option>
              <option value="in_use">В подразделении</option>
              <option value="unknown">Неизвестно</option>
            </select>
          </div>
          <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) minmax(180px, 1fr) minmax(180px, 1fr)', gap: 8, padding: '4px 6px' }}>
            <div>Свойства</div>
            <SearchSelect
              value={reportPropertyId}
              options={propertyOptions}
              placeholder="Выберите свойство"
              onChange={(next) => {
                setReportPropertyId(next || '');
                setReportPropertyValue('');
              }}
            />
            <SuggestInput
              value={reportPropertyValue}
              onChange={setReportPropertyValue}
              options={reportPropertyValueHints.map((v) => ({ value: v }))}
              placeholder="Значение свойства"
            />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button tone="info" onClick={() => void runReport()}>
              Сформировать отчет
            </Button>
            {reportStatus && <span style={{ color: reportStatus.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{reportStatus}</span>}
          </div>
          {reportTotals && (
            <div style={{ display: 'flex', gap: 16, color: '#334155', fontSize: 14 }}>
              <span>Всего: {reportTotals.total}</span>
              <span>На складе: {reportTotals.store}</span>
              <span>В подразделении: {reportTotals.inUse}</span>
              <span>Неизвестно: {reportTotals.unknown}</span>
            </div>
          )}
          <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <table className="list-table">
              <thead>
                <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Таб. №</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Наименование</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Серийный №</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Местоположение</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151' }}>Последнее движение</th>
                </tr>
              </thead>
              <tbody>
                {reportRows.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                      Нет данных
                    </td>
                  </tr>
                )}
                {reportRows.map((row) => (
                  <tr key={row.toolId} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.toolNumber || '—'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.name || '(без названия)'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.serialNumber || '—'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>
                      {row.location === 'store' ? 'На складе' : row.location === 'in_use' ? 'В подразделении' : 'Неизвестно'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>
                      {row.lastMovementAt ? new Date(row.lastMovementAt).toLocaleDateString('ru-RU') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}
