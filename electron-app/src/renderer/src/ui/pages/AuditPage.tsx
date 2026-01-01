import React, { useMemo, useState } from 'react';

import type { AuditItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';

export function AuditPage(props: { audit: AuditItem[]; onRefresh: () => Promise<void> }) {
  const width = useWindowWidth();
  const twoCol = width >= 1400;
  const [fromDate, setFromDate] = useState<string>(''); // YYYY-MM-DD
  const [toDate, setToDate] = useState<string>(''); // YYYY-MM-DD
  const [actorFilter, setActorFilter] = useState<string | null>(null);
  const [sectionFilter, setSectionFilter] = useState<string | null>(null);

  function sectionOf(a: AuditItem): string {
    const action = String(a.action ?? '');
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

  function actionRu(a: AuditItem): string {
    switch (String(a.action ?? '')) {
      case 'engine.create':
        return 'Создал двигатель';
      case 'engine.setAttr':
        return 'Изменил данные двигателя';
      case 'supply_request.create':
        return 'Создал заявку';
      case 'supply_request.update':
        return 'Изменил заявку';
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
      return true;
    });
  }, [props.audit, fromDate, toDate, actorFilter, sectionFilter]);

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
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Время</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Логин</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Действие</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Раздел</th>
      </tr>
    </thead>
  );

  function renderTable(items: AuditItem[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>{sectionOf(a)}</td>
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
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>с даты</div>
        </div>
        <div style={{ width: 160 }}>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>по дату</div>
        </div>
        <div style={{ width: 240 }}>
          <SearchSelect value={actorFilter} options={actorOptions} placeholder="Пользователь" onChange={setActorFilter} />
        </div>
        <div style={{ width: 240 }}>
          <SearchSelect value={sectionFilter} options={sectionOptions} placeholder="Раздел" onChange={setSectionFilter} />
        </div>
        {(fromDate || toDate || actorFilter || sectionFilter) && (
          <Button
            variant="ghost"
            onClick={() => {
              setFromDate('');
              setToDate('');
              setActorFilter(null);
              setSectionFilter(null);
            }}
          >
            Сбросить фильтры
          </Button>
        )}
        <span style={{ color: '#6b7280', fontSize: 12 }}>
          Показано: {filtered.length} / {props.audit.length}
        </span>
      </div>

      <div style={{ marginTop: 8 }}>
        <TwoColumnList items={filtered} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}


