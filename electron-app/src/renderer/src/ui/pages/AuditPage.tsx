import React from 'react';

import type { AuditItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';

export function AuditPage(props: { audit: AuditItem[]; onRefresh: () => Promise<void> }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Button onClick={props.onRefresh}>Обновить</Button>
      </div>

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: 10 }}>Дата</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: 10 }}>Кто</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: 10 }}>Действие</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: 10 }}>Сущность</th>
            </tr>
          </thead>
          <tbody>
            {props.audit.map((a) => (
              <tr key={a.id}>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                  {new Date(a.createdAt).toLocaleString('ru-RU')}
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{a.actor}</td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{a.action}</td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{a.entityId ?? '-'}</td>
              </tr>
            ))}
            {props.audit.length === 0 && (
              <tr>
                <td style={{ padding: 12, color: '#6b7280' }} colSpan={4}>
                  Пусто
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


