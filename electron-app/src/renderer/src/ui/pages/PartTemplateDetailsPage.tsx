import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { Input } from '../components/Input.js';
import { SectionCard } from '../components/SectionCard.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';

type TemplateAttribute = {
  id: string;
  code: string;
  name: string;
  value: unknown;
};

type LinkedPartRow = {
  id: string;
  name?: string;
  article?: string;
};

export function PartTemplateDetailsPage(props: {
  templateId: string;
  canEdit: boolean;
  canDelete: boolean;
  onOpenPart: (partId: string) => void;
  onClose: () => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [status, setStatus] = useState('');
  const [createdAt, setCreatedAt] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [linkedParts, setLinkedParts] = useState<LinkedPartRow[]>([]);
  const dirtyRef = useRef(false);

  const title = useMemo(() => (name.trim() ? `Деталь (справочник): ${name.trim()}` : 'Деталь (справочник)'), [name]);

  async function load() {
    try {
      setStatus('Загрузка…');
      const [templateResult, partsResult] = await Promise.all([
        window.matrica.parts.templates.get(props.templateId),
        window.matrica.parts.list({ templateId: props.templateId, limit: 5000 }),
      ]);
      if (!templateResult.ok) {
        setStatus(`Ошибка: ${templateResult.error}`);
        return;
      }
      if (!partsResult.ok) {
        setStatus(`Ошибка: ${partsResult.error}`);
        return;
      }
      const attrs = new Map((templateResult.template.attributes as TemplateAttribute[]).map((row) => [row.code, row.value] as const));
      setCreatedAt(Number(templateResult.template.createdAt ?? 0));
      setUpdatedAt(Number(templateResult.template.updatedAt ?? 0));
      setName(typeof attrs.get('name') === 'string' ? String(attrs.get('name')) : '');
      setDescription(typeof attrs.get('description') === 'string' ? String(attrs.get('description')) : '');
      setLinkedParts((partsResult.parts as LinkedPartRow[]) ?? []);
      setStatus('');
      dirtyRef.current = false;
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, [props.templateId]);

  async function saveCore() {
    if (!props.canEdit) return true;
    try {
      setStatus('Сохранение…');
      const templateResult = await window.matrica.parts.templates.get(props.templateId);
      if (!templateResult.ok) {
        setStatus(`Ошибка: ${templateResult.error}`);
        return false;
      }
      const attrs = new Map((templateResult.template.attributes as TemplateAttribute[]).map((row) => [row.code, row.value] as const));
      const currentName = typeof attrs.get('name') === 'string' ? String(attrs.get('name')) : '';
      const currentDescription = typeof attrs.get('description') === 'string' ? String(attrs.get('description')) : '';
      if (currentName !== name) {
        const updated = await window.matrica.parts.templates.updateAttribute({ templateId: props.templateId, attributeCode: 'name', value: name.trim() });
        if (!updated.ok) {
          setStatus(`Ошибка: ${updated.error}`);
          return false;
        }
      }
      if (currentDescription !== description) {
        const updated = await window.matrica.parts.templates.updateAttribute({
          templateId: props.templateId,
          attributeCode: 'description',
          value: description.trim() || null,
        });
        if (!updated.ok) {
          setStatus(`Ошибка: ${updated.error}`);
          return false;
        }
      }
      await load();
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 1200);
      dirtyRef.current = false;
      return true;
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
      return false;
    }
  }

  async function saveAllAndClose() {
    const ok = await saveCore();
    if (!ok) throw new Error('Не удалось сохранить деталь');
    return true;
  }

  async function handleDelete() {
    if (!props.canDelete) return;
    try {
      setStatus('Удаление…');
      const deleted = await window.matrica.parts.templates.delete(props.templateId);
      if (!deleted.ok) {
        setStatus(`Ошибка: ${deleted.error}`);
        return;
      }
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await saveAllAndClose();
      },
      reset: async () => {
        await load();
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      copyToNew: async () => {},
    });
    return () => {
      props.registerCardCloseActions?.(null);
    };
  }, [name, description, props.registerCardCloseActions]);

  return (
    <EntityCardShell
      title={title}
      layout="two-column"
      cardActions={
        <CardActionBar
          canEdit={props.canEdit}
          onSaveAndClose={
            props.canEdit
              ? () =>
                  void (async () => {
                    const saved = await saveAllAndClose();
                    if (saved) props.onClose();
                  })()
              : undefined
          }
          onReset={props.canEdit ? () => void load().then(() => { dirtyRef.current = false; }) : undefined}
          onDelete={props.canDelete ? () => void handleDelete() : undefined}
          deleteConfirmDetail={`Будет удалён шаблон детали из справочника: «${name.trim() || props.templateId}». Связанные данные могут остаться в базе с отвязкой — уточняйте у администратора.`}
          onClose={props.requestClose ? () => props.requestClose?.() : undefined}
        />
      }
      status={status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
    >
      <SectionCard title="Основное" style={{ borderRadius: 0, padding: 16 }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="card-row" style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center' }}>
            <div style={{ color: 'var(--subtle)' }}>Название</div>
            <Input
              value={name}
              disabled={!props.canEdit}
              onChange={(e) => {
                dirtyRef.current = true;
                setName(e.target.value);
              }}
            />
          </div>
          <div className="card-row" style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'start' }}>
            <div style={{ color: 'var(--subtle)', paddingTop: 10 }}>Описание</div>
            <textarea
              value={description}
              disabled={!props.canEdit}
              onChange={(e) => {
                dirtyRef.current = true;
                setDescription(e.target.value);
              }}
              style={{
                width: '100%',
                minHeight: 110,
                padding: '9px 12px',
                borderRadius: 0,
                border: '1px solid var(--input-border)',
                background: props.canEdit ? 'var(--input-bg)' : 'var(--input-bg-disabled)',
                color: 'var(--text)',
                resize: 'vertical',
              }}
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Реальные детали" style={{ borderRadius: 0, padding: 16 }}>
        <div style={{ display: 'grid', gap: 8 }}>
          {linkedParts.length === 0 ? (
            <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Пока не создано реальных деталей на основе этой записи.</div>
          ) : (
            linkedParts.map((row) => (
              <div
                key={row.id}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '10px 12px', border: '1px solid var(--border)' }}
              >
                <div>
                  <div style={{ color: 'var(--text)', fontSize: 14 }}>{row.name || '(без названия)'}</div>
                  <div style={{ color: 'var(--subtle)', fontSize: 12 }}>{row.article || 'Без сборочного номера / артикула'}</div>
                </div>
                <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenPart(row.id)}>
                  Открыть деталь
                </Button>
              </div>
            ))
          )}
        </div>
      </SectionCard>

      <SectionCard title="Карточка" style={{ borderRadius: 0, padding: 16 }}>
        <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
          <div>
            <span style={{ color: 'var(--text)' }}>ID:</span> {props.templateId}
          </div>
          <div style={{ marginTop: 6 }}>
            <span style={{ color: 'var(--text)' }}>Создано:</span> {createdAt ? formatMoscowDateTime(createdAt) : '—'}
          </div>
          <div style={{ marginTop: 6 }}>
            <span style={{ color: 'var(--text)' }}>Обновлено:</span> {updatedAt ? formatMoscowDateTime(updatedAt) : '—'}
          </div>
        </div>
      </SectionCard>
    </EntityCardShell>
  );
}
