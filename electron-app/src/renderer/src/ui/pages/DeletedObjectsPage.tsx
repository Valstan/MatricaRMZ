import React, { useCallback, useEffect, useState } from 'react';
import { DELETED_RETENTION_TEXT } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { formatMoscowLongDateTime } from '../utils/dateUtils.js';

/**
 * «Удалённое за 3 дня» (промт КАРМАНА #169).
 *
 * Что видит оператор: что удалено, когда и кем (автор удаления — из журнала действий),
 * куда объект вернётся («Двигатели → Д-100») и три кнопки: «Посмотреть» (без
 * восстановления), «Восстановить» и «Удалить окончательно» (с подтверждением).
 *
 * ЧЕСТНОСТЬ. Восстановление может быть неполным: пока объект был удалён, на него могли
 * ссылаться другие записи (деталь стояла в наряде, сотрудник был в графике). Вернётся сам
 * объект, связи могут остаться битыми — об этом сказано в подтверждении.
 */
type DeletedRow = {
  kind: string;
  id: string;
  name: string;
  section: string;
  deletedAt: number;
  restorePath: string;
  /** Кем удалён — из журнала действий. '' — автора в журнале нет. */
  deletedBy?: string;
};

type DescribeResult = {
  ok: boolean;
  error?: string;
  fields?: Array<{ label: string; value: string }>;
};

