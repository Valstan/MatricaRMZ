import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  UNHIDABLE_FIELDS_BY_KIND,
  WORK_ORDER_KIND_LABELS,
  WORK_ORDER_SIGNATURE_CAPTION_SUGGESTIONS,
  WORK_ORDER_TEMPLATE_KINDS,
  WORK_ORDER_TEMPLATE_NAME_MAX,
  WorkOrderKind,
  getWorkOrderSignatureBlocks,
  isHidableField,
  resolveWorkOrderSignatureSlots,
  workOrderSignatureBlockAliases,
  type WorkOrderSignatureBlockSelection,
  type WorkOrderSignatureSlot,
  type WorkOrderTemplateDto,
  type WorkOrderTemplateLine,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { RowReorderButtons } from './RowReorderButtons.js';
import { SearchSelect, type SearchSelectOption } from './SearchSelect.js';
import { moveArrayItem } from '../utils/moveArrayItem.js';

type EditorLine = {
  id: string;
  nomenclatureId: string;
  serviceId: string;
  unit: string;
  defaultQtyText: string;
  productNumber: string;
  engineNumber: string;
};

type EditorState = {
  templateId: string | null;
  workOrderKind: WorkOrderKind;
  name: string;
  /** Структурный цех — кладётся в payloadOverrides.workshopId при сохранении. */
  workshopId: string;
  /** Структурная конфигурация подписей — payloadOverrides.signatureBlocks при сохранении. */
  signatureBlocks: WorkOrderSignatureBlockSelection[];
  /** «Сырые» прочие overrides (без workshopId/signatureBlocks — те редактируются структурно). */
  payloadOverridesText: string;
  hiddenFields: Set<string>;
  lines: EditorLine[];
  dirty: boolean;
};

/** Ключи payloadOverrides, которые редактируются структурно (не через JSON-textarea). */
const STRUCTURED_OVERRIDE_KEYS = ['workshopId', 'signatureBlocks'];

function stripStructuredOverrides(overrides: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!STRUCTURED_OVERRIDE_KEYS.includes(k)) rest[k] = v;
  }
  return rest;
}

function normalizeTemplateSignatureBlocks(raw: unknown): WorkOrderSignatureBlockSelection[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkOrderSignatureBlockSelection[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const blockId = String((b as { blockId?: unknown }).blockId ?? '').trim();
    const slotsRaw = (b as { slots?: unknown }).slots;
    if (!blockId || !Array.isArray(slotsRaw)) continue;
    const slots: WorkOrderSignatureSlot[] = [];
    for (const s of slotsRaw) {
      if (!s || typeof s !== 'object') continue;
      const caption = String((s as { caption?: unknown }).caption ?? '').trim();
      const employeeId = String((s as { employeeId?: unknown }).employeeId ?? '').trim();
      const slot: WorkOrderSignatureSlot = {};
      if (caption) slot.caption = caption;
      if (employeeId) slot.employeeId = employeeId;
      slots.push(slot);
    }
    out.push({ blockId, slots });
  }
  return out;
}

const HIDABLE_FIELD_CATALOG: Record<WorkOrderKind, Array<{ key: string; label: string }>> = {
  [WorkOrderKind.Regular]: [
    { key: 'workshopId', label: 'Цех' },
    { key: 'engineId', label: 'Двигатель' },
    { key: 'engineNumber', label: '№ двигателя' },
    { key: 'engineBrandId', label: 'Марка двигателя' },
    { key: 'engineBrandName', label: 'Название марки' },
    { key: 'productNumber', label: '№ изделия' },
    { key: 'serviceName', label: 'Вид работ' },
    { key: 'priceRub', label: 'Цена' },
    { key: 'amountRub', label: 'Сумма' },
  ],
  [WorkOrderKind.Repair]: [
    { key: 'engineId', label: 'Двигатель' },
    { key: 'engineNumber', label: '№ двигателя' },
    { key: 'engineBrandId', label: 'Марка двигателя' },
    { key: 'engineBrandName', label: 'Название марки' },
    { key: 'productNumber', label: '№ изделия' },
    { key: 'serviceName', label: 'Вид работ' },
    { key: 'priceRub', label: 'Цена' },
    { key: 'amountRub', label: 'Сумма' },
  ],
  [WorkOrderKind.Assembly]: [
    { key: 'engineNumber', label: '№ двигателя' },
    { key: 'engineBrandName', label: 'Название марки' },
    { key: 'productNumber', label: '№ изделия' },
    { key: 'serviceName', label: 'Вид работ' },
    { key: 'priceRub', label: 'Цена' },
    { key: 'amountRub', label: 'Сумма' },
  ],
  [WorkOrderKind.Manufacturing]: [
    { key: 'engineId', label: 'Двигатель' },
    { key: 'engineNumber', label: '№ двигателя' },
    { key: 'engineBrandId', label: 'Марка двигателя' },
    { key: 'engineBrandName', label: 'Название марки' },
    { key: 'productNumber', label: '№ изделия' },
    { key: 'serviceName', label: 'Вид работ' },
    { key: 'priceRub', label: 'Цена' },
    { key: 'amountRub', label: 'Сумма' },
  ],
  [WorkOrderKind.WorkshopTemplate]: [],
};

