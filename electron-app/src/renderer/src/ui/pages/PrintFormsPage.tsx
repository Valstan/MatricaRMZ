import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_PRINT_FORM_KEY,
  PRINT_FORM_GROUP_TITLES,
  PRINT_FORM_KINDS,
  printFormKindTitle,
  type PrintTemplateRow,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { PrintTemplateEditorDialog } from '../components/PrintTemplateEditorDialog.js';

const ENTITY_FILTER_ALL = '__all__';

/**
 * Раздел «Печатные формы»: список шаблонов по видам объектов.
 *
 * Шаблоны живут в БД (общие и личные), поэтому настройка печати едет за оператором
 * на любую машину. Здесь их создают и правят; сама печать открывает нужный шаблон
 * из карточки или списка (нить 3).
 */
export function PrintFormsPage(props: { canEdit: boolean; canEditShared: boolean }) {
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<PrintTemplateRow[]>([]);
  const [entityFilter, setEntityFilter] = useState<string>(ENTITY_FILTER_ALL);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<{ template: PrintTemplateRow | null; entityKey: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatus('');
    try {
      const res = await window.matrica.printForms.templates.list();
      if (!res.ok) {
        setStatus(`Ошибка загрузки: ${res.error}`);
        setRows([]);
        return;
      }
      setRows(res.rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows
      .filter((r) => entityFilter === ENTITY_FILTER_ALL || r.entityKey === entityFilter)
      .filter((r) => !query || r.name.toLowerCase().includes(query))
      .sort((a, b) => {
        const byKind = a.entityKey.localeCompare(b.entityKey);
        if (byKind !== 0) return byKind;
        return a.name.localeCompare(b.name);
      });
  }, [rows, entityFilter, search]);

  const usedKinds = useMemo(() => {
    const used = new Set(rows.map((r) => r.entityKey));
    return PRINT_FORM_KINDS.filter((k) => used.has(k.key));
  }, [rows]);

  const removeTemplate = useCallback(
    async (row: PrintTemplateRow) => {
      const ok = await confirm({
        title: 'Удалить печатную форму?',
        detail: `Форма «${row.name}» перестанет печататься. Документы, созданные по ней, останутся.`,
        confirmLabel: 'Удалить',
        confirmTone: 'danger',
      });
      if (!ok) return;
      const res = await window.matrica.printForms.templates.delete(row.id);
      if (!res.ok) {
        setStatus(`Ошибка удаления: ${res.error}`);
        return;
      }
      setStatus('Форма удалена.');
      void refresh();
    },
    [confirm, refresh],
  );

  const setDefault = useCallback(
    async (row: PrintTemplateRow) => {
      const res = await window.matrica.printForms.templates.save({
        id: row.id,
        ownerId: row.ownerId === 'shared' ? 'shared' : 'personal',
        entityKey: row.entityKey,
        formKey: row.formKey,
        name: row.name,
        layoutJson: row.layoutJson,
        isDefault: true,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setStatus('Форма назначена по умолчанию.');
      void refresh();
    },
    [refresh],
  );

  return (
    <div style={{ padding: 12 }}>
      <h2 style={{ marginTop: 0 }}>Печатные формы</h2>
      <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 10 }}>
        Шаблон описывает, что печатать: какие пункты оставить, какие картинки поставить и
        чьи подписи нужны. Шаблоны хранятся в БД — настройка едет за оператором на любую машину.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Привязка:</span>
          <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} style={{ padding: '4px 8px' }}>
            <option value={ENTITY_FILTER_ALL}>Все формы</option>
            {PRINT_FORM_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.title}
              </option>
            ))}
          </select>
        </label>
        <Input
          placeholder="Поиск по названию…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 260 }}
        />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {props.canEdit ? (
            <Button onClick={() => setDialog({ template: null, entityKey: entityFilter === ENTITY_FILTER_ALL ? DEFAULT_PRINT_FORM_KEY : entityFilter })}>
              + Новая форма
            </Button>
          ) : null}
        </div>
      </div>

      {status ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b91c1c)' : 'var(--success, #047857)', marginBottom: 8 }}>
          {status}
        </div>
      ) : null}

      <ListCount total={rows.length} shown={filtered.length} />
      <table className="list-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <RowNumberHeaderCell />
            <th style={{ width: 260 }}>Форма</th>
            <th style={{ width: 220 }}>Привязана к</th>
            <th style={{ width: 120 }}>Кому</th>
            <th style={{ width: 120 }}>По умолчанию</th>
            <th style={{ width: 260 }}>Действия</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                Загрузка…
              </td>
            </tr>
          ) : filtered.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                {rows.length === 0
                  ? 'Печатных форм ещё нет.'
                  : 'По текущему фильтру ничего не найдено.'}
              </td>
            </tr>
          ) : (
            filtered.map((row, i) => (
              <tr key={row.id}>
                <RowNumberCell n={i + 1} />
                <td>{row.name}</td>
                <td>{printFormKindTitle(row.entityKey)}</td>
                <td>{row.ownerId === 'shared' ? 'Общий' : 'Личный'}</td>
                <td>{row.isDefault ? 'да' : '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Button onClick={() => setDialog({ template: row, entityKey: row.entityKey })}>Править</Button>
                    {!row.isDefault ? (
                      <Button onClick={() => void setDefault(row)} title="Печатать этой формой по умолчанию">
                        По умолчанию
                      </Button>
                    ) : null}
                    <Button onClick={() => void removeTemplate(row)} title="Удалить форму">
                      Удалить
                    </Button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {usedKinds.length > 0 ? (
        <div style={{ marginTop: 14, fontSize: 11, color: 'var(--subtle)' }}>
          Группы форм: {Array.from(new Set(usedKinds.map((k) => PRINT_FORM_GROUP_TITLES[k.group]))).join(', ')}
        </div>
      ) : null}

      {dialog ? (
        <PrintTemplateEditorDialog
          template={dialog.template}
          defaultEntityKey={dialog.entityKey}
          canEdit={props.canEdit}
          canEditShared={props.canEditShared}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setStatus('Форма сохранена.');
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
