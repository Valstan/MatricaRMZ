import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_PRINT_FORM_KEY,
  MAX_PRINT_TEMPLATE_IMAGE_BYTES,
  PRINT_FIELD_SOURCE_TITLES,
  PRINT_FIELD_SOURCES,
  PRINT_FORM_KINDS,
  PRINT_IMAGE_PLACEMENT_TITLES,
  PRINT_IMAGE_PLACEMENTS,
  printFormKind,
  type PrintFieldSource,
  type PrintImagePlacement,
  type PrintTemplateField,
  type PrintTemplateImage,
  type PrintTemplateLayout,
  type PrintTemplateRow,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';

type EditorState = {
  id: string | null;
  name: string;
  entityKey: string;
  scope: 'shared' | 'personal';
  isDefault: boolean;
  headerNote: string;
  footerNote: string;
  /** Выключенные блоки формы: id блока, который выключен. */
  disabledSections: string[];
  images: PrintTemplateImage[];
  fields: PrintTemplateField[];
};

const EMPTY: EditorState = {
  id: null,
  name: '',
  entityKey: DEFAULT_PRINT_FORM_KEY,
  scope: 'personal',
  isDefault: false,
  headerNote: '',
  footerNote: '',
  disabledSections: [],
  images: [],
  fields: [],
};

function stateFromRow(row: PrintTemplateRow): EditorState {
  let layout: PrintTemplateLayout = {};
  try {
    layout = JSON.parse(row.layoutJson) as PrintTemplateLayout;
  } catch {
    layout = {};
  }
  const sections = Array.isArray(layout.sections) ? layout.sections : [];
  return {
    id: row.id,
    name: row.name,
    entityKey: row.entityKey,
    scope: row.ownerId === 'shared' ? 'shared' : 'personal',
    isDefault: row.isDefault === true,
    headerNote: layout.headerNote ?? '',
    footerNote: layout.footerNote ?? '',
    disabledSections: sections.filter((s) => s.enabled === false).map((s) => String(s.id)),
    images: Array.isArray(layout.images) ? layout.images : [],
    fields: Array.isArray(layout.fields) ? layout.fields : [],
  };
}

function layoutFromState(state: EditorState): PrintTemplateLayout {
  const kind = printFormKind(state.entityKey);
  const sections = (kind?.sections ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    enabled: !state.disabledSections.includes(s.id),
  }));
  return {
    sections,
    ...(state.headerNote.trim() ? { headerNote: state.headerNote.trim() } : {}),
    ...(state.footerNote.trim() ? { footerNote: state.footerNote.trim() } : {}),
    ...(state.images.length ? { images: state.images } : {}),
    ...(state.fields.length ? { fields: state.fields } : {}),
  };
}

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

