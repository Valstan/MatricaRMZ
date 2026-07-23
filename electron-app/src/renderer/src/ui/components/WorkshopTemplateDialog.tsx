import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { WorkshopRepairTemplateDto, WorkshopRepairTemplateSummary } from '@matricarmz/shared';

import { Button } from './Button.js';
import { EntityReferenceField } from './EntityReferenceField.js';
import { Input } from './Input.js';
import type { SearchSelectOption } from './SearchSelect.js';

type EditorLine = {
  /** local-only id for React keys / remove. */
  id: string;
  nomenclatureId: string;
  unit: string;
  /** Empty string means "not specified" — saved as undefined. */
  defaultQtyText: string;
  /** Empty string means "no service" — saved as undefined. */
  serviceId: string;
};

type EditorState = {
  /** null for an unsaved new template. */
  templateId: string | null;
  name: string;
  lines: EditorLine[];
  dirty: boolean;
};

function freshLine(): EditorLine {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    nomenclatureId: '',
    unit: 'шт',
    defaultQtyText: '',
    serviceId: '',
  };
}

function templateToEditor(t: WorkshopRepairTemplateDto): EditorState {
  return {
    templateId: t.id,
    name: t.name,
    lines: t.lines.map((row) => ({
      id: `loaded-${row.nomenclatureId}-${Math.random().toString(36).slice(2, 8)}`,
      nomenclatureId: row.nomenclatureId,
      unit: row.unit,
      defaultQtyText: row.defaultQty != null ? String(row.defaultQty) : '',
      serviceId: row.serviceId ?? '',
    })),
    dirty: false,
  };
}

/**
 * Per-workshop repair template editor with multi-template CRUD (v1.27.0).
 * Left panel: list of templates with [+ Новый] / [Удалить]. Right panel: editor
 * for the selected template (name + lines, save as POST or PUT depending on
 * whether templateId is set).
 *
 * Backend permission `workshop_repair_templates.edit` gates POST/PUT/DELETE;
 * the server still enforces it independently.
 */
