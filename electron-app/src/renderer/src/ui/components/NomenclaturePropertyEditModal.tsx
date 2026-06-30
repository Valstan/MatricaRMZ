import React, { useEffect, useState } from 'react';

import { Button } from './Button.js';
import { Input } from './Input.js';

export type NomenclaturePropertyEditRow = {
  id: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  optionsJson: string;
  description: string;
};

const DATA_TYPES = ['text', 'number', 'boolean', 'date', 'enum', 'json'] as const;

export function NomenclaturePropertyEditModal(props: {
  open: boolean;
  row: NomenclaturePropertyEditRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dataType, setDataType] = useState<string>('text');
  const [isRequired, setIsRequired] = useState(false);
  const [description, setDescription] = useState('');
  const [enumLines, setEnumLines] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!props.open || !props.row) return;
    setCode(props.row.code);
    setName(props.row.name);
    setDataType(props.row.dataType || 'text');
    setIsRequired(props.row.isRequired);
    setDescription(props.row.description ?? '');
    setErr('');
    if (props.row.dataType === 'enum' && props.row.optionsJson?.trim()) {
      try {
        const parsed = JSON.parse(props.row.optionsJson) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'values' in parsed && Array.isArray((parsed as { values: unknown }).values)) {
          setEnumLines(
            ((parsed as { values: string[] }).values ?? [])
              .map((v) => String(v))
              .join('\n'),
          );
        } else if (Array.isArray(parsed)) {
          setEnumLines((parsed as unknown[]).map((v) => String(v)).join('\n'));
        } else {
          setEnumLines('');
        }
      } catch {
        setEnumLines('');
      }
    } else {
      setEnumLines('');
    }
  }, [props.open, props.row]);

  if (!props.open || !props.row) return null;

  const editingRow = props.row;

  function buildOptionsJson(): string | null {
    if (dataType !== 'enum') return null;
    const values = enumLines
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return JSON.stringify({ values });
  }

  async function save() {
    setBusy(true);
    setErr('');
    try {
      const optionsJson = dataType === 'enum' ? buildOptionsJson() : null;
      const up = await window.matrica.warehouse.nomenclaturePropertyUpsert({
        id: editingRow.id,
        code: code.trim().toLowerCase(),
        name: name.trim(),
        dataType,
        isRequired,
        description: description.trim() || null,
        optionsJson,
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
          width: 'min(520px, 100%)',
          borderRadius: 12,
          background: '#fff',
          padding: 18,
          boxShadow: '0 24px 64px rgba(2, 6, 23, 0.35)',
          border: '1px solid #e5e7eb',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6 }}>Свойство номенклатуры</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>Код меняйте только осознанно — он используется в интеграциях.</div>
        {err ? <div style={{ color: 'var(--danger)', marginBottom: 10, fontSize: 13 }}>{err}</div> : null}

        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Код</div>
            <Input value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
          </div>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Наименование</div>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </div>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Тип значения</div>
            <select value={dataType} onChange={(e) => setDataType(e.target.value)} disabled={busy} style={{ width: '100%', padding: '8px 10px' }}>
              {DATA_TYPES.map((dt) => (
                <option key={dt} value={dt}>
                  {dt}
                </option>
              ))}
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} disabled={busy} />
            Обязательное в карточке (если шаблон помечает как required)
          </label>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Описание</div>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
          </div>
          {dataType === 'enum' ? (
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>Варианты перечисления (по одному в строке)</div>
              <textarea
                value={enumLines}
                onChange={(e) => setEnumLines(e.target.value)}
                disabled={busy}
                rows={6}
                style={{ width: '100%', fontFamily: 'inherit' }}
                placeholder="например:&#10;Новый&#10;Б/у&#10;Восстановленный"
              />
            </div>
          ) : null}
          {dataType === 'json' ? (
            <div style={{ fontSize: 12, color: '#92400e', background: 'rgba(254, 243, 199, 0.5)', padding: 8, borderRadius: 8 }}>
              Тип «json» — для продвинутых сценариев. Значение в карточке вводится как JSON-строка.
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
          <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>
            Отмена
          </Button>
          <Button type="button" variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </div>
    </div>
  );
}