export function PrintTemplateEditorDialog(props: {
  /** Шаблон для правки; null — создаём новый. */
  template: PrintTemplateRow | null;
  defaultEntityKey?: string;
  canEdit: boolean;
  /** Правку общего шаблона (справочник) — отдельный флаг от canEdit. */
  canEditShared: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [editor, setEditor] = useState<EditorState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (props.template) {
      setEditor(stateFromRow(props.template));
      return;
    }
    setEditor({ ...EMPTY, entityKey: props.defaultEntityKey ?? EMPTY.entityKey });
  }, [props.template, props.defaultEntityKey]);

  const kind = printFormKind(editor.entityKey);
  const sections = kind?.sections ?? [];

  const scopeAllowed = editor.scope === 'shared' ? props.canEditShared : props.canEdit;
  const editable = props.canEdit && scopeAllowed;

  const set = useCallback((patch: Partial<EditorState>) => {
    setEditor((prev) => ({ ...prev, ...patch }));
  }, []);

  const toggleSection = useCallback((id: string) => {
    setEditor((prev) => ({
      ...prev,
      disabledSections: prev.disabledSections.includes(id)
        ? prev.disabledSections.filter((x) => x !== id)
        : [...prev.disabledSections, id],
    }));
  }, []);

  const addImage = useCallback(async (file: File) => {
    setError('');
    if (file.size > MAX_PRINT_TEMPLATE_IMAGE_BYTES) {
      setError(
        `Картинка больше ${Math.round(MAX_PRINT_TEMPLATE_IMAGE_BYTES / 1024)} КБ — уменьшите её. ` +
          'Шаблон едет в каждый клиент, тяжёлая картинка делает его дорогим для всех.',
      );
      return;
    }
    try {
      const dataUri = await readFileAsDataUri(file);
      setEditor((prev) => ({
        ...prev,
        images: [
          ...prev.images,
          {
            id: `img_${Date.now()}_${prev.images.length}`,
            dataUri,
            placement: 'top',
            widthMm: 60,
          },
        ],
      }));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const updateImage = useCallback((id: string, patch: Partial<PrintTemplateImage>) => {
    setEditor((prev) => ({
      ...prev,
      images: prev.images.map((img) => (img.id === id ? { ...img, ...patch } : img)),
    }));
  }, []);

  const removeImage = useCallback((id: string) => {
    setEditor((prev) => ({ ...prev, images: prev.images.filter((img) => img.id !== id) }));
  }, []);

  const addField = useCallback(() => {
    setEditor((prev) => ({
      ...prev,
      fields: [
        ...prev.fields,
        {
          id: `field_${Date.now()}_${prev.fields.length}`,
          label: '',
          source: 'signature_role',
        },
      ],
    }));
  }, []);

  const updateField = useCallback((id: string, patch: Partial<PrintTemplateField>) => {
    setEditor((prev) => ({
      ...prev,
      fields: prev.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    }));
  }, []);

  const removeField = useCallback((id: string) => {
    setEditor((prev) => ({ ...prev, fields: prev.fields.filter((f) => f.id !== id) }));
  }, []);

  const save = useCallback(async () => {
    setError('');
    const name = editor.name.trim();
    if (!name) {
      setError('Название шаблона обязательно');
      return;
    }
    setSubmitting(true);
    try {
      const res = await window.matrica.printForms.templates.save({
        ...(editor.id ? { id: editor.id } : {}),
        ownerId: editor.scope,
        entityKey: editor.entityKey,
        formKey: editor.entityKey,
        name,
        layoutJson: JSON.stringify(layoutFromState(editor)),
        isDefault: editor.isDefault,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      props.onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }, [editor, props]);

  const scopeHint = useMemo(() => {
    if (editor.scope === 'shared') {
      return props.canEditShared
        ? 'Общий шаблон: его видят и печатают все операторы.'
        : 'Общий шаблон правит тот, у кого есть право на справочники.';
    }
    return 'Личный шаблон: его видите только вы.';
  }, [editor.scope, props.canEditShared]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={() => {
        if (!submitting) props.onClose();
      }}
    >
      <div
        style={{
          background: 'var(--surface, #fff)',
          borderRadius: 8,
          padding: 16,
          width: 'min(860px, 94vw)',
          maxHeight: '90vh',
          overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{props.template ? 'Правка печатной формы' : 'Новая печатная форма'}</h3>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Название</span>
            <Input
              value={editor.name}
              disabled={!editable}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Например: Бланк выдачи СИЗ"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Привязана к</span>
            <select
              value={editor.entityKey}
              disabled={!editable}
              onChange={(e) => set({ entityKey: e.target.value })}
              style={{ padding: '4px 8px' }}
            >
              {PRINT_FORM_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.title}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Кому</span>
            <select
              value={editor.scope}
              disabled={!props.canEdit}
              onChange={(e) => set({ scope: e.target.value as 'shared' | 'personal' })}
              style={{ padding: '4px 8px' }}
            >
              <option value="personal">Личный</option>
              <option value="shared">Общий</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 18 }}>
            <input
              type="checkbox"
              checked={editor.isDefault}
              disabled={!editable}
              onChange={(e) => set({ isDefault: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>По умолчанию</span>
          </label>
        </div>
        <div style={{ fontSize: 11, color: 'var(--subtle)', marginBottom: 12 }}>{scopeHint}</div>

        <h4 style={{ margin: '12px 0 6px' }}>Пункты формы</h4>
        <div style={{ fontSize: 11, color: 'var(--subtle)', marginBottom: 6 }}>
          Снятый пункт не печатается. Форму сама решает, что выводить; шаблон — только что убрать.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {sections.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--subtle)' }}>У этой формы нет блоков.</div>
          ) : (
            sections.map((s) => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!editor.disabledSections.includes(s.id)}
                  disabled={!editable}
                  onChange={() => toggleSection(s.id)}
                />
                {s.title}
              </label>
            ))
          )}
        </div>

        <h4 style={{ margin: '16px 0 6px' }}>Картинки</h4>
        <div style={{ fontSize: 11, color: 'var(--subtle)', marginBottom: 6 }}>
          Картинка вшивается в шаблон и печатается на листе — эмблема, печать, схема.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <label>
            <input
              type="file"
              accept="image/png,image/jpeg"
              disabled={!editable}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void addImage(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        {editor.images.map((img) => (
          <div
            key={img.id}
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              border: '1px solid var(--border, #e5e7eb)',
              borderRadius: 6,
              padding: 6,
              marginBottom: 6,
            }}
          >
            <img
              src={img.dataUri}
              alt={img.caption || 'Картинка шаблона'}
              style={{ width: 64, height: 44, objectFit: 'contain', border: '1px solid var(--border, #e5e7eb)' }}
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 11, color: 'var(--subtle)' }}>Где на листе</span>
              <select
                value={img.placement}
                disabled={!editable}
                onChange={(e) => updateImage(img.id, { placement: e.target.value as PrintImagePlacement })}
                style={{ padding: '2px 6px' }}
              >
                {PRINT_IMAGE_PLACEMENTS.map((p) => (
                  <option key={p} value={p}>
                    {PRINT_IMAGE_PLACEMENT_TITLES[p]}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 11, color: 'var(--subtle)' }}>Ширина, мм</span>
              <Input
                value={String(img.widthMm ?? 60)}
                disabled={!editable}
                onChange={(e) => updateImage(img.id, { widthMm: Number(e.target.value) || 60 })}
                style={{ width: 80 }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              <span style={{ fontSize: 11, color: 'var(--subtle)' }}>Подпись</span>
              <Input
                value={img.caption ?? ''}
                disabled={!editable}
                onChange={(e) => updateImage(img.id, { caption: e.target.value })}
                placeholder="необязательно"
              />
            </label>
            <Button onClick={() => removeImage(img.id)} disabled={!editable} title="Убрать картинку">
              ✕
            </Button>
          </div>
        ))}

        <h4 style={{ margin: '16px 0 6px' }}>Поля и подписи</h4>
        <div style={{ fontSize: 11, color: 'var(--subtle)', marginBottom: 6 }}>
          «Подпись по должности» подставляет сотрудника из карточки. Если нужен цех — отметьте:
          тогда подпись берётся из выбранного цеха (например, начальник четвёртого цеха).
        </div>
        {editor.fields.map((f) => (
          <div
            key={f.id}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              marginBottom: 6,
            }}
          >
            <Input
              value={f.label}
              disabled={!editable}
              onChange={(e) => updateField(f.id, { label: e.target.value })}
              placeholder="Подпись поля"
              style={{ width: 200 }}
            />
            <select
              value={f.source}
              disabled={!editable}
              onChange={(e) => updateField(f.id, { source: e.target.value as PrintFieldSource })}
              style={{ padding: '4px 8px' }}
            >
              {PRINT_FIELD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {PRINT_FIELD_SOURCE_TITLES[s]}
                </option>
              ))}
            </select>
            {f.source === 'signature_role' ? (
              <>
                <Input
                  value={f.role ?? ''}
                  disabled={!editable}
                  onChange={(e) => updateField(f.id, { role: e.target.value })}
                  placeholder="должность, напр. директор"
                  style={{ width: 220 }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={f.requireDepartment === true}
                    disabled={!editable}
                    onChange={(e) => updateField(f.id, { requireDepartment: e.target.checked })}
                  />
                  выбирать цех
                </label>
              </>
            ) : null}
            <Button onClick={() => removeField(f.id)} disabled={!editable} title="Убрать поле">
              ✕
            </Button>
          </div>
        ))}
        <Button onClick={addField} disabled={!editable}>
          + Поле
        </Button>

        <h4 style={{ margin: '16px 0 6px' }}>Примечания</h4>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 300px' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>В шапке</span>
            <textarea
              value={editor.headerNote}
              disabled={!editable}
              onChange={(e) => set({ headerNote: e.target.value })}
              rows={2}
              style={{ width: '100%' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 300px' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>В подвале</span>
            <textarea
              value={editor.footerNote}
              disabled={!editable}
              onChange={(e) => set({ footerNote: e.target.value })}
              rows={2}
              style={{ width: '100%' }}
            />
          </label>
        </div>

        {error ? (
          <div style={{ color: 'var(--danger, #b91c1c)', marginTop: 10, fontSize: 12 }}>{error}</div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <Button onClick={props.onClose} disabled={submitting}>
            Отмена
          </Button>
          <Button onClick={() => void save()} disabled={!editable || submitting}>
            {submitting ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </div>
      </div>
    </div>
  );
}
