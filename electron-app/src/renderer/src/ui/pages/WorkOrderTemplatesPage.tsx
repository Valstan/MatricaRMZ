import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  WORK_ORDER_KIND_LABELS,
  WORK_ORDER_TEMPLATE_KINDS,
  WorkOrderKind,
  type WorkOrderTemplateSummary,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { matchesQueryInRecord } from '../utils/search.js';
import { WorkOrderTemplateEditorDialog } from '../components/WorkOrderTemplateEditorDialog.js';
import { formatMoscowDate } from '../utils/dateUtils.js';

const KIND_FILTER_ALL = '__all__';

type KindFilter = typeof KIND_FILTER_ALL | WorkOrderKind;

export function WorkOrderTemplatesPage(props: { canEdit: boolean }) {
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<WorkOrderTemplateSummary[]>([]);
  const [kindFilter, setKindFilter] = useState<KindFilter>(KIND_FILTER_ALL);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<{ templateId: string | null; defaultKind: WorkOrderKind } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatus('');
    try {
      const args = kindFilter === KIND_FILTER_ALL ? undefined : { kind: kindFilter };
      const r = await window.matrica.workOrderTemplates.list(args);
      if (!r?.ok) {
        setStatus(`Ошибка загрузки: ${r?.error ?? 'unknown'}`);
        setRows([]);
        return;
      }
      setRows(r.templates);
    } finally {
      setLoading(false);
    }
  }, [kindFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredRows = useMemo(
    () => rows.filter((r) => matchesQueryInRecord(search, { name: r.name })),
    [rows, search],
  );

  async function handleDelete(template: WorkOrderTemplateSummary) {
    if (!props.canEdit) return;
    const ok = await confirm({
      title: 'Удалить шаблон?',
      detail: `Шаблон «${template.name}» (${WORK_ORDER_KIND_LABELS[template.workOrderKind]}) будет удалён безвозвратно. Уже созданные по нему наряды не затрагиваются.`,
      confirmLabel: 'Удалить',
      cancelLabel: 'Отмена',
      confirmTone: 'danger',
    });
    if (!ok) return;
    setStatus('');
    const r = await window.matrica.workOrderTemplates.delete(template.id);
    if (!r?.ok) {
      setStatus(`Ошибка удаления: ${r?.error ?? 'unknown'}`);
      return;
    }
    setStatus(`Шаблон «${template.name}» удалён.`);
    await refresh();
  }

  function openCreate(kind: WorkOrderKind) {
    setDialog({ templateId: null, defaultKind: kind });
  }
  function openEdit(template: WorkOrderTemplateSummary) {
    setDialog({ templateId: template.id, defaultKind: template.workOrderKind });
  }

  return (
    <div style={{ padding: 12 }}>
      <h2 style={{ marginTop: 0 }}>Шаблоны нарядов</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Тип:</span>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as KindFilter)}
            style={{ padding: '4px 8px' }}
          >
            <option value={KIND_FILTER_ALL}>Все типы</option>
            {WORK_ORDER_TEMPLATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {WORK_ORDER_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <Input
          placeholder="Поиск по имени…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 260 }}
        />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {props.canEdit
            ? WORK_ORDER_TEMPLATE_KINDS.map((k) => (
                <Button key={k} onClick={() => openCreate(k)} title={`Создать шаблон: ${WORK_ORDER_KIND_LABELS[k]}`}>
                  + {WORK_ORDER_KIND_LABELS[k]}
                </Button>
              ))
            : null}
        </div>
      </div>

      {!props.canEdit ? (
        <div style={{ color: 'var(--subtle)', marginBottom: 8 }}>
          Только просмотр. Для создания/редактирования нужно право «Редактирование шаблонов нарядов».
        </div>
      ) : null}

      {status ? (
        <div
          style={{
            color: status.startsWith('Ошибка') ? 'var(--danger, #b91c1c)' : 'var(--success, #047857)',
            marginBottom: 8,
          }}
        >
          {status}
        </div>
      ) : null}

      <table className="list-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th data-col-kind="name" style={{ width: 200 }}>Тип</th>
            <th data-col-kind="name">Имя</th>
            <th data-col-kind="num" title="Строк" style={{ width: 100, textAlign: 'right' }}>Строк</th>
            <th data-col-kind="date" title="Обновлён" style={{ width: 160 }}>Обновлён</th>
            <th style={{ width: 160 }}>Действия</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={5} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                Загрузка…
              </td>
            </tr>
          ) : filteredRows.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                {rows.length === 0
                  ? 'Шаблонов ещё нет.'
                  : 'По текущему фильтру ничего не найдено.'}
              </td>
            </tr>
          ) : (
            filteredRows.map((row) => (
              <tr key={row.id}>
                <td data-col-kind="name">{WORK_ORDER_KIND_LABELS[row.workOrderKind]}</td>
                <td data-col-kind="name">{row.name}</td>
                <td data-col-kind="num" style={{ textAlign: 'right' }}>{row.lineCount}</td>
                <td data-col-kind="date">{row.updatedAt ? formatMoscowDate(row.updatedAt) : '—'}</td>
                <td>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(row)}>
                    {props.canEdit ? 'Изменить' : 'Открыть'}
                  </Button>{' '}
                  {props.canEdit ? (
                    <Button size="sm" variant="ghost" onClick={() => void handleDelete(row)}>
                      Удалить
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {dialog ? (
        <WorkOrderTemplateEditorDialog
          open={true}
          templateId={dialog.templateId}
          defaultKind={dialog.defaultKind}
          canEdit={props.canEdit}
          onClose={() => setDialog(null)}
          onSaved={() => {
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
