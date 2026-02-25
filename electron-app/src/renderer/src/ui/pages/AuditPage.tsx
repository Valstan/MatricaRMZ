import React, { useMemo } from 'react';

import type { AuditItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';

export function AuditPage(props: { audit: AuditItem[]; onRefresh: () => Promise<void> }) {
  const width = useWindowWidth();
  const { isMultiColumn, toggle: toggleColumnsMode } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;
  type SortKey = 'createdAt' | 'actor' | 'action' | 'section';
  const { state: listState, patchState } = useListUiState('list:audit', {
    fromDate: '',
    toDate: '',
    actorFilter: null as string | null,
    sectionFilter: null as string | null,
    sortKey: 'createdAt' as SortKey,
    sortDir: 'desc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:audit');
  const fromDate = String(listState.fromDate ?? '');
  const toDate = String(listState.toDate ?? '');
  const actorFilter = (listState.actorFilter as string | null) ?? null;
  const sectionFilter = (listState.sectionFilter as string | null) ?? null;

  function sectionOf(a: AuditItem): string {
    const action = String(a.action ?? '');
    if (action.startsWith('ui.supply_request.')) return 'Заявки';
    if (action.startsWith('ui.engine.')) return 'Двигатели';
    if (action.startsWith('engine.')) return 'Двигатели';
    if (action.startsWith('supply_request.')) return 'Заявки';
    if (action.startsWith('part.')) return 'Детали';
    if (action.startsWith('auth.')) return 'Вход';
    if (action.startsWith('sync.')) return 'Синхронизация';
    if (action.startsWith('admin.')) return 'Администрирование';
    if (action.startsWith('masterdata.')) return 'Справочники';
    if (action.startsWith('files.')) return 'Файлы';
    if (action.startsWith('updates.')) return 'Изменения';
    return a.tableName ? String(a.tableName) : 'Прочее';
  }

  function parsePayload(a: AuditItem): any | null {
    try {
      if (!a.payloadJson) return null;
      return JSON.parse(a.payloadJson);
    } catch {
      return null;
    }
  }

  function contextRu(a: AuditItem): string {
    const p = parsePayload(a);
    const section = sectionOf(a);
    if (section === 'Заявки') {
      const n = p?.requestNumber ? String(p.requestNumber) : '';
      return n ? `Заявки / ${n}` : 'Заявки';
    }
    if (section === 'Двигатели') {
      const n = p?.engineNumber ? String(p.engineNumber) : '';
      return n ? `Двигатели / ${n}` : 'Двигатели';
    }
    if (section === 'Детали') {
      const name = p?.name ? String(p.name) : '';
      const article = p?.article ? String(p.article) : '';
      const label = [name, article].filter(Boolean).join(' / ');
      return label ? `Детали / ${label}` : 'Детали';
    }
    return section;
  }

  function actionRu(a: AuditItem): string {
    const p = parsePayload(a);
    switch (String(a.action ?? '')) {
      case 'ui.supply_request.edit_done':
        return p?.summaryRu ? `Завершил редактирование заявки. ${String(p.summaryRu)}` : 'Завершил редактирование заявки';
      case 'ui.engine.edit_done':
        return p?.summaryRu ? `Завершил редактирование двигателя. ${String(p.summaryRu)}` : 'Завершил редактирование двигателя';
      case 'engine.create':
        return 'Создал двигатель';
      case 'supply_request.create':
        return 'Создал заявку';
      case 'supply_request.delete':
        return 'Удалил заявку';
      case 'supply_request.transition':
        return p?.fromStatus && p?.toStatus
          ? `Изменил статус заявки: ${String(p.fromStatus)} → ${String(p.toStatus)}`
          : 'Изменил статус заявки';
      case 'part.create':
        return 'Создал деталь';
      case 'part.update_attribute':
        return 'Изменил атрибут детали';
      case 'part.delete':
        return 'Удалил деталь';
      case 'part.attribute_def.create':
        return 'Создал атрибут детали';
      default:
        return String(a.action ?? '');
    }
  }

  function localDayStartMs(dateStr: string): number | null {
    const s = String(dateStr || '').trim();
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(y, mo, d, 0, 0, 0, 0);
    const ms = dt.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const filtered = useMemo(() => {
    const fromMs = localDayStartMs(fromDate);
    const toStartMs = localDayStartMs(toDate);
    const toMs = toStartMs == null ? null : toStartMs + (24 * 60 * 60 * 1000 - 1);

    return props.audit.filter((a) => {
      const createdAt = Number(a.createdAt ?? 0) || 0;
      if (fromMs != null && createdAt < fromMs) return false;
      if (toMs != null && createdAt > toMs) return false;
      if (actorFilter && String(a.actor ?? '') !== actorFilter) return false;
      if (sectionFilter && sectionOf(a) !== sectionFilter) return false;

      // Show only high-level events (reduce noise).
      const action = String(a.action ?? '');
      const allow =
        action === 'engine.create' ||
        action === 'supply_request.create' ||
        action === 'supply_request.delete' ||
        action === 'supply_request.transition' ||
        action === 'ui.supply_request.edit_done' ||
        action === 'ui.engine.edit_done' ||
        action === 'part.create' ||
        action === 'part.delete';
      if (!allow) return false;

      return true;
    });
  }, [props.audit, fromDate, toDate, actorFilter, sectionFilter]);

  const sorted = useSortedItems(
    filtered,
    listState.sortKey as SortKey,
    listState.sortDir,
    (a, key) => {
      if (key === 'actor') return String(a.actor ?? '').toLowerCase();
      if (key === 'action') return String(actionRu(a) ?? '').toLowerCase();
      if (key === 'section') return String(contextRu(a) ?? '').toLowerCase();
      return Number(a.createdAt ?? 0);
    },
    (a) => a.id,
  );

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const actorOptions = useMemo(() => {
    const uniq = Array.from(new Set(props.audit.map((a) => String(a.actor ?? '')).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
    return uniq.map((id) => ({ id, label: id }));
  }, [props.audit]);

  const sectionOptions = useMemo(() => {
    const uniq = Array.from(new Set(props.audit.map((a) => sectionOf(a)).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
    return uniq.map((id) => ({ id, label: id }));
  }, [props.audit]);

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #0891b2 0%, #0e7490 120%)', color: '#fff' }}>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('createdAt')}>
          Время {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'createdAt')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('actor')}>
          Логин {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'actor')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('action')}>
          Действие {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'action')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('section')}>
          Раздел {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'section')}
        </th>
      </tr>
    </thead>
  );

  function renderTable(items: AuditItem[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>{new Date(a.createdAt).toLocaleString('ru-RU')}</td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>{a.actor}</td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}
                  title={[a.action ? `action=${a.action}` : '', a.entityId ? `entityId=${a.entityId}` : '', a.tableName ? `table=${a.tableName}` : ''].filter(Boolean).join(' | ')}
                >
                  {actionRu(a)}
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>{contextRu(a)}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={4}>
                  Пусто
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button onClick={props.onRefresh}>Обновить</Button>
        <div style={{ width: 160 }}>
          <Input type="date" value={fromDate} onChange={(e) => patchState({ fromDate: e.target.value })} />
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>с даты</div>
        </div>
        <div style={{ width: 160 }}>
          <Input type="date" value={toDate} onChange={(e) => patchState({ toDate: e.target.value })} />
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>по дату</div>
        </div>
        <div style={{ width: 240 }}>
          <SearchSelect value={actorFilter} options={actorOptions} placeholder="Пользователь" onChange={(next) => patchState({ actorFilter: next })} />
        </div>
        <div style={{ width: 240 }}>
          <SearchSelect value={sectionFilter} options={sectionOptions} placeholder="Раздел" onChange={(next) => patchState({ sectionFilter: next })} />
        </div>
        {(fromDate || toDate || actorFilter || sectionFilter) && (
          <Button
            variant="ghost"
            onClick={() => {
              patchState({ fromDate: '', toDate: '', actorFilter: null, sectionFilter: null });
            }}
          >
            Сбросить фильтры
          </Button>
        )}
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
        <span style={{ color: '#6b7280', fontSize: 12 }}>
          Показано: {sorted.length} / {props.audit.length}
        </span>
      </div>

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8 }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}


