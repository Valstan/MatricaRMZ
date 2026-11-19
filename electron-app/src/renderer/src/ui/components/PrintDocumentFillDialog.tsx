import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  parsePrintTemplateLayout,
  type PrintFormKindDef,
  type PrintTemplateRow,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';

type EmployeeOption = { id: string; login: string; label: string };

/**
 * Создание документа по печатной форме: вид документа → шаблон → заполнение полей.
 *
 * Документ сразу уходит в черновики: отправка — отдельное действие (приёмка между
 * операторами), чтобы автор мог переделать документ до отправки.
 */
export function PrintDocumentFillDialog(props: {
  kinds: readonly PrintFormKindDef[];
  templates: readonly PrintTemplateRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kindKey, setKindKey] = useState(props.kinds[0]?.key ?? 'document_service_note');
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [recipient, setRecipient] = useState('');
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const kind = useMemo(() => props.kinds.find((k) => k.key === kindKey) ?? null, [props.kinds, kindKey]);

  const kindTemplates = useMemo(
    () => props.templates.filter((t) => t.entityKey === kindKey),
    [props.templates, kindKey],
  );

  useEffect(() => {
    const first = kindTemplates[0];
    setTemplateId(first?.id ?? '');
  }, [kindTemplates]);

  useEffect(() => {
    let alive = true;
    void window.matrica.employees
      .list()
      .then((rows) => {
        if (!alive) return;
        setEmployees(
          (rows ?? [])
            .filter((r) => r.login)
            .map((r) => ({ id: String(r.id), login: String(r.login), label: String(r.fullName ?? r.login) })),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const template = useMemo(
    () => kindTemplates.find((t) => t.id === templateId) ?? null,
    [kindTemplates, templateId],
  );

  const layout = useMemo(
    () => parsePrintTemplateLayout(template?.layoutJson ?? ''),
    [template],
  );

  const setValue = useCallback((id: string, value: string) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  const save = useCallback(async () => {
    setError('');
    const docTitle = title.trim();
    if (!docTitle) {
      setError('Заголовок документа обязателен');
      return;
    }
    const recipientLogin = recipient.trim();
    if (!recipientLogin) {
      setError('Получатель обязателен — документ кому-то передаётся');
      return;
    }
    const employee = employees.find((e) => e.login === recipientLogin);
    setSubmitting(true);
    try {
      const res = await window.matrica.printForms.documents.create({
        entityKey: kindKey,
        formKey: kindKey,
        templateId: template?.id ?? null,
        title: docTitle,
        valuesJson: JSON.stringify(values),
        layoutJson: template?.layoutJson ?? '{}',
        recipientUsername: recipientLogin,
        recipientId: employee?.id ?? null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      props.onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }, [title, recipient, employees, values, kindKey, template, props]);

  const inputFields = kind?.inputFields ?? [];

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
          width: 'min(720px, 94vw)',
          maxHeight: '90vh',
          overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Новый документ</h3>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Вид документа</span>
            <select
              value={kindKey}
              onChange={(e) => {
                setKindKey(e.target.value as typeof kindKey);
                setValues({});
              }}
              style={{ padding: '4px 8px' }}
            >
              {props.kinds.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.title}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Печатная форма</span>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              style={{ padding: '4px 8px' }}
            >
              <option value="">Без формы — все пункты</option>
              {kindTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.ownerId === 'shared' ? 'общий' : 'личный'})
                </option>
              ))}
            </select>
          </label>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Заголовок документа</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="О чём документ" />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Получатель (логин оператора)</span>
          <Input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            list="print-document-employees"
            placeholder="логин"
          />
          <datalist id="print-document-employees">
            {employees.map((e) => (
              <option key={e.id} value={e.login}>
                {e.label}
              </option>
            ))}
          </datalist>
        </label>

        {inputFields.map((f) => (
          <label key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>{f.label}</span>
            {f.type === 'textarea' ? (
              <textarea
                value={values[f.id] ?? ''}
                onChange={(e) => setValue(f.id, e.target.value)}
                rows={5}
                style={{ width: '100%' }}
              />
            ) : (
              <Input value={values[f.id] ?? ''} onChange={(e) => setValue(f.id, e.target.value)} />
            )}
          </label>
        ))}

        {layout.headerNote ? (
          <div style={{ fontSize: 11, color: 'var(--subtle)', marginBottom: 8 }}>
            Примечание формы: {layout.headerNote}
          </div>
        ) : null}

        {error ? (
          <div style={{ color: 'var(--danger, #b91c1c)', marginTop: 8, fontSize: 12 }}>{error}</div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <Button onClick={props.onClose} disabled={submitting}>
            Отмена
          </Button>
          <Button onClick={() => void save()} disabled={submitting}>
            {submitting ? 'Создаём…' : 'Создать черновик'}
          </Button>
        </div>
      </div>
    </div>
  );
}