function freshLine(): EditorLine {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    nomenclatureId: '',
    serviceId: '',
    unit: 'шт',
    defaultQtyText: '',
    productNumber: '',
    engineNumber: '',
  };
}

function templateToEditor(t: WorkOrderTemplateDto): EditorState {
  const overrides = (t.payloadOverrides ?? {}) as Record<string, unknown>;
  const rest = stripStructuredOverrides(overrides);
  return {
    templateId: t.id,
    workOrderKind: t.workOrderKind,
    name: t.name,
    workshopId: String(overrides.workshopId ?? '').trim(),
    signatureBlocks: normalizeTemplateSignatureBlocks(overrides.signatureBlocks),
    payloadOverridesText: Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : '',
    hiddenFields: new Set(t.hiddenFields),
    lines: t.lines.map((row, idx) => ({
      id: `loaded-${idx}-${Math.random().toString(36).slice(2, 8)}`,
      nomenclatureId: row.nomenclatureId ?? '',
      serviceId: row.serviceId ?? '',
      unit: row.unit ?? 'шт',
      defaultQtyText: row.defaultQty != null ? String(row.defaultQty) : '',
      productNumber: row.productNumber ?? '',
      engineNumber: row.engineNumber ?? '',
    })),
    dirty: false,
  };
}

function newEditor(kind: WorkOrderKind): EditorState {
  return {
    templateId: null,
    workOrderKind: kind,
    name: '',
    workshopId: '',
    signatureBlocks: [],
    payloadOverridesText: '',
    hiddenFields: new Set<string>(),
    lines: [],
    dirty: false,
  };
}

export type WorkOrderTemplateEditorDialogProps = {
  open: boolean;
  /** When set, editor opens for this existing template. When null, creates a new one. */
  templateId: string | null;
  /** Default kind for a new template. Ignored when templateId is set (taken from loaded template). */
  defaultKind: WorkOrderKind;
  canEdit: boolean;
  onClose: () => void;
  onSaved?: (template: WorkOrderTemplateDto) => void;
};

/**
 * Editor для одного шаблона наряда. Создание (templateId=null) или редактирование
 * существующего (templateId=string). Workshop-список нагружен в родительской странице,
 * этот диалог отвечает только за один шаблон.
 */