const KIND_LABELS: Record<string, string> = {
  engine: 'Двигатель',
  contract: 'Договор',
  counterparty: 'Контрагент',
  supply_request: 'Заявка',
  part: 'Деталь',
  employee: 'Сотрудник',
  tool: 'Инструмент',
  work_order: 'Наряд',
  masterdata: 'Запись справочника',
  stock_document: 'Документ склада',
  file: 'Файл',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function DeletedObjectsPage() {
  const [rows, setRows] = useState<DeletedRow[]>([]);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [view, setView] = useState<Record<string, DescribeResult>>({});
  const [busy, setBusy] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setStatus('');
    try {
      const res = await window.matrica.admin.deleted.list();
      if (!res?.ok) {
        setRows([]);
        setStatus(`Ошибка: ${String((res as { error?: string })?.error ?? 'список недоступен')}`);
        return;
      }
      setRows(res.rows ?? []);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleView = useCallback(async (row: DeletedRow) => {
    setBusy(`${row.kind}:${row.id}`);
    try {
      const res = (await window.matrica.admin.deleted.describe({ kind: row.kind, id: row.id })) as DescribeResult;
      setView((prev) => ({ ...prev, [`${row.kind}:${row.id}`]: res }));
      if (!res?.ok) setStatus(`Ошибка: ${String(res?.error ?? 'не удалось посмотреть')}`);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy('');
    }
  }, []);

  const handleRestore = useCallback(
    async (row: DeletedRow) => {
      const path = row.restorePath || row.name || row.id;
      const ok = window.confirm(
        `Вернуть объект: ${path}?\n\nВосстановление может быть неполным: пока объект был удалён, на него могли ссылаться другие записи — вернётся сам объект, связи могут остаться битыми.`,
      );
      if (!ok) return;
      setBusy(`${row.kind}:${row.id}`);
      try {
        const res = await window.matrica.admin.deleted.restore({ kind: row.kind, id: row.id });
        if (!res?.ok) {
          setStatus(`Ошибка: ${String((res as { error?: string })?.error ?? 'не удалось восстановить')}`);
          return;
        }
        setStatus(`Восстановлено: ${String((res as { restorePath?: string })?.restorePath || path)}`);
        await load();
      } catch (e) {
        setStatus(`Ошибка: ${String(e)}`);
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  const handlePurge = useCallback(
    async (row: DeletedRow) => {
      const path = row.restorePath || row.name || row.id;
      const ok = window.confirm(`Удалить окончательно: ${path}?\n\nЭто необратимо: запись исчезнет из списка безвозвратно.`);
      if (!ok) return;
      setBusy(`${row.kind}:${row.id}`);
      try {
        const res = await window.matrica.admin.deleted.purge({ kind: row.kind, id: row.id });
        if (!res?.ok) {
          setStatus(`Ошибка: ${String((res as { error?: string })?.error ?? 'не удалось удалить')}`);
          return;
        }
        setStatus(`Удалено окончательно: ${path}`);
        await load();
      } catch (e) {
        setStatus(`Ошибка: ${String(e)}`);
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  return (
    <div>
      <div style={{ marginBottom: 8, color: 'var(--muted)' }}>
        Здесь удалённые за последние три дня объекты. {DELETED_RETENTION_TEXT}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button onClick={load} disabled={loading}>
          {loading ? 'Обновление...' : 'Обновить'}
        </Button>
      </div>

      {status && (
        <div style={{ marginTop: 8, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--muted)' }}>{status}</div>
      )}

      <div style={{ marginTop: 10, border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ padding: 10, fontWeight: 700, background: 'var(--surface2)' }}>Удалённое за 3 дня</div>
        <ListCount total={rows.length} shown={rows.length} style={{ padding: '0 10px' }} />
        <table className="list-table">
          <thead>
            <tr style={{ background: 'var(--surface-2)', color: 'var(--text)' }}>
              <RowNumberHeaderCell style={{ padding: 8 }} />
              <th data-col-kind="name" style={{ textAlign: 'left', padding: 8 }}>Объект</th>
              <th data-col-kind="name" style={{ textAlign: 'left', padding: 8 }}>Раздел</th>
              <th data-col-kind="date" style={{ textAlign: 'left', padding: 8 }}>Удалён</th>
              <th data-col-kind="name" style={{ textAlign: 'left', padding: 8 }}>Удалил</th>
              <th data-col-kind="name" style={{ textAlign: 'left', padding: 8 }}>Вернётся в</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const key = `${row.kind}:${row.id}`;
              const described = view[key];
              const isBusy = busy === key;
              return (
                <React.Fragment key={key}>
                  <tr>
                    <RowNumberCell n={i + 1} style={{ padding: 8, borderBottom: '1px solid var(--border)' }} />
                    <td data-col-kind="name" style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontWeight: 600 }}>{row.name || '(без имени)'}</div>
                      <div style={{ fontSize: 12, color: 'var(--subtle)' }}>{kindLabel(row.kind)}</div>
                    </td>
                    <td data-col-kind="name" style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{row.section || '—'}</td>
                    <td data-col-kind="date" style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                      {formatMoscowLongDateTime(row.deletedAt)}
                    </td>
                    <td data-col-kind="name" style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                      {row.deletedBy || '—'}
                    </td>
                    <td data-col-kind="name" style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                      {row.restorePath || '—'}
                    </td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Button variant="ghost" disabled={isBusy} onClick={() => void handleView(row)}>
                          Посмотреть
                        </Button>
                        <Button disabled={isBusy} onClick={() => void handleRestore(row)}>
                          Восстановить
                        </Button>
                        <Button variant="outline" disabled={isBusy} onClick={() => void handlePurge(row)}>
                          Удалить окончательно
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {described && (
                    <tr>
                      <td colSpan={7} style={{ padding: '4px 8px 10px', borderBottom: '1px solid var(--border)' }}>
                        {described.ok ? (
                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            {(described.fields ?? []).map((field) => (
                              <div key={field.label}>
                                <div style={{ fontSize: 12, color: 'var(--subtle)' }}>{field.label}</div>
                                <div style={{ fontWeight: 600 }}>{field.value}</div>
                              </div>
                            ))}
                            {(described.fields ?? []).length === 0 && <span style={{ color: 'var(--muted)' }}>Поля не найдены.</span>}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--danger)' }}>{described.error ?? 'Не удалось посмотреть объект.'}</span>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: 'var(--muted)' }} colSpan={7}>
                  Удалённых записей за последние три дня нет.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
