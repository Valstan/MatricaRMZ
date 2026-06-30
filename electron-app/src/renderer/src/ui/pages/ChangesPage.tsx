import React, { useEffect, useMemo, useState } from 'react';

import type { AuthUserInfo, ChangeRequestRow } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { VirtualTable } from '../components/VirtualTable.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { matchesQueryInRecord } from '../utils/search.js';

function tryParseJson(s: string | null | undefined): unknown | null {
  const raw = String(s ?? '');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function stableStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function keyRu(k: string): string {
  switch (k) {
    case 'code':
      return 'Код';
    case 'name':
      return 'Название';
    case 'data_type':
      return 'Тип данных';
    case 'is_required':
      return 'Обязательное';
    case 'sort_order':
      return 'Порядок';
    case 'meta_json':
      return 'Параметры';
    case 'deleted_at':
      return 'Удалено';
    case 'entity_type_id':
      return 'Тип сущности';
    case 'entity_id':
      return 'Сущность';
    case 'attribute_def_id':
      return 'Атрибут';
    case 'value_json':
      return 'Значение';
    default:
      return k;
  }
}

function isTechnicalKey(k: string): boolean {
  switch (k) {
    case 'id':
    case 'created_at':
    case 'updated_at':
    case 'deleted_at':
    case 'sync_status':
    case 'entity_id':
    case 'entity_type_id':
    case 'attribute_def_id':
    case 'type_id':
    case 'root_entity_id':
    case 'row_id':
    case 'engine_entity_id':
      return true;
    default:
      return false;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valueText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return stableStringify(v);
}

// Human key/value view of a synced row for the operator: technical/foreign-key
// columns and raw UUID values are dropped, *_json strings are parsed, keys are
// translated. Replaces the raw JSON dump that leaked ids/epochs/sync_status.
function humanizeLines(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const o = obj as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o).sort()) {
    if (isTechnicalKey(k)) continue;
    let v: unknown = o[k];
    if (k.endsWith('_json') && typeof v === 'string') v = tryParseJson(v);
    if (typeof v === 'string' && UUID_RE.test(v)) continue;
    const text = valueText(v);
    if (!text || text === 'null') continue;
    out.push(`${keyRu(k)}: ${text}`);
  }
  return out;
}

// Hide technical provenance notes (e.g. "part.update_attribute:status_rejected")
// — dotted/namespaced ASCII codes with no spaces. Human notes (Cyrillic / spaced)
// still render. The human field label already shows what changed.
function isHumanNote(note: string | null | undefined): boolean {
  const t = String(note ?? '').trim();
  if (!t) return false;
  if (!/\s/.test(t) && /[.:]/.test(t) && /^[\x20-\x7e]+$/.test(t)) return false;
  return true;
}

function diffLines(before: unknown, after: unknown): string[] {
  if (!before || !after) return [];
  if (typeof before !== 'object' || typeof after !== 'object') return [];
  if (Array.isArray(before) || Array.isArray(after)) return [];

  const b = before as any;
  const a = after as any;
  const keys = new Set<string>([...Object.keys(b), ...Object.keys(a)]);
  const out: string[] = [];

  for (const k of Array.from(keys).sort()) {
    if (isTechnicalKey(k)) continue;
    const bv = b[k];
    const av = a[k];
    // Treat nested json string fields
    const showB = k.endsWith('_json') && typeof bv === 'string' ? tryParseJson(bv) : bv;
    const showA = k.endsWith('_json') && typeof av === 'string' ? tryParseJson(av) : av;
    const same = stableStringify(showB) === stableStringify(showA);
    if (same) continue;
    out.push(`${keyRu(k)}: ${stableStringify(showB)} → ${stableStringify(showA)}`);
  }
  return out;
}