export function WorkshopTemplateDialog(props: {
  open: boolean;
  onClose: () => void;
  workshopId: string;
  workshopName: string;
  canEdit: boolean;
  onSaved?: () => void;
}) {
  const [templates, setTemplates] = useState<WorkshopRepairTemplateSummary[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [nomen, setNomen] = useState<SearchSelectOption[]>([]);
  const [nomenLoading, setNomenLoading] = useState(false);
  const [services, setServices] = useState<SearchSelectOption[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState('');

  const reloadList = useCallback(async () => {
    setListLoading(true);
    try {
      const r = await window.matrica.workshops.listRepairTemplates(props.workshopId);
      if (r?.ok) {
        setTemplates(r.templates as WorkshopRepairTemplateSummary[]);
      } else {
        setStatus(`Ошибка загрузки списка шаблонов: ${r?.error ?? 'unknown'}`);
      }
    } finally {
      setListLoading(false);
    }
  }, [props.workshopId]);

  useEffect(() => {
    if (!props.open) return;
    setStatus('');
    setEditor(null);
    void reloadList();
  }, [props.open, props.workshopId, reloadList]);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setNomenLoading(true);
    (async () => {
      try {
        const r = await window.matrica.warehouse.nomenclatureList({ limit: 5000 });
        if (cancelled) return;
        if (r?.ok && Array.isArray(r.rows)) {
          const opts: SearchSelectOption[] = r.rows
            .map((row: Record<string, unknown>) => {
              const id = String(row.id ?? '');
              const code = String(row.code ?? '').trim();
              const name = String(row.name ?? '').trim();
              const label = code ? `${code} — ${name}` : name;
              return { id, label, searchText: `${code} ${name}` };
            })
            .filter((o) => o.id);
          setNomen(opts);
        }
      } finally {
        if (!cancelled) setNomenLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  // Услуги в шаблоне грузим из admin.entities (EAV) — это **то же пространство id**,
  // что и dropdown «Вид работ» в WorkOrderDetailsPage. В v1.27.0 dialog
  // использовал nomenclatureList → разные id, autofill серviceId в наряд не
  // срабатывал (serviceById.get → undefined). Hotfix 1.27.1.
  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setServicesLoading(true);
    (async () => {
      try {
        const types = await window.matrica.admin.entityTypes.list().catch(() => [] as any[]);
        const serviceType = (types as any[]).find((x) => String(x.code) === 'service');
        if (!serviceType?.id) {
          if (!cancelled) setServices([]);
          return;
        }
        const list = await window.matrica.admin.entities
          .listByEntityType(String(serviceType.id))
          .catch(() => [] as any[]);
        if (cancelled) return;
        const details = await Promise.all(
          (list as any[]).slice(0, 2000).map(async (row) => {
            const d = await window.matrica.admin.entities.get(String(row.id)).catch(() => null);
            const attrs = (d as any)?.attributes ?? {};
            const id = String(row.id);
            const name = String(attrs.name || row.displayName || row.id);
            return { id, label: name, searchText: name };
          }),
        );
        if (cancelled) return;
        setServices(details.filter((o) => o.id && o.label.trim().length > 0));
      } finally {
        if (!cancelled) setServicesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  const duplicateIds = useMemo(() => {
    if (!editor) return new Set<string>();
    const seen = new Map<string, number>();
    for (const l of editor.lines) {
      if (!l.nomenclatureId) continue;
      seen.set(l.nomenclatureId, (seen.get(l.nomenclatureId) ?? 0) + 1);
    }
    return new Set(Array.from(seen.entries()).filter(([, n]) => n > 1).map(([id]) => id));
  }, [editor]);

  async function confirmDiscardDirty(): Promise<boolean> {
    if (!editor?.dirty) return true;
    return window.confirm('В текущем шаблоне есть несохранённые изменения. Отбросить?');
  }

  async function selectTemplate(templateId: string) {
    if (!(await confirmDiscardDirty())) return;
    setStatus('');
    setEditorLoading(true);
    try {
      const r = await window.matrica.workshops.getRepairTemplateById({ workshopId: props.workshopId, templateId });
      if (!r?.ok) {
        setStatus(`Ошибка загрузки шаблона: ${r?.error ?? 'unknown'}`);
        return;
      }
      setEditor(templateToEditor(r.template as WorkshopRepairTemplateDto));
    } finally {
      setEditorLoading(false);
    }
  }

  async function newTemplate() {
    if (!props.canEdit) return;
    if (!(await confirmDiscardDirty())) return;
    setStatus('');
    setEditor({
      templateId: null,
      name: '',
      lines: [],
      dirty: false,
    });
  }

  async function removeTemplate(templateId: string, name: string) {
    if (!props.canEdit) return;
    const ok = window.confirm(`Удалить шаблон «${name}»? Действие необратимо.`);
    if (!ok) return;
    setSubmitting(true);
    setStatus('');
    try {
      const r = await window.matrica.workshops.deleteRepairTemplate({ workshopId: props.workshopId, templateId });
      if (!r?.ok) {
        setStatus(`Ошибка удаления: ${r?.error ?? 'unknown'}`);
        return;
      }
      if (editor?.templateId === templateId) setEditor(null);
      setStatus(`Шаблон «${name}» удалён.`);
      props.onSaved?.();
      await reloadList();
    } finally {
      setSubmitting(false);
    }
  }

  function patchEditor(patch: Partial<EditorState>) {
    setEditor((prev) => (prev ? { ...prev, ...patch, dirty: true } : prev));
  }

  function addLine() {
    if (!editor) return;
    patchEditor({ lines: [...editor.lines, freshLine()] });
  }
  function patchLine(id: string, patch: Partial<EditorLine>) {
    if (!editor) return;
    patchEditor({ lines: editor.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  }
  function removeLine(id: string) {
    if (!editor) return;
    patchEditor({ lines: editor.lines.filter((l) => l.id !== id) });
  }
  function moveLine(id: string, dir: -1 | 1) {
    if (!editor) return;
    const idx = editor.lines.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const next = idx + dir;
    if (next < 0 || next >= editor.lines.length) return;
    const copy = [...editor.lines];
    const [item] = copy.splice(idx, 1);
    if (item) copy.splice(next, 0, item);
    patchEditor({ lines: copy });
  }

  async function save() {
    if (!editor || !props.canEdit) return;
    setStatus('');
    const trimmedName = editor.name.trim();
    if (!trimmedName) {
      setStatus('Укажите имя шаблона.');
      return;
    }
    if (duplicateIds.size > 0) {
      setStatus('Ошибка: одна и та же номенклатура встречается несколько раз. Удалите дубликаты.');
      return;
    }
    for (let i = 0; i < editor.lines.length; i++) {
      const l = editor.lines[i]!;
      if (!l.nomenclatureId) {
        setStatus(`Строка ${i + 1}: выберите номенклатуру или удалите строку.`);
        return;
      }
      if (!l.unit.trim()) {
        setStatus(`Строка ${i + 1}: укажите единицу измерения.`);
        return;
      }
      if (l.defaultQtyText.trim()) {
        const qty = Number(l.defaultQtyText);
        if (!Number.isFinite(qty) || qty < 0) {
          setStatus(`Строка ${i + 1}: количество должно быть числом ≥ 0 или пустым.`);
          return;
        }
      }
    }
    const payloadLines = editor.lines.map((l) => {
      const trimmedQty = l.defaultQtyText.trim();
      const base: { nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string } = {
        nomenclatureId: l.nomenclatureId,
        unit: l.unit.trim(),
      };
      if (trimmedQty) {
        const qty = Number(trimmedQty);
        if (qty > 0) base.defaultQty = qty;
      }
      if (l.serviceId) base.serviceId = l.serviceId;
      return base;
    });
    setSubmitting(true);
    try {
      if (editor.templateId === null) {
        const r = await window.matrica.workshops.createRepairTemplate({
          workshopId: props.workshopId,
          name: trimmedName,
          lines: payloadLines,
        });
        if (!r?.ok) {
          setStatus(`Ошибка создания: ${r?.error ?? 'unknown'}`);
          return;
        }
        setStatus(`Создан шаблон «${trimmedName}» (${payloadLines.length} строк).`);
        setEditor(templateToEditor(r.template as WorkshopRepairTemplateDto));
      } else {
        const r = await window.matrica.workshops.updateRepairTemplate({
          workshopId: props.workshopId,
          templateId: editor.templateId,
          name: trimmedName,
          lines: payloadLines,
        });
        if (!r?.ok) {
          setStatus(`Ошибка сохранения: ${r?.error ?? 'unknown'}`);
          return;
        }
        setStatus(`Сохранён шаблон «${trimmedName}» (${payloadLines.length} строк).`);
        setEditor(templateToEditor(r.template as WorkshopRepairTemplateDto));
      }
      props.onSaved?.();
      await reloadList();
    } finally {
      setSubmitting(false);
    }
  }

  if (!props.open) return null;

  const selectedId = editor?.templateId ?? null;

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
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)',
          padding: 20,
          borderRadius: 10,
          maxWidth: 'min(98vw, 1200px)',
          width: '98vw',
          maxHeight: '94vh',
          overflow: 'auto',
          border: '1px solid var(--border)',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Шаблоны ремонта — {props.workshopName}</h3>
          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
            Используются для автозаполнения нарядов «Ремонт по шаблону цеха»
          </span>
        </div>

        {!props.canEdit ? (
          <div style={{ color: 'var(--subtle)', marginBottom: 8 }}>
            Только просмотр. Для редактирования шаблонов нужно право «Редактирование шаблонов ремонта цехов» (admin).
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

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ width: 280, flex: '0 0 auto', borderRight: '1px solid var(--border)', paddingRight: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong>Шаблоны цеха</strong>
              <Button
                size="sm"
                disabled={!props.canEdit || submitting}
                onClick={() => void newTemplate()}
                title="Создать новый шаблон"
              >
                + Новый
              </Button>
            </div>
            {listLoading ? (
              <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Загрузка списка…</div>
            ) : templates.length === 0 ? (
              <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Шаблонов ещё нет. Нажмите «+ Новый».</div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {templates.map((t) => {
                  const isSelected = t.id === selectedId;
                  return (
                    <li
                      key={t.id}
                      style={{
                        padding: '6px 8px',
                        marginBottom: 4,
                        borderRadius: 6,
                        cursor: submitting ? 'wait' : 'pointer',
                        background: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
                        border: `1px solid ${isSelected ? 'rgba(59, 130, 246, 0.45)' : 'transparent'}`,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 6,
                      }}
                      onClick={() => {
                        if (!submitting) void selectTemplate(t.id);
                      }}
                    >
                      <div style={{ overflow: 'hidden' }}>
                        <div style={{ fontWeight: isSelected ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {t.name}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--subtle)' }}>{t.lineCount} строк</div>
                      </div>
                      {props.canEdit ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={submitting}
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeTemplate(t.id, t.name);
                          }}
                          title="Удалить шаблон"
                        >
                          ✕
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {!editor ? (
              <div style={{ color: 'var(--subtle)', padding: 20, textAlign: 'center' }}>
                {templates.length === 0
                  ? 'Создайте новый шаблон через «+ Новый».'
                  : 'Выберите шаблон слева или создайте новый.'}
              </div>
            ) : editorLoading ? (
              <div style={{ color: 'var(--subtle)' }}>Загрузка шаблона…</div>
            ) : (
              <>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, color: 'var(--subtle)' }}>Имя шаблона</label>
                  <Input
                    value={editor.name}
                    disabled={!props.canEdit || submitting}
                    onChange={(e) => patchEditor({ name: e.target.value })}
                    placeholder="напр. «Базовый», «Капремонт», «ТО-1»"
                    style={{ width: '100%' }}
                  />
                </div>

                <table className="list-table" style={{ width: '100%', marginBottom: 8 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>№</th>
                      <th style={{ minWidth: 250 }}>Деталь</th>
                      <th style={{ width: 80 }}>Ед.</th>
                      <th style={{ width: 90, textAlign: 'right' }}>По умолч.</th>
                      <th style={{ minWidth: 180 }}>Вид работы</th>
                      <th style={{ width: 130 }}>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editor.lines.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                          Шаблон пуст. {props.canEdit ? 'Нажмите «+ Добавить строку».' : ''}
                        </td>
                      </tr>
                    ) : (
                      editor.lines.map((line, idx) => {
                        const isDup = duplicateIds.has(line.nomenclatureId);
                        return (
                          <tr key={line.id} style={isDup ? { background: 'rgba(220, 38, 38, 0.08)' } : undefined}>
                            <td>{idx + 1}</td>
                            <td>
                              <EntityReferenceField
                                target="nomenclature"
                                targetLabel="Номенклатура"
                                value={line.nomenclatureId || null}
                                options={nomen}
                                optionsReady={!nomenLoading}
                                placeholder={nomenLoading ? 'Загрузка…' : 'Выберите деталь'}
                                disabled={!props.canEdit || submitting}
                                showAllWhenEmpty
                                emptyQueryLimit={50}
                                onChange={(next) => patchLine(line.id, { nomenclatureId: next ?? '' })}
                              />
                              {isDup ? (
                                <div style={{ color: 'var(--danger, #b91c1c)', fontSize: 11 }}>Дубликат детали</div>
                              ) : null}
                            </td>
                            <td>
                              <Input
                                value={line.unit}
                                disabled={!props.canEdit || submitting}
                                onChange={(e) => patchLine(line.id, { unit: e.target.value })}
                                style={{ width: '100%' }}
                              />
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <Input
                                type="number"
                                value={line.defaultQtyText}
                                disabled={!props.canEdit || submitting}
                                onChange={(e) => patchLine(line.id, { defaultQtyText: e.target.value })}
                                style={{ width: 90, textAlign: 'right' }}
                                placeholder=""
                              />
                            </td>
                            <td>
                              <EntityReferenceField
                                target="service"
                                targetLabel="Услуга"
                                value={line.serviceId || null}
                                options={services}
                                optionsReady={!servicesLoading}
                                placeholder={servicesLoading ? 'Загрузка услуг…' : 'Не задан'}
                                disabled={!props.canEdit || submitting}
                                showAllWhenEmpty
                                emptyQueryLimit={50}
                                onChange={(next) => patchLine(line.id, { serviceId: next ?? '' })}
                              />
                            </td>
                            <td>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!props.canEdit || submitting || idx === 0}
                                onClick={() => moveLine(line.id, -1)}
                                title="Выше"
                              >
                                ↑
                              </Button>{' '}
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!props.canEdit || submitting || idx === editor.lines.length - 1}
                                onClick={() => moveLine(line.id, 1)}
                                title="Ниже"
                              >
                                ↓
                              </Button>{' '}
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!props.canEdit || submitting}
                                onClick={() => removeLine(line.id)}
                              >
                                ✕
                              </Button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Button onClick={addLine} disabled={!props.canEdit || submitting}>
                    + Добавить строку
                  </Button>
                  <Button
                    onClick={() => void save()}
                    disabled={!props.canEdit || submitting || (editor.templateId !== null && !editor.dirty)}
                  >
                    {submitting ? 'Сохраняю…' : editor.templateId === null ? 'Создать' : editor.dirty ? 'Сохранить' : 'Сохранено'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <Button variant="ghost" onClick={props.onClose} disabled={submitting}>
            Закрыть
          </Button>
        </div>
      </div>
    </div>
  );
}
