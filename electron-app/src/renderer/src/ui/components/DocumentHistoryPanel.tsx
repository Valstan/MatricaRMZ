import { useCallback, useEffect, useState } from 'react';

import { describeAuditAction } from '@matricarmz/shared';

import { Button } from './Button.js';
import { theme } from '../theme.js';
import { formatMoscowLongDateTime } from '../utils/dateUtils.js';

/**
 * «История изменений этого документа» — кто и когда открывал и правил именно эту
 * карточку. Питается тем же журналом действий, что и общий список у админа
 * (`audit_log` → проекция статистики), поэтому отдельного хранилища истории не
 * появилось: правки построчно и так лежат в ledger.
 *
 * Панель видна только тем, у кого есть право «Журнал действий» (`audit.view`;
 * у супер-админа по умолчанию, остальным выдаётся в админке).
 */

type HistoryRow = {
  id: string;
  createdAt: number;
  actor: string;
  action: string;
  actionType: 'create' | 'update' | 'delete' | 'session' | 'other';
  section: string;
  actionText: string;
  documentLabel: string;
  clientId: string | null;
};

const ACTION_TYPE_LABEL: Record<HistoryRow['actionType'], string> = {
  create: 'создание',
  update: 'изменение',
  delete: 'удаление',
  session: 'сеанс',
  other: 'просмотр',
};

export function DocumentHistoryPanel(props: { entityId: string; canView: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    if (!props.entityId) return;
    setStatus('Загрузка…');
    const r = await window.matrica.admin.audit.document({ entityId: props.entityId, limit: 200 }).catch((e) => ({
      ok: false as const,
      error: String(e),
    }));
    if (!r || !('ok' in r) || !r.ok) {
      setRows([]);
      setStatus(`Не удалось загрузить историю: ${(r as { error?: string })?.error ?? 'нет связи'}`);
      return;
    }
    setRows((r.rows ?? []) as HistoryRow[]);
    setStatus((r.rows ?? []).length === 0 ? 'По этому документу записей пока нет.' : '');
  }, [props.entityId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  if (!props.canView || !props.entityId) return null;

  return (
    <div data-document-history style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="ghost" data-document-history-toggle onClick={() => setOpen((v) => !v)}>
          {open ? 'Скрыть историю изменений' : (props.title ?? 'История изменений этого документа')}
        </Button>
        {open ? (
          <Button variant="ghost" onClick={() => void load()}>
            Обновить
          </Button>
        ) : null}
        {open && status ? <span style={{ fontSize: 12, color: theme.colors.muted }}>{status}</span> : null}
      </div>

      {open && rows.length > 0 && (
        <div
          style={{
            marginTop: 8,
            border: `1px solid ${theme.colors.border}`,
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <table className="list-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>Когда</th>
                <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>Кто</th>
                <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>Что</th>
                <th style={{ textAlign: 'left' }}>Действие</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatMoscowLongDateTime(row.createdAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{row.actor}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{ACTION_TYPE_LABEL[row.actionType] ?? row.actionType}</td>
                  <td style={{ wordBreak: 'break-word' }}>{describeAuditAction(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
