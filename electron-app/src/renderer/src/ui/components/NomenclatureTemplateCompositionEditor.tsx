import React, { useEffect, useMemo, useState } from 'react';
import type { WarehouseNomenclatureTemplateProperty } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { RowReorderButtons } from './RowReorderButtons.js';
import { SearchSelect } from './SearchSelect.js';
import {
  moveTemplateProperty,
  parseTemplatePropertiesJson,
  removeTemplateProperty,
  serializeTemplatePropertiesJson,
  setTemplatePropertyRequired,
} from '../utils/nomenclatureTemplateProperties.js';

export type NomenclatureTemplateCompositionEditorTemplate = {
  id: string;
  code: string;
  name: string;
  itemTypeCode: string;
  directoryKind: string;
  propertiesJson: string;
};

export function NomenclatureTemplateCompositionEditor(props: {
  open: boolean;
  /** При `open === false` может быть `null`. */
  template: NomenclatureTemplateCompositionEditorTemplate | null;
  propertyOptions: Array<{ id: string; code: string; name: string; dataType: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<WarehouseNomenclatureTemplateProperty[]>([]);
  const [pickPropertyId, setPickPropertyId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const selectOptions = useMemo(
    () =>
      props.propertyOptions.map((p) => ({
        id: p.id,
        label: `${p.name} (${p.code})`,
        hintText: p.dataType,
      })),
    [props.propertyOptions],
  );

  const propertyById = useMemo(() => new Map(props.propertyOptions.map((p) => [p.id, p] as const)), [props.propertyOptions]);

  useEffect(() => {
    if (!props.open || !props.template) return;
    setRows(parseTemplatePropertiesJson(props.template.propertiesJson));
    setPickPropertyId(null);
    setErr('');
  }, [props.open, props.template]);

  if (!props.open || !props.template) return null;

  const t = props.template;

  async function save() {
    setBusy(true);
    setErr('');
    try {
      const propertiesJson = serializeTemplatePropertiesJson(rows);
      const up = await window.matrica.warehouse.nomenclatureTemplateUpsert({
        id: t.id,
        code: t.code.trim(),
        name: t.name.trim(),
        itemTypeCode: t.itemTypeCode.trim() || null,
        directoryKind: t.directoryKind.trim() || null,
        propertiesJson,
      });
      if (!up?.ok) {
        setErr(String(up?.error ?? 'не удалось сохранить'));
        return;
      }
      props.onSaved();
      props.onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 4002,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        role="dialog"
        style={{
          width: 'min(720px, 100%)',
          maxHeight: 'min(90vh, 720px)',
          overflow: 'auto',
          borderRadius: 12,
          background: '#fff',
          padding: 18,
          boxShadow: '0 24px 64px rgba(2, 6, 23, 0.35)',
          border: '1px solid #e5e7eb',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6 }}>Состав шаблона</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
          {t.name} <span style={{ color: '#9ca3af' }}>({t.code})</span>
        </div>

        {err ? <div style={{ color: 'var(--danger)', marginBottom: 10, fontSize: 13 }}>{err}</div> : null}

        <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Добавить свойство из справочника</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end' }}>
            <SearchSelect
              value={pickPropertyId}
              options={selectOptions}
              placeholder="Выберите свойство…"
              showAllWhenEmpty
              emptyQueryLimit={25}
              onChange={(next) => setPickPropertyId(next)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!pickPropertyId || rows.some((r) => r.propertyId === pickPropertyId)}
              onClick={() => {
                if (!pickPropertyId) return;
                if (rows.some((r) => r.propertyId === pickPropertyId)) return;
                setRows((prev) => [...prev, { propertyId: pickPropertyId, required: false, sortOrder: prev.length * 10 }]);
                setPickPropertyId(null);
              }}
            >
              Добавить в шаблон
            </Button>
          </div>
        </div>

        <table className="list-table" style={{ marginBottom: 14 }}>
          <thead>
            <tr>
              <th style={{ width: 72 }}>Порядок</th>
              <th>Свойство</th>
              <th style={{ width: 100 }}>Обяз.</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ color: 'var(--subtle)', padding: 12, textAlign: 'center' }}>
                  В шаблоне пока нет свойств
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => {
                const meta = propertyById.get(row.propertyId);
                return (
                  <tr key={row.propertyId}>
                    <td>
                      <RowReorderButtons
                        canMoveUp={idx > 0}
                        canMoveDown={idx < rows.length - 1}
                        onMoveUp={() => setRows((prev) => moveTemplateProperty(prev, idx, idx - 1))}
                        onMoveDown={() => setRows((prev) => moveTemplateProperty(prev, idx, idx + 1))}
                      />
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{meta?.name ?? row.propertyId}</div>
                      <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
                        {meta?.code ?? ''} {meta?.dataType ? `· ${meta.dataType}` : ''}
                      </div>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={row.required === true}
                        onChange={(e) => setRows((prev) => setTemplatePropertyRequired(prev, row.propertyId, e.target.checked))}
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setRows((prev) => removeTemplateProperty(prev, row.propertyId))}>
                        Удалить
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>
            Отмена
          </Button>
          <Button type="button" variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Сохранение…' : 'Сохранить шаблон'}
          </Button>
        </div>
      </div>
    </div>
  );
}