export function WorkOrderTemplateEditorDialog(props: WorkOrderTemplateEditorDialogProps) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [nomen, setNomen] = useState<SearchSelectOption[]>([]);
  const [nomenLoading, setNomenLoading] = useState(false);
  const [services, setServices] = useState<SearchSelectOption[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [workshops, setWorkshops] = useState<SearchSelectOption[]>([]);
  const [employees, setEmployees] = useState<SearchSelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setStatus('');
    let cancelled = false;
    (async () => {
      if (props.templateId === null) {
        setEditor(newEditor(props.defaultKind));
        return;
      }
      setLoading(true);
      try {
        const r = await window.matrica.workOrderTemplates.get(props.templateId);
        if (cancelled) return;
        if (!r?.ok) {
          setStatus(`Ошибка загрузки шаблона: ${r?.error ?? 'unknown'}`);
          setEditor(null);
          return;
        }
        setEditor(templateToEditor(r.template));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open, props.templateId, props.defaultKind]);

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

  // Цехи и сотрудники — для структурных редакторов «цех» и «подписи».
  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    (async () => {
      const [ws, emps] = await Promise.all([
        window.matrica.workshops.list({ activeOnly: true }).catch(() => null),
        window.matrica.employees.list().catch(() => [] as Array<Record<string, unknown>>),
      ]);
      if (cancelled) return;
      if (ws?.ok && Array.isArray(ws.rows)) {
        setWorkshops(
          ws.rows
            .map((r) => ({ id: String(r.id), label: String(r.name || r.code || r.id), searchText: `${r.code ?? ''} ${r.name ?? ''}` }))
            .filter((o) => o.id),
        );
      }
      setEmployees(
        (emps as Array<Record<string, unknown>>)
          .map((e) => {
            const id = String(e.id ?? '');
            const label = String(e.displayName || e.fullName || e.id || '').trim();
            return { id, label, searchText: label };
          })
          .filter((o) => o.id && o.label),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  const duplicateLineKeys = useMemo(() => {
    if (!editor) return new Set<string>();
    const seen = new Map<string, number>();
    for (const l of editor.lines) {
      const key = `${l.nomenclatureId}|${l.serviceId}`;
      if (!l.nomenclatureId && !l.serviceId) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return new Set(Array.from(seen.entries()).filter(([, n]) => n > 1).map(([k]) => k));
  }, [editor]);

  const patchEditor = useCallback((patch: Partial<EditorState>) => {
    setEditor((prev) => (prev ? { ...prev, ...patch, dirty: true } : prev));
  }, []);

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
  function toggleHidden(key: string) {
    if (!editor) return;
    const set = new Set(editor.hiddenFields);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    patchEditor({ hiddenFields: set });
  }
  function setTemplateSignatureSlots(blockId: string, slots: WorkOrderSignatureSlot[]) {
    if (!editor) return;
    const aliases = workOrderSignatureBlockAliases(blockId);
    const others = editor.signatureBlocks.filter((b) => !aliases.includes(b.blockId));
    const next: WorkOrderSignatureBlockSelection[] = slots.length ? [...others, { blockId, slots }] : others;
    patchEditor({ signatureBlocks: next });
  }

  async function save() {
    if (!editor || !props.canEdit) return;
    setStatus('');
    const trimmedName = editor.name.trim();
    if (!trimmedName) {
      setStatus('Укажите имя шаблона.');
      return;
    }
    if (trimmedName.length > WORK_ORDER_TEMPLATE_NAME_MAX) {
      setStatus(`Имя шаблона не должно превышать ${WORK_ORDER_TEMPLATE_NAME_MAX} символов.`);
      return;
    }
    if (duplicateLineKeys.size > 0) {
      setStatus('Ошибка: одна и та же пара (деталь+услуга) встречается несколько раз. Удалите дубликаты.');
      return;
    }
    for (let i = 0; i < editor.lines.length; i++) {
      const l = editor.lines[i]!;
      if (!l.nomenclatureId && !l.serviceId) {
        setStatus(`Строка ${i + 1}: укажите деталь или вид работы.`);
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

    let merged: Record<string, unknown> = {};
    const overridesText = editor.payloadOverridesText.trim();
    if (overridesText) {
      try {
        const parsed = JSON.parse(overridesText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setStatus('payloadOverrides должно быть JSON-объектом.');
          return;
        }
        merged = stripStructuredOverrides(parsed as Record<string, unknown>);
      } catch (e) {
        setStatus(`Невалидный JSON в payloadOverrides: ${String(e)}`);
        return;
      }
    }
    // Структурные поля (цех / подписи) кладём в overrides — apply делает Object.assign в payload.
    if (editor.workshopId.trim()) merged.workshopId = editor.workshopId.trim();
    const cleanedSignatureBlocks = editor.signatureBlocks
      .map((b) => ({
        blockId: b.blockId,
        slots: b.slots
          .map((s) => {
            const slot: WorkOrderSignatureSlot = {};
            if (s.caption?.trim()) slot.caption = s.caption.trim();
            if (s.employeeId) slot.employeeId = s.employeeId;
            return slot;
          })
          .filter((s) => s.caption || s.employeeId),
      }))
      .filter((b) => b.slots.length > 0);
    if (cleanedSignatureBlocks.length > 0) merged.signatureBlocks = cleanedSignatureBlocks;
    const payloadOverrides: Record<string, unknown> | undefined =
      Object.keys(merged).length > 0 ? merged : undefined;

    const hiddenFields = Array.from(editor.hiddenFields).filter((key) =>
      isHidableField(editor.workOrderKind, key),
    );

    const payloadLines: WorkOrderTemplateLine[] = editor.lines.map((l) => {
      const line: WorkOrderTemplateLine = {};
      if (l.nomenclatureId) line.nomenclatureId = l.nomenclatureId;
      if (l.serviceId) line.serviceId = l.serviceId;
      if (l.unit.trim()) line.unit = l.unit.trim();
      const qtyText = l.defaultQtyText.trim();
      if (qtyText) {
        const qty = Number(qtyText);
        if (qty > 0) line.defaultQty = qty;
      }
      if (l.productNumber.trim()) line.productNumber = l.productNumber.trim();
      if (l.engineNumber.trim()) line.engineNumber = l.engineNumber.trim();
      return line;
    });

    setSubmitting(true);
    try {
      if (editor.templateId === null) {
        const r = await window.matrica.workOrderTemplates.create({
          workOrderKind: editor.workOrderKind,
          name: trimmedName,
          ...(payloadOverrides !== undefined ? { payloadOverrides } : {}),
          hiddenFields,
          lines: payloadLines,
        });
        if (!r?.ok) {
          setStatus(`Ошибка создания: ${r?.error ?? 'unknown'}`);
          return;
        }
        setStatus(`Создан шаблон «${trimmedName}» (${payloadLines.length} строк).`);
        setEditor(templateToEditor(r.template));
        props.onSaved?.(r.template);
      } else {
        const r = await window.matrica.workOrderTemplates.update({
          id: editor.templateId,
          name: trimmedName,
          ...(payloadOverrides !== undefined ? { payloadOverrides } : {}),
          hiddenFields,
          lines: payloadLines,
        });
        if (!r?.ok) {
          setStatus(`Ошибка сохранения: ${r?.error ?? 'unknown'}`);
          return;
        }
        setStatus(`Сохранён шаблон «${trimmedName}» (${payloadLines.length} строк).`);
        setEditor(templateToEditor(r.template));
        props.onSaved?.(r.template);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!props.open) return null;

  const kindOptions: SearchSelectOption[] = WORK_ORDER_TEMPLATE_KINDS.map((k) => ({
    id: k,
    label: WORK_ORDER_KIND_LABELS[k],
    searchText: WORK_ORDER_KIND_LABELS[k],
  }));

  const unhidable = editor ? UNHIDABLE_FIELDS_BY_KIND[editor.workOrderKind] : [];
  const hidableCatalog = editor ? HIDABLE_FIELD_CATALOG[editor.workOrderKind] ?? [] : [];

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
          <h3 style={{ margin: 0 }}>
            {editor?.templateId ? 'Редактирование шаблона наряда' : 'Новый шаблон наряда'}
          </h3>
          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
            Применяется при создании наряда по шаблону
          </span>
        </div>

        {!props.canEdit ? (
          <div style={{ color: 'var(--subtle)', marginBottom: 8 }}>
            Только просмотр. Для редактирования нужно право «Редактирование шаблонов нарядов».
          </div>
        ) : null}

        {status ? (
          <div
            style={{
              color: status.startsWith('Ошибка') || status.startsWith('Невалидный') ? 'var(--danger, #b91c1c)' : 'var(--success, #047857)',
              marginBottom: 8,
            }}
          >
            {status}
          </div>
        ) : null}

        {loading ? (
          <div style={{ color: 'var(--subtle)' }}>Загрузка шаблона…</div>
        ) : !editor ? (
          <div style={{ color: 'var(--subtle)' }}>Шаблон не найден.</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--subtle)' }}>Тип наряда</label>
                <SearchSelect
                  value={editor.workOrderKind}
                  options={kindOptions}
                  disabled={editor.templateId !== null || !props.canEdit || submitting}
                  onChange={(next) => {
                    if (!next) return;
                    patchEditor({ workOrderKind: next as WorkOrderKind, hiddenFields: new Set<string>() });
                  }}
                />
                {editor.templateId !== null ? (
                  <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 2 }}>
                    Тип шаблона нельзя сменить после создания.
                  </div>
                ) : null}
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--subtle)' }}>
                  Имя шаблона (до {WORK_ORDER_TEMPLATE_NAME_MAX})
                </label>
                <Input
                  value={editor.name}
                  disabled={!props.canEdit || submitting}
                  onChange={(e) => patchEditor({ name: e.target.value })}
                  placeholder="напр. «Цех 4 — стандартный ремонт»"
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--subtle)' }}>Цех (где взять деталь)</label>
              <div style={{ maxWidth: 'calc(50% - 6px)' }}>
                <SearchSelect
                  value={editor.workshopId || null}
                  options={workshops}
                  placeholder="Не задан"
                  disabled={!props.canEdit || submitting}
                  onChange={(next) => patchEditor({ workshopId: next ?? '' })}
                />
              </div>
              <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 2 }}>
                Подставится в наряд при применении шаблона (где лежит/берётся деталь).
              </div>
            </div>

            <div style={{ marginBottom: 12, padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Подписи шаблона</div>
              <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 8 }}>
                Заданные роли и сотрудники подставятся в блок подписей наряда при применении шаблона. Сотрудник необязателен — пустой слот печатается под подпись от руки. Если ничего не менять, наряд использует свои подписи по умолчанию.
              </div>
              <datalist id="wo-template-signature-captions">
                {WORK_ORDER_SIGNATURE_CAPTION_SUGGESTIONS.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              {getWorkOrderSignatureBlocks(editor.workOrderKind).map((block) => {
                const slots = resolveWorkOrderSignatureSlots(block, editor.signatureBlocks);
                const setSlot = (idx: number, key: 'caption' | 'employeeId', value: string) => {
                  const next = slots.map((s, j) => {
                    if (j !== idx) return s;
                    const caption = key === 'caption' ? value : s.caption ?? '';
                    const employeeId = key === 'employeeId' ? value : s.employeeId ?? '';
                    const slot: WorkOrderSignatureSlot = {};
                    if (caption) slot.caption = caption;
                    if (employeeId) slot.employeeId = employeeId;
                    return slot;
                  });
                  setTemplateSignatureSlots(block.id, next);
                };
                return (
                  <div key={block.id} style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{block.title}</div>
                    {slots.map((slot, idx) => (
                      <div
                        key={`${block.id}-${idx}`}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(140px, 0.7fr) minmax(200px, 1.4fr) auto auto',
                          gap: 8,
                          alignItems: 'center',
                        }}
                      >
                        <Input
                          list="wo-template-signature-captions"
                          value={slot.caption ?? ''}
                          disabled={!props.canEdit || submitting}
                          placeholder="Роль"
                          onChange={(e) => setSlot(idx, 'caption', e.target.value)}
                        />
                        <SearchSelect
                          value={slot.employeeId || null}
                          options={employees}
                          placeholder="Сотрудник (необязательно)"
                          disabled={!props.canEdit || submitting}
                          onChange={(next) => setSlot(idx, 'employeeId', next ?? '')}
                        />
                        {props.canEdit ? (
                          <RowReorderButtons
                            canMoveUp={idx > 0}
                            canMoveDown={idx < slots.length - 1}
                            onMoveUp={() => setTemplateSignatureSlots(block.id, moveArrayItem(slots, idx, idx - 1))}
                            onMoveDown={() => setTemplateSignatureSlots(block.id, moveArrayItem(slots, idx, idx + 1))}
                          />
                        ) : (
                          <span />
                        )}
                        {props.canEdit ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={submitting}
                            style={{ color: 'var(--danger)' }}
                            onClick={() => setTemplateSignatureSlots(block.id, slots.filter((_, j) => j !== idx))}
                          >
                            ✕
                          </Button>
                        ) : (
                          <span />
                        )}
                      </div>
                    ))}
                    {props.canEdit ? (
                      <div>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={submitting}
                          onClick={() => setTemplateSignatureSlots(block.id, [...slots, {}])}
                        >
                          + Подпись
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div style={{ marginBottom: 12, padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Скрытые поля в карточке наряда</div>
              <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 8 }}>
                Отмеченные поля будут спрятаны под раскрывающимся блоком «Дополнительные поля» в карточке наряда, открытого по этому шаблону. В БД эти поля остаются — это только UI.
              </div>
              {hidableCatalog.length === 0 ? (
                <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Для этого типа нет полей, доступных для скрытия.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {hidableCatalog.map((f) => (
                    <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={editor.hiddenFields.has(f.key)}
                        disabled={!props.canEdit || submitting}
                        onChange={() => toggleHidden(f.key)}
                      />
                      {f.label} <span style={{ color: 'var(--subtle)', fontSize: 11 }}>({f.key})</span>
                    </label>
                  ))}
                </div>
              )}
              {unhidable.length > 0 ? (
                <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 6 }}>
                  Нельзя скрыть: {unhidable.join(', ')}
                </div>
              ) : null}
            </div>

            <table className="list-table" style={{ width: '100%', marginBottom: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>№</th>
                  <th style={{ minWidth: 220 }}>Деталь</th>
                  <th style={{ minWidth: 180 }}>Вид работы</th>
                  <th style={{ width: 70 }}>Ед.</th>
                  <th style={{ width: 80, textAlign: 'right' }}>По умолч.</th>
                  <th style={{ width: 110 }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {editor.lines.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                      Строки не заданы. {props.canEdit ? 'Нажмите «+ Добавить строку».' : ''}
                    </td>
                  </tr>
                ) : (
                  editor.lines.map((line, idx) => {
                    const dupKey = `${line.nomenclatureId}|${line.serviceId}`;
                    const isDup = duplicateLineKeys.has(dupKey);
                    return (
                      <tr key={line.id} style={isDup ? { background: 'rgba(220, 38, 38, 0.08)' } : undefined}>
                        <td>{idx + 1}</td>
                        <td>
                          <SearchSelect
                            value={line.nomenclatureId || null}
                            options={nomen}
                            placeholder={nomenLoading ? 'Загрузка…' : 'Не задана'}
                            disabled={!props.canEdit || submitting}
                            showAllWhenEmpty
                            emptyQueryLimit={50}
                            onChange={(next) => patchLine(line.id, { nomenclatureId: next ?? '' })}
                          />
                        </td>
                        <td>
                          <SearchSelect
                            value={line.serviceId || null}
                            options={services}
                            placeholder={servicesLoading ? 'Загрузка…' : 'Не задана'}
                            disabled={!props.canEdit || submitting}
                            showAllWhenEmpty
                            emptyQueryLimit={50}
                            onChange={(next) => patchLine(line.id, { serviceId: next ?? '' })}
                          />
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
                            style={{ width: 80, textAlign: 'right' }}
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

            <div style={{ marginBottom: 12 }}>
              <Button onClick={addLine} disabled={!props.canEdit || submitting}>
                + Добавить строку
              </Button>
            </div>

            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--subtle)' }}>
                Дополнительно: payloadOverrides (JSON)
              </summary>
              <div style={{ marginTop: 6 }}>
                <textarea
                  value={editor.payloadOverridesText}
                  disabled={!props.canEdit || submitting}
                  onChange={(e) => patchEditor({ payloadOverridesText: e.target.value })}
                  placeholder='{ "workshopId": "...", "engineBrandId": "..." }'
                  rows={5}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
                />
                <div style={{ fontSize: 11, color: 'var(--subtle)' }}>
                  Эти поля будут проставлены в payload наряда при применении шаблона. Пустая строка = без overrides.
                </div>
              </div>
            </details>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <Button variant="ghost" onClick={props.onClose} disabled={submitting}>
                Закрыть
              </Button>
              <Button
                onClick={() => void save()}
                disabled={!props.canEdit || submitting || (editor.templateId !== null && !editor.dirty)}
              >
                {submitting
                  ? 'Сохраняю…'
                  : editor.templateId === null
                  ? 'Создать'
                  : editor.dirty
                  ? 'Сохранить'
                  : 'Сохранено'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
