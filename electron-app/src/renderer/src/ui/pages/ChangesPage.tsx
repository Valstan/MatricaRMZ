import React, { useEffect, useMemo, useState } from 'react';

import type { AuthUserInfo, ChangeRequestRow } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';

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
  return k === 'id' || k === 'created_at' || k === 'updated_at' || k === 'sync_status';
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
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) => {
      const hay = `${c.tableName} ${c.rowId} ${c.rootEntityId ?? ''} ${c.recordOwnerUsername ?? ''} ${c.changeAuthorUsername ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
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

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Изменения</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Здесь отображаются правки, которые требуют подтверждения. Применять/отклонять может только автор исходных данных или администратор.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <select
          value={status}
          onChange={(e) => patchState({ status: e.target.value as any })}
          style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
        >
          <option value="pending">Ожидают</option>
          <option value="applied">Применены</option>
          <option value="rejected">Отклонены</option>
        </select>
        <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск…" />
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
        <div style={{ flex: 1 }} />
        <div style={{ color: '#6b7280', fontSize: 12 }}>
          Всего: <span style={{ fontWeight: 800, color: '#111827' }}>{sorted.length}</span>
        </div>
      </div>

      {msg && <div style={{ marginTop: 10, color: msg.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{msg}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'auto' }}>
        <table className="list-table">
          <thead>
            <tr style={{ background: 'linear-gradient(135deg, #16a34a 0%, #15803d 120%)', color: '#fff' }}>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)', cursor: 'pointer' }} onClick={() => onSort('tableName')}>
                Раздел {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'tableName')}
              </th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Что было</th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)', cursor: 'pointer' }} onClick={() => onSort('owner')}>
                Автор записи {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'owner')}
              </th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Как стало</th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)', cursor: 'pointer' }} onClick={() => onSort('changer')}>
                Автор изменений {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'changer')}
              </th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)', width: 220 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const allow = canDecide(c);
              const owner = c.recordOwnerUsername ?? '—';
              const changer = c.changeAuthorUsername ?? '—';
              const before = tryParseJson(c.beforeJson);
              const after = tryParseJson(c.afterJson);
              const diffs = diffLines(before, after);
              const sectionLabel = (c as any).sectionLabel ?? c.tableName;
              const entityLabel =
                (c as any).entityLabel ??
                (c.rootEntityId ? `ID ${String(c.rootEntityId).slice(0, 8)}` : `ID ${String(c.rowId).slice(0, 8)}`);
              const fieldLabel = (c as any).fieldLabel ?? null;
              return (
                <tr key={c.id}>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                    <div style={{ fontWeight: 800, color: '#111827' }}>{sectionLabel}</div>
                    <div style={{ fontSize: 12, color: '#0f172a', marginTop: 4 }}>{entityLabel}</div>
                    {fieldLabel && <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{fieldLabel}</div>}
                    {c.note && <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{c.note}</div>}
                    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#6b7280' }}>
                      {c.rootEntityId ? `root=${c.rootEntityId.slice(0, 8)} ` : ''}
                      id={c.rowId.slice(0, 8)}
                    </div>
                  </td>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, verticalAlign: 'top' }}>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, color: '#334155' }}>
                      {before == null ? '—' : stableStringify(before).slice(0, 900)}
                      {before != null && stableStringify(before).length > 900 ? '\n…' : ''}
                    </pre>
                  </td>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{owner}</td>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, verticalAlign: 'top' }}>
                    {diffs.length > 0 ? (
                      <div style={{ display: 'grid', gap: 6 }}>
                        {diffs.slice(0, 12).map((line, idx) => (
                          <div key={idx} style={{ fontSize: 12, color: '#0f172a', whiteSpace: 'pre-wrap' }}>
                            {line}
                          </div>
                        ))}
                        {diffs.length > 12 && <div style={{ fontSize: 12, color: '#64748b' }}>… и ещё {diffs.length - 12}</div>}
                      </div>
                    ) : (
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, color: '#0f172a' }}>
                        {after == null ? '—' : stableStringify(after).slice(0, 900)}
                        {after != null && stableStringify(after).length > 900 ? '\n…' : ''}
                      </pre>
                    )}
                  </td>
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{changer}</td>
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
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td style={{ padding: 12, color: '#6b7280' }} colSpan={6}>
                  Изменений нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


