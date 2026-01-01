import React from 'react';

import type { AuditItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';

export function AuditPage(props: { audit: AuditItem[]; onRefresh: () => Promise<void> }) {
  const width = useWindowWidth();
  const twoCol = width >= 1400;

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #0891b2 0%, #0e7490 120%)', color: '#fff' }}>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Дата</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Кто</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Действие</th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8 }}>Сущность</th>
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
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>{a.action}</td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>{a.entityId ?? '-'}</td>
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
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button onClick={props.onRefresh}>Обновить</Button>
      </div>

      <div style={{ marginTop: 8 }}>
        <TwoColumnList items={props.audit} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}