export function ChangesPage(props: { me: AuthUserInfo; canDecideAsAdmin: boolean }) {
  type SortKey = 'tableName' | 'owner' | 'changer' | 'createdAt';
  const { state: listState, patchState } = useListUiState('list:changes', {
    status: 'pending' as 'pending' | 'applied' | 'rejected',
    query: '',
    sortKey: 'createdAt' as SortKey,
    sortDir: 'desc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:changes');
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;
  const status = listState.status as 'pending' | 'applied' | 'rejected';
  const query = String(listState.query ?? '');
  const [rows, setRows] = useState<ChangeRequestRow[]>([]);
  const [msg, setMsg] = useState<string>('');

  async function refresh() {
    setMsg('Загрузка…');
    const r = await window.matrica.changes.list({ status, limit: 2000 });
    if (!r.ok) {
      setMsg(`Ошибка: ${r.error}`);
      setRows([]);
      return;
    }
    setRows(r.changes ?? []);
    setMsg('');
  }

  useEffect(() => {
    void refresh();
  }, [status]);

  const filtered = useMemo(() => {
    return rows.filter((row) => matchesQueryInRecord(query, row));
  }, [rows, query]);
  const visible = useMemo(() => {
    return filtered.filter((c) => {
      const note = String(c.note ?? '');
      if (note.startsWith('missing ')) return false;
      return true;
    });
  }, [filtered]);

  const sorted = useSortedItems(
    visible,
    listState.sortKey as SortKey,
    listState.sortDir,
    (c, key) => {
      if (key === 'tableName') return String((c as any).sectionLabel ?? c.tableName ?? '').toLowerCase();
      if (key === 'owner') return String(c.recordOwnerUsername ?? '').toLowerCase();
      if (key === 'changer') return String(c.changeAuthorUsername ?? '').toLowerCase();
      return Number(c.createdAt ?? 0);
    },
    (c) => c.id,
  );

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  function canDecide(c: ChangeRequestRow): boolean {
    if (props.canDecideAsAdmin) return true;
    if (c.recordOwnerUserId && c.recordOwnerUserId === props.me.id) return true;
    return false;
  }

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #16a34a 0%, #15803d 120%)', color: '#fff' }}>
        <th data-col-kind="name" style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)', cursor: 'pointer' }} onClick={() => onSort('tableName')}>
          Раздел {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'tableName')}
        </th>
        <th data-col-kind="text" style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Что было</th>
        <th data-col-kind="name" style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)', cursor: 'pointer' }} onClick={() => onSort('owner')}>
          Автор записи {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'owner')}
        </th>
        <th data-col-kind="text" style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Как стало</th>
        <th data-col-kind="name" style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)', cursor: 'pointer' }} onClick={() => onSort('changer')}>
          Автор изменений {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'changer')}
        </th>
        <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)', width: 220 }}>Действия</th>
      </tr>
    </thead>
  );

  function renderChangeCells(c: ChangeRequestRow) {
    const allow = canDecide(c);
    const owner = c.recordOwnerUsername ?? '—';
    const changer = c.changeAuthorUsername ?? '—';
    const before = tryParseJson(c.beforeJson);
    const after = tryParseJson(c.afterJson);
    const diffs = diffLines(before, after);
    const beforeLines = humanizeLines(before);
    const afterLines = humanizeLines(after);
    const sectionLabel = (c as any).sectionLabel ?? c.tableName;
    const entityLabel =
      (c as any).entityLabel ??
      (c.rootEntityId ? `ID ${String(c.rootEntityId).slice(0, 8)}` : `ID ${String(c.rowId).slice(0, 8)}`);
    const fieldLabel = (c as any).fieldLabel ?? null;
    return (
      <>
        <td data-col-kind="name" style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
          <div style={{ fontWeight: 800, color: '#111827' }}>{sectionLabel}</div>
          <div style={{ fontSize: 12, color: '#0f172a', marginTop: 4 }}>{entityLabel}</div>
          {fieldLabel && <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{fieldLabel}</div>}
          {isHumanNote(c.note) && <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{c.note}</div>}
        </td>
        <td data-col-kind="text" style={{ borderBottom: '1px solid #f3f4f6', padding: 10, verticalAlign: 'top' }}>
          {beforeLines.length > 0 ? (
            <div style={{ display: 'grid', gap: 6 }}>
              {beforeLines.slice(0, 12).map((line, idx) => (
                <div key={idx} style={{ fontSize: 12, color: '#334155', whiteSpace: 'pre-wrap' }}>
                  {line}
                </div>
              ))}
              {beforeLines.length > 12 && <div style={{ fontSize: 12, color: '#64748b' }}>… и ещё {beforeLines.length - 12}</div>}
            </div>
          ) : (
            <span style={{ fontSize: 12, color: '#64748b' }}>—</span>
          )}
        </td>
        <td data-col-kind="name" style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{owner}</td>
        <td data-col-kind="text" style={{ borderBottom: '1px solid #f3f4f6', padding: 10, verticalAlign: 'top' }}>
          {diffs.length > 0 ? (
            <div style={{ display: 'grid', gap: 6 }}>
              {diffs.slice(0, 12).map((line, idx) => (
                <div key={idx} style={{ fontSize: 12, color: '#0f172a', whiteSpace: 'pre-wrap' }}>
                  {line}
                </div>
              ))}
              {diffs.length > 12 && <div style={{ fontSize: 12, color: '#64748b' }}>… и ещё {diffs.length - 12}</div>}
            </div>
          ) : afterLines.length > 0 ? (
            <div style={{ display: 'grid', gap: 6 }}>
              {afterLines.slice(0, 12).map((line, idx) => (
                <div key={idx} style={{ fontSize: 12, color: '#0f172a', whiteSpace: 'pre-wrap' }}>
                  {line}
                </div>
              ))}
              {afterLines.length > 12 && <div style={{ fontSize: 12, color: '#64748b' }}>… и ещё {afterLines.length - 12}</div>}
            </div>
          ) : (
            <span style={{ fontSize: 12, color: '#0f172a' }}>—</span>
          )}
        </td>
        <td data-col-kind="name" style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{changer}</td>
        <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button
              disabled={!allow || status !== 'pending'}
              onClick={async () => {
                if (!confirm('Применить изменения?')) return;
                setMsg('Применяю…');
                const r = await window.matrica.changes.apply({ id: c.id });
                setMsg(r.ok ? 'Применено' : `Ошибка: ${r.error}`);
                await refresh();
              }}
              style={{ background: '#15803d', border: '1px solid #166534' }}
            >
              Применить
            </Button>
            <Button
              disabled={!allow || status !== 'pending'}
              onClick={async () => {
                if (!confirm('Отклонить изменения?')) return;
                setMsg('Отклоняю…');
                const r = await window.matrica.changes.reject({ id: c.id });
                setMsg(r.ok ? 'Отклонено' : `Ошибка: ${r.error}`);
                await refresh();
              }}
              style={{ background: '#b91c1c', border: '1px solid #991b1b' }}
            >
              Отменить
            </Button>
          </div>
          {!allow && status === 'pending' && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>Недоступно: только автор/админ</div>
          )}
        </td>
      </>
    );
  }

  function renderTable(items: ChangeRequestRow[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'clip' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>{renderChangeCells(row)}</tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={6}>
                  Изменений нет
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
      <h2 style={{ margin: '8px 0', flex: '0 0 auto' }}>Изменения</h2>
      <div style={{ color: '#6b7280', marginBottom: 12, flex: '0 0 auto' }}>
        Здесь отображаются правки, которые требуют подтверждения. Применять/отклонять может только автор исходных данных или администратор.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flex: '0 0 auto' }}>
        <select
          value={status}
          onChange={(e) => patchState({ status: e.target.value as any })}
          style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
        >
          <option value="pending">Ожидают</option>
          <option value="applied">Применены</option>
          <option value="rejected">Отклонены</option>
        </select>
        <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным изменения…" />
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
        <div style={{ flex: 1 }} />
        <div style={{ color: '#6b7280', fontSize: 12 }}>
          Всего: <span style={{ fontWeight: 800, color: '#111827' }}>{sorted.length}</span>
        </div>
      </div>

      {msg && <div style={{ marginTop: 10, color: msg.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', flex: '0 0 auto' }}>{msg}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 12, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        {twoCol ? (
          <TwoColumnList items={sorted} enabled renderColumn={(items) => renderTable(items)} />
        ) : (
          <VirtualTable
            scrollElementRef={containerRef}
            count={sorted.length}
            header={tableHeader}
            renderCells={(i) => renderChangeCells(sorted[i]!)}
            getRowKey={(i) => sorted[i]!.id}
            colCount={6}
            estimateSize={100}
            emptyState="Изменений нет"
          />
        )}
      </div>
      <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {sorted.length}</div>
    </div>
  );
}


