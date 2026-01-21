import React, { useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { buildLinkTypeOptions, normalizeForMatch, suggestLinkTargetCodeWithRules, type LinkRule } from '@matricarmz/shared';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';

type Attribute = {
  id: string;
  code: string;
  name: string;
  dataType: string;
  value: unknown;
  isRequired: boolean;
  sortOrder: number;
  metaJson?: unknown;
};

type LinkOpt = { id: string; label: string };

type EntityTypeRow = { id: string; code: string; name: string };

type Part = {
  id: string;
  createdAt: number;
  updatedAt: number;
  attributes: Attribute[];
};

function toInputDate(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [focused, setFocused] = useState(false);
  return (
    <textarea
      {...props}
      style={{
        width: '100%',
        padding: '9px 12px',
        borderRadius: 12,
        border: focused ? '1px solid #2563eb' : '1px solid rgba(15, 23, 42, 0.25)',
        outline: 'none',
        background: props.disabled ? 'rgba(241,245,249,0.8)' : 'rgba(255,255,255,0.95)',
        color: '#0b1220',
        boxShadow: focused ? '0 0 0 4px rgba(37, 99, 235, 0.18)' : '0 10px 18px rgba(15, 23, 42, 0.06)',
        fontFamily: 'inherit',
        fontSize: 14,
        lineHeight: 1.4,
        minHeight: 110,
        resize: 'vertical',
        ...(props.style ?? {}),
      }}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
}

function formatValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => formatValue(x)).filter(Boolean).join(', ');
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function keyValueTable(rows: Array<[string, string]>) {
  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td></tr>`)
    .join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

function fileListHtml(list: unknown) {
  const items = Array.isArray(list)
    ? list.filter((x) => x && typeof x === 'object' && typeof (x as any).name === 'string')
    : [];
  if (items.length === 0) return '<div class="muted">Нет файлов</div>';
  return `<ul>${items.map((f) => `<li>${escapeHtml(String((f as any).name))}</li>`).join('')}</ul>`;
}

export function PartDetailsPage(props: {
  partId: string;
  canEdit: boolean;
  canDelete: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
}) {
  const [part, setPart] = useState<Part | null>(null);
  const [status, setStatus] = useState<string>('');
  const [editingAttr, setEditingAttr] = useState<Record<string, unknown>>({});

  // Core fields (better UX: always-visible inputs)
  const [name, setName] = useState<string>('');
  const [article, setArticle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [purchaseDate, setPurchaseDate] = useState<string>(''); // yyyy-mm-dd
  const [supplier, setSupplier] = useState<string>('');
  const [supplierId, setSupplierId] = useState<string>('');
  const [customerOptions, setCustomerOptions] = useState<LinkOpt[]>([]);
  const [customerStatus, setCustomerStatus] = useState<string>('');

  // Links: engine brands
  const [engineBrandOptions, setEngineBrandOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [engineBrandIds, setEngineBrandIds] = useState<string[]>([]);
  const [engineBrandStatus, setEngineBrandStatus] = useState<string>('');

  const [linkRules, setLinkRules] = useState<LinkRule[]>([]);
  const [entityTypes, setEntityTypes] = useState<EntityTypeRow[]>([]);
  const [linkOptionsByCode, setLinkOptionsByCode] = useState<Record<string, LinkOpt[]>>({});
  const [linkLoadingByCode, setLinkLoadingByCode] = useState<Record<string, boolean>>({});

  // Schema extension (add new fields)
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [newFieldCode, setNewFieldCode] = useState('');
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldDataType, setNewFieldDataType] = useState<'text' | 'number' | 'boolean' | 'date' | 'json' | 'link'>('text');
  const [newFieldSortOrder, setNewFieldSortOrder] = useState('100');
  const [newFieldIsRequired, setNewFieldIsRequired] = useState(false);
  const [newFieldMetaJson, setNewFieldMetaJson] = useState('');
  const [newFieldLinkTarget, setNewFieldLinkTarget] = useState('');
  const [newFieldLinkTouched, setNewFieldLinkTouched] = useState(false);

  const recommendedLinkCode = useMemo(
    () => suggestLinkTargetCodeWithRules(newFieldName, linkRules),
    [newFieldName, linkRules],
  );

  useEffect(() => {
    if (newFieldDataType !== 'link') {
      setNewFieldLinkTarget('');
      setNewFieldLinkTouched(false);
      return;
    }
    if (newFieldLinkTouched) return;
    if (recommendedLinkCode) setNewFieldLinkTarget(recommendedLinkCode);
  }, [newFieldDataType, newFieldLinkTouched, recommendedLinkCode]);

  const newFieldStandardType = useMemo(
    () => (newFieldLinkTouched ? entityTypes.find((t) => t.code === newFieldLinkTarget) ?? null : null),
    [newFieldLinkTouched, newFieldLinkTarget, entityTypes],
  );
  const newFieldRecommendedType = useMemo(
    () => entityTypes.find((t) => t.code === recommendedLinkCode) ?? null,
    [entityTypes, recommendedLinkCode],
  );
  const newFieldLinkOptions = useMemo(
    () => buildLinkTypeOptions(entityTypes, newFieldStandardType?.code ?? null, newFieldRecommendedType?.code ?? null),
    [entityTypes, newFieldStandardType?.code, newFieldRecommendedType?.code],
  );
  const [addFieldStatus, setAddFieldStatus] = useState('');

  async function createNewField() {
    if (!props.canEdit) return;
    try {
      const code = newFieldCode.trim();
      const name = newFieldName.trim();
      if (!code) {
        setAddFieldStatus('Ошибка: code пустой');
        return;
      }
      if (!/^[a-z][a-z0-9_]*$/i.test(code)) {
        setAddFieldStatus('Ошибка: code должен быть вида name_like_this');
        return;
      }
      if (!name) {
        setAddFieldStatus('Ошибка: название пустое');
        return;
      }
      if (newFieldDataType === 'link' && !newFieldLinkTarget) {
        setAddFieldStatus('Ошибка: выберите справочник');
        return;
      }

      setAddFieldStatus('Создание поля…');
      const sortOrder = Number(newFieldSortOrder) || 0;
      const metaJson =
        newFieldDataType === 'link'
          ? newFieldLinkTarget
            ? JSON.stringify({ linkTargetTypeCode: newFieldLinkTarget })
            : null
          : newFieldMetaJson.trim()
            ? newFieldMetaJson.trim()
            : null;

      const r = await window.matrica.parts.createAttributeDef({
        code,
        name,
        dataType: newFieldDataType,
        isRequired: newFieldIsRequired,
        sortOrder,
        metaJson,
      });
      if (!r?.ok) {
        setAddFieldStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      if (newFieldDataType === 'link' && newFieldLinkTouched && newFieldLinkTarget) {
        await upsertLinkRule(name, newFieldLinkTarget);
      }

      setAddFieldStatus('Поле добавлено');
      setTimeout(() => setAddFieldStatus(''), 1200);
      setAddFieldOpen(false);
      setNewFieldCode('');
      setNewFieldName('');
      setNewFieldDataType('text');
      setNewFieldSortOrder('100');
      setNewFieldIsRequired(false);
      setNewFieldMetaJson('');
      setNewFieldLinkTarget('');
      setNewFieldLinkTouched(false);
      void load();
    } catch (e) {
      setAddFieldStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadEngineBrands() {
    try {
      setEngineBrandStatus('Загрузка списка марок…');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'engine_brand') ?? null;
      if (!type?.id) {
        setEngineBrandOptions([]);
        setEngineBrandStatus('Справочник марок двигателя не найден (engine_brand).');
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      const opts = (rows as any[]).map((r) => ({
        id: String(r.id),
        label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setEngineBrandOptions(opts);
      setEngineBrandStatus('');
    } catch (e) {
      setEngineBrandOptions([]);
      setEngineBrandStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadCustomers() {
    try {
      setCustomerStatus('Загрузка списка поставщиков…');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'customer') ?? null;
      if (!type?.id) {
        setCustomerOptions([]);
        setCustomerStatus('Справочник контрагентов не найден (customer).');
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      const opts = (rows as any[]).map((r) => ({
        id: String(r.id),
        label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setCustomerOptions(opts);
      setCustomerStatus('');
    } catch (e) {
      setCustomerOptions([]);
      setCustomerStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadLinkRules() {
    try {
      const types = await window.matrica.admin.entityTypes.list();
      setEntityTypes(types as any);
      const type = (types as any[]).find((t) => String(t.code) === 'link_field_rule') ?? null;
      if (!type?.id) {
        setLinkRules([]);
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      const rules: LinkRule[] = [];
      for (const row of rows as any[]) {
        const details = await window.matrica.admin.entities.get(String(row.id));
        const attrs = details.attributes ?? {};
        const fieldName = String(attrs.field_name ?? '').trim();
        const targetTypeCode = String(attrs.target_type_code ?? '').trim();
        const priority = Number(attrs.priority ?? 0) || 0;
        if (fieldName && targetTypeCode) rules.push({ fieldName, targetTypeCode, priority });
      }
      setLinkRules(rules);
    } catch {
      setLinkRules([]);
    }
  }

  async function upsertLinkRule(fieldName: string, targetTypeCode: string) {
    const ruleType = entityTypes.find((t) => t.code === 'link_field_rule');
    if (!ruleType) return;
    const list = await window.matrica.admin.entities.listByEntityType(String(ruleType.id));
    const normalized = normalizeForMatch(fieldName);
    for (const row of list as any[]) {
      const details = await window.matrica.admin.entities.get(String(row.id));
      const attrs = details.attributes ?? {};
      const existingName = normalizeForMatch(String(attrs.field_name ?? ''));
      if (existingName && existingName === normalized) {
        await window.matrica.admin.entities.setAttr(String(row.id), 'target_type_code', targetTypeCode);
        if (!attrs.priority) await window.matrica.admin.entities.setAttr(String(row.id), 'priority', 100);
        await loadLinkRules();
        return;
      }
    }
    const created = await window.matrica.admin.entities.create(String(ruleType.id));
    if (!created.ok || !created.id) return;
    await window.matrica.admin.entities.setAttr(created.id, 'field_name', fieldName);
    await window.matrica.admin.entities.setAttr(created.id, 'target_type_code', targetTypeCode);
    await window.matrica.admin.entities.setAttr(created.id, 'priority', 100);
    await loadLinkRules();
  }

  async function loadLinkOptions(typeCode: string, attrCode: string) {
    if (!typeCode) return;
    setLinkLoadingByCode((p) => ({ ...p, [attrCode]: true }));
    try {
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === typeCode) ?? null;
      if (!type?.id) {
        setLinkOptionsByCode((p) => ({ ...p, [attrCode]: [] }));
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      const opts = (rows as any[]).map((r) => ({
        id: String(r.id),
        label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setLinkOptionsByCode((p) => ({ ...p, [attrCode]: opts }));
    } catch {
      setLinkOptionsByCode((p) => ({ ...p, [attrCode]: [] }));
    } finally {
      setLinkLoadingByCode((p) => ({ ...p, [attrCode]: false }));
    }
  }

  async function load() {
    try {
      setStatus('Загрузка…');
      const r = await window.matrica.parts.get(props.partId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setPart(r.part);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, [props.partId]);

  useEffect(() => {
    void loadEngineBrands();
  }, []);

  useEffect(() => {
    void loadCustomers();
    void loadLinkRules();
  }, []);

  // Sync local fields from loaded part (important after reload/save)
  useEffect(() => {
    if (!part) return;
    const byCode: Record<string, Attribute> = {};
    for (const a of part.attributes) byCode[a.code] = a;

    const vName = byCode.name?.value;
    const vArticle = byCode.article?.value;
    const vDesc = byCode.description?.value;
    const vPurchase = byCode.purchase_date?.value;
    const vSupplier = byCode.supplier?.value;
    const vBrands = byCode.engine_brand_ids?.value;
    const vSupplierId = byCode.supplier_id?.value;

    setName(typeof vName === 'string' ? vName : vName == null ? '' : String(vName));
    setArticle(typeof vArticle === 'string' ? vArticle : vArticle == null ? '' : String(vArticle));
    setDescription(typeof vDesc === 'string' ? vDesc : vDesc == null ? '' : String(vDesc));
    setPurchaseDate(typeof vPurchase === 'number' ? toInputDate(vPurchase) : '');
    setSupplier(typeof vSupplier === 'string' ? vSupplier : vSupplier == null ? '' : String(vSupplier));
    setSupplierId(typeof vSupplierId === 'string' ? vSupplierId : vSupplierId == null ? '' : String(vSupplierId));
    setEngineBrandIds(Array.isArray(vBrands) ? vBrands.filter((x): x is string => typeof x === 'string') : []);
  }, [part?.id, part?.updatedAt]);

  useEffect(() => {
    if (!part) return;
    if (supplierId || !supplier.trim() || customerOptions.length === 0) return;
    const normalized = normalizeForMatch(supplier);
    const match = customerOptions.find((c) => normalizeForMatch(c.label) === normalized);
    if (!match) return;
    setSupplierId(match.id);
    if (props.canEdit) void saveAttribute('supplier_id', match.id);
  }, [part?.id, supplierId, supplier, customerOptions, props.canEdit]);

  function getLinkTargetTypeCode(attr: Attribute): string | null {
    const meta = attr.metaJson;
    if (meta && typeof meta === 'object' && 'linkTargetTypeCode' in meta) {
      const code = (meta as any).linkTargetTypeCode;
      if (typeof code === 'string' && code.trim()) return code.trim();
    }
    if (typeof meta === 'string') {
      try {
        const parsed = JSON.parse(meta);
        const code = parsed?.linkTargetTypeCode;
        if (typeof code === 'string' && code.trim()) return code.trim();
      } catch {
        return null;
      }
    }
    return null;
  }

  useEffect(() => {
    if (!part) return;
    for (const attr of part.attributes) {
      if (attr.dataType !== 'link') continue;
      const targetTypeCode = getLinkTargetTypeCode(attr);
      if (!targetTypeCode) continue;
      if (linkOptionsByCode[attr.code] || linkLoadingByCode[attr.code]) continue;
      void loadLinkOptions(targetTypeCode, attr.code);
    }
  }, [part?.id, part?.updatedAt, linkOptionsByCode, linkLoadingByCode]);

  async function saveAttribute(code: string, value: unknown): Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }> {
    if (!props.canEdit) return { ok: false, error: 'no permission' };
    try {
      setStatus('Сохранение…');
      const r = await window.matrica.parts.updateAttribute({ partId: props.partId, attributeCode: code, value });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return r;
      }
      if ((r as any).queued) {
        setStatus('Отправлено на утверждение (см. «Изменения»)');
        setTimeout(() => setStatus(''), 2500);
      } else {
        setStatus('Сохранено');
        setTimeout(() => setStatus(''), 2000);
      }
      void load();
      return r as any;
    } catch (e) {
      const err = String(e);
      setStatus(`Ошибка: ${err}`);
      return { ok: false, error: err };
    }
  }

  async function saveCore() {
    if (!props.canEdit) return;
    const supplierLabel = supplierId ? customerOptions.find((c) => c.id === supplierId)?.label ?? '' : '';
    // Save sequentially (simple + predictable)
    await saveAttribute('name', name);
    await saveAttribute('article', article);
    await saveAttribute('description', description);
    await saveAttribute('purchase_date', fromInputDate(purchaseDate));
    await saveAttribute('supplier_id', supplierId || null);
    await saveAttribute('supplier', supplierLabel || supplier);
  }

  async function handleDelete() {
    if (!props.canDelete) return;
    if (!confirm('Удалить деталь?')) return;
    try {
      setStatus('Удаление…');
      const r = await window.matrica.parts.delete(props.partId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      // No dedicated "back" in UI: user can switch sections via tabs.
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!part) {
    return (
      <div>
        {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}
      </div>
    );
  }

  const sortedAttrs = [...part.attributes].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  const coreCodes = new Set(['name', 'article', 'description', 'purchase_date', 'supplier', 'supplier_id', 'engine_brand_ids']);
  // Эти поля имеют отдельные UI-блоки (связи/вложения) и не должны отображаться как "сырой JSON".
  const hiddenFromExtra = new Set(['engine_brand_ids', 'drawings', 'tech_docs', 'attachments']);
  const extraAttrs = sortedAttrs.filter((a) => !coreCodes.has(a.code) && !hiddenFromExtra.has(a.code));

  const attrByCode = new Map<string, Attribute>();
  for (const a of part.attributes) attrByCode.set(a.code, a);

  const engineBrandLabelById = new Map<string, string>();
  for (const o of engineBrandOptions) engineBrandLabelById.set(o.id, o.label);

  function printPartCard() {
    const mainRows: Array<[string, string]> = [
      ['Название', name],
      ['Артикул / обозначение', article],
      ['Описание', description],
      ['Дата покупки', purchaseDate || ''],
      ['Поставщик', supplier || ''],
    ];
    const compatibility = engineBrandIds
      .map((id) => engineBrandLabelById.get(id) ?? id)
      .filter(Boolean)
      .join(', ');
    const extraRows = extraAttrs.map((a) => [a.name || a.code, formatValue(a.value)]);
    openPrintPreview({
      title: 'Карточка детали',
      subtitle: name ? `Название: ${name}` : undefined,
      sections: [
        { id: 'main', title: 'Основное', html: keyValueTable(mainRows) },
        { id: 'compat', title: 'Совместимость', html: compatibility ? `<div>${escapeHtml(compatibility)}</div>` : '<div class="muted">Нет данных</div>' },
        {
          id: 'extra',
          title: 'Дополнительные поля',
          html: extraRows.length > 0 ? keyValueTable(extraRows as Array<[string, string]>) : '<div class="muted">Нет данных</div>',
        },
        {
          id: 'files',
          title: 'Файлы',
          html:
            `<div><strong>Вложения</strong>${fileListHtml(attrByCode.get('attachments')?.value)}</div>` +
            `<div style="margin-top:8px;"><strong>Чертежи</strong>${fileListHtml(attrByCode.get('drawings')?.value)}</div>` +
            `<div style="margin-top:8px;"><strong>Тех. документы</strong>${fileListHtml(attrByCode.get('tech_docs')?.value)}</div>`,
        },
        {
          id: 'meta',
          title: 'Карточка',
          html: keyValueTable([
            ['ID', part.id],
            ['Создано', new Date(part.createdAt).toLocaleString('ru-RU')],
            ['Обновлено', new Date(part.updatedAt).toLocaleString('ru-RU')],
          ]),
        },
      ],
    });
  }


  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Карточка детали</h2>
        <Button variant="ghost" onClick={printPartCard}>
          Распечатать
        </Button>
        {props.canDelete && (
          <Button variant="ghost" onClick={() => void handleDelete()} style={{ color: '#b91c1c' }}>
            Удалить
          </Button>
        )}
      </div>

      {status && <div style={{ marginBottom: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(520px, 1fr))', gap: 10 }}>
        {/* Core */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <strong>Основное</strong>
            <span style={{ flex: 1 }} />
            {props.canEdit && (
              <Button variant="ghost" onClick={() => void saveCore()}>
                Сохранить
              </Button>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 180px) 1fr', gap: 10, alignItems: 'center' }}>
            <div style={{ color: '#6b7280' }}>Название</div>
            <Input
              value={name}
              disabled={!props.canEdit}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void saveAttribute('name', name)}
            />

            <div style={{ color: '#6b7280' }}>Артикул / обозначение</div>
            <Input
              value={article}
              disabled={!props.canEdit}
              onChange={(e) => setArticle(e.target.value)}
              onBlur={() => void saveAttribute('article', article)}
            />

            <div style={{ color: '#6b7280', alignSelf: 'start', paddingTop: 10 }}>Описание</div>
            <Textarea
              value={description}
              disabled={!props.canEdit}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => void saveAttribute('description', description)}
            />

            <div style={{ color: '#6b7280' }}>Дата покупки</div>
            <Input
              type="date"
              value={purchaseDate}
              disabled={!props.canEdit}
              onChange={(e) => setPurchaseDate(e.target.value)}
              onBlur={() => void saveAttribute('purchase_date', fromInputDate(purchaseDate))}
            />

            <div style={{ color: '#6b7280' }}>Поставщик</div>
            <div style={{ display: 'grid', gap: 6 }}>
              <SearchSelect
                value={supplierId}
                options={customerOptions}
                placeholder="Выберите поставщика"
                disabled={!props.canEdit}
                onChange={(next) => {
                  setSupplierId(next);
                  const label = customerOptions.find((c) => c.id === next)?.label ?? '';
                  setSupplier(label);
                  void saveAttribute('supplier_id', next || null);
                  void saveAttribute('supplier', label || supplier);
                }}
              />
              {customerStatus && (
                <span style={{ color: customerStatus.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 12 }}>{customerStatus}</span>
              )}
            </div>
          </div>
        </div>

        {/* Meta / placeholders for next steps */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
          <strong>Карточка</strong>
          <div style={{ marginTop: 10, color: '#6b7280', fontSize: 13 }}>
            <div>
              <span style={{ color: '#111827' }}>ID:</span> {part.id}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: '#111827' }}>Создано:</span> {new Date(part.createdAt).toLocaleString('ru-RU')}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: '#111827' }}>Обновлено:</span> {new Date(part.updatedAt).toLocaleString('ru-RU')}
            </div>
          </div>

          <div style={{ marginTop: 14, borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
            <strong>Связи</strong>
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <div style={{ color: '#6b7280', fontSize: 13 }}>Марки двигателя</div>
                <span style={{ flex: 1 }} />
                <Button variant="ghost" onClick={() => void loadEngineBrands()}>
                  Обновить
                </Button>
              </div>

              {engineBrandStatus && (
                <div style={{ marginTop: 8, color: engineBrandStatus.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 13 }}>
                  {engineBrandStatus}
                </div>
              )}

              <div style={{ marginTop: 10 }}>
                <MultiSearchSelect
                  values={engineBrandIds}
                  options={engineBrandOptions}
                  disabled={!props.canEdit}
                  placeholder="Выберите марки двигателя"
                  onChange={(next) => {
                    const sorted = [...next];
                    sorted.sort((a, b) => (engineBrandLabelById.get(a) ?? a).localeCompare(engineBrandLabelById.get(b) ?? b, 'ru'));
                    setEngineBrandIds(sorted);
                    void saveAttribute('engine_brand_ids', sorted);
                  }}
                />
                {engineBrandOptions.length === 0 && (
                  <div style={{ marginTop: 8, color: '#6b7280', fontSize: 13 }}>
                    Справочник пуст (создайте марки в «Справочники»).
                  </div>
                )}
              </div>

              <div style={{ marginTop: 10, color: '#6b7280', fontSize: 12 }}>
                Выбрано: {engineBrandIds.length}
                {engineBrandIds.length > 0 && (
                  <>
                    {' '}
                    — {engineBrandIds.map((id) => engineBrandLabelById.get(id) ?? id.slice(0, 8)).join(', ')}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Attachments */}
        <div style={{ gridColumn: '1 / -1' }}>
          <AttachmentsPanel
            title="Чертежи"
            value={attrByCode.get('drawings')?.value}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEdit}
            scope={{ ownerType: 'part', ownerId: part.id, category: 'drawings' }}
            onChange={(next) => saveAttribute('drawings', next)}
          />
          <AttachmentsPanel
            title="Технология"
            value={attrByCode.get('tech_docs')?.value}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEdit}
            scope={{ ownerType: 'part', ownerId: part.id, category: 'tech_docs' }}
            onChange={(next) => saveAttribute('tech_docs', next)}
          />
          <AttachmentsPanel
            title="Вложения (прочее)"
            value={attrByCode.get('attachments')?.value}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEdit}
            scope={{ ownerType: 'part', ownerId: part.id, category: 'attachments' }}
            onChange={(next) => saveAttribute('attachments', next)}
          />
        </div>

        {/* Extra fields */}
        <div style={{ gridColumn: '1 / -1', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <strong>Дополнительные поля</strong>
            <span style={{ flex: 1 }} />
            {addFieldStatus && (
              <span style={{ color: addFieldStatus.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 12 }}>{addFieldStatus}</span>
            )}
            {props.canEdit && (
              <Button
                variant="ghost"
                onClick={() => {
                  setAddFieldOpen((v) => !v);
                  setAddFieldStatus('');
                }}
              >
                {addFieldOpen ? 'Закрыть' : 'Добавить поле'}
              </Button>
            )}
            <span style={{ color: '#6b7280', fontSize: 12 }}>Все остальные поля (в т.ч. файлы/JSON) редактируются здесь.</span>
          </div>

          {addFieldOpen && props.canEdit && (
            <div style={{ marginBottom: 14, border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Новое поле для деталей (появится в карточке у всех деталей).</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8, alignItems: 'center' }}>
                <Input value={newFieldCode} onChange={(e) => setNewFieldCode(e.target.value)} placeholder="code (например: material)" />
                <Input value={newFieldName} onChange={(e) => setNewFieldName(e.target.value)} placeholder="название (например: Материал)" />

                <select
                  value={newFieldDataType}
                  onChange={(e) => setNewFieldDataType(e.target.value as any)}
                  style={{ padding: '9px 12px', borderRadius: 12, border: '1px solid rgba(15, 23, 42, 0.25)' }}
                >
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="date">date</option>
                  <option value="json">json</option>
                  <option value="link">link</option>
                </select>

                <Input value={newFieldSortOrder} onChange={(e) => setNewFieldSortOrder(e.target.value)} placeholder="sortOrder (например: 300)" />

                <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: '#111827', fontSize: 14 }}>
                  <input type="checkbox" checked={newFieldIsRequired} onChange={(e) => setNewFieldIsRequired(e.target.checked)} />
                  обязательное
                </label>

                {newFieldDataType === 'link' ? (
                  <div style={{ display: 'grid', gap: 6, gridColumn: '1 / -1' }}>
                    <select
                      value={newFieldLinkTarget}
                      onChange={(e) => {
                        setNewFieldLinkTarget(e.target.value);
                        setNewFieldLinkTouched(true);
                      }}
                      style={{ padding: '9px 12px', borderRadius: 12, border: '1px solid rgba(15, 23, 42, 0.25)' }}
                    >
                      <option value="">связь с (раздел)…</option>
                      {newFieldLinkOptions.map((opt) => (
                        <option key={opt.type.id} value={opt.type.code}>
                          {opt.tag === 'standard'
                            ? `${opt.type.name} (стандартный)`
                            : opt.tag === 'recommended'
                              ? `${opt.type.name} (рекомендуется)`
                              : opt.type.name}
                        </option>
                      ))}
                    </select>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setNewFieldLinkTouched(false);
                          if (recommendedLinkCode) setNewFieldLinkTarget(recommendedLinkCode);
                        }}
                        disabled={!recommendedLinkCode}
                      >
                        Сбросить к рекомендуемому
                      </Button>
                      {!recommendedLinkCode && <span style={{ color: '#6b7280', fontSize: 12 }}>Нет рекомендации</span>}
                    </div>
                    {(newFieldStandardType || newFieldRecommendedType) && (
                      <div style={{ color: '#6b7280', fontSize: 12 }}>
                        {newFieldStandardType && (
                          <>
                            Стандартный: <strong>{newFieldStandardType.name}</strong>
                          </>
                        )}
                        {newFieldStandardType && newFieldRecommendedType && newFieldRecommendedType.code !== newFieldStandardType.code && ' • '}
                        {newFieldRecommendedType && newFieldRecommendedType.code !== newFieldStandardType?.code && (
                          <>
                            Рекомендуется: <strong>{newFieldRecommendedType.name}</strong>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <Input
                    value={newFieldMetaJson}
                    onChange={(e) => setNewFieldMetaJson(e.target.value)}
                    placeholder="metaJson (опц., JSON строка)"
                    style={{ gridColumn: '1 / -1' }}
                  />
                )}

                <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
                  <Button onClick={() => void createNewField()}>Добавить</Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setAddFieldOpen(false);
                      setAddFieldStatus('');
                    }}
                  >
                    Отмена
                  </Button>
                </div>
              </div>
            </div>
          )}

          {extraAttrs.length === 0 ? (
            <div style={{ color: '#6b7280', fontSize: 13 }}>Нет дополнительных полей.</div>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              {extraAttrs.map((attr) => {
                const value = editingAttr[attr.code] !== undefined ? editingAttr[attr.code] : attr.value;
                const isEditing = editingAttr[attr.code] !== undefined;
                const linkOpt =
                  attr.dataType === 'link' && typeof value === 'string'
                    ? (linkOptionsByCode[attr.code] ?? []).find((o) => o.id === value) ?? null
                    : null;

                return (
                  <div key={attr.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontWeight: 600, fontSize: 14, color: '#374151' }}>
                      {attr.name}
                      <span style={{ color: '#6b7280', fontWeight: 400 }}> ({attr.code})</span>
                      {attr.isRequired && <span style={{ color: '#b91c1c' }}> *</span>}
                    </label>
                    {!props.canEdit || !isEditing ? (
                      <div
                        style={{
                          padding: '10px 12px',
                          border: '1px solid #e5e7eb',
                          borderRadius: 8,
                          backgroundColor: props.canEdit ? '#f9fafb' : '#ffffff',
                          fontSize: 14,
                          color: '#111827',
                          cursor: props.canEdit ? 'pointer' : 'default',
                          whiteSpace: 'pre-wrap',
                        }}
                        onClick={() => {
                          if (props.canEdit) setEditingAttr({ ...editingAttr, [attr.code]: attr.value });
                        }}
                      >
                        {value === null || value === undefined ? (
                          <span style={{ color: '#9ca3af' }}>—</span>
                        ) : typeof value === 'string' ? (
                          linkOpt?.label ?? value
                        ) : typeof value === 'number' ? (
                          String(value)
                        ) : typeof value === 'boolean' ? (
                          value ? 'Да' : 'Нет'
                        ) : (
                          JSON.stringify(value)
                        )}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 8 }}>
                        {attr.dataType === 'text' ? (
                          <Input
                            value={String(value ?? '')}
                            onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: e.target.value })}
                            style={{ flex: 1 }}
                          />
                        ) : attr.dataType === 'link' ? (
                          <SearchSelect
                            value={typeof value === 'string' ? value : ''}
                            options={linkOptionsByCode[attr.code] ?? []}
                            placeholder="Выберите значение"
                            disabled={!props.canEdit || linkLoadingByCode[attr.code]}
                            onChange={(next) => setEditingAttr({ ...editingAttr, [attr.code]: next })}
                          />
                        ) : attr.dataType === 'number' ? (
                          <Input
                            type="number"
                            value={String(value ?? '')}
                            onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: Number(e.target.value) || 0 })}
                            style={{ flex: 1 }}
                          />
                        ) : attr.dataType === 'boolean' ? (
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={!!value}
                              onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: e.target.checked })}
                            />
                            <span>{value ? 'Да' : 'Нет'}</span>
                          </label>
                        ) : attr.dataType === 'date' ? (
                          <Input
                            type="date"
                            value={value && typeof value === 'number' ? toInputDate(value) : ''}
                            onChange={(e) => {
                              const d = fromInputDate(e.target.value);
                              setEditingAttr({ ...editingAttr, [attr.code]: d });
                            }}
                            style={{ flex: 1 }}
                          />
                        ) : (
                          <Input
                            value={JSON.stringify(value ?? '')}
                            onChange={(e) => {
                              try {
                                const parsed = JSON.parse(e.target.value);
                                setEditingAttr({ ...editingAttr, [attr.code]: parsed });
                              } catch {
                                // ignore
                              }
                            }}
                            style={{ flex: 1 }}
                          />
                        )}
                        <Button
                          onClick={() => {
                            void saveAttribute(attr.code, value);
                            const newEditing = { ...editingAttr };
                            delete newEditing[attr.code];
                            setEditingAttr(newEditing);
                          }}
                        >
                          Сохранить
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            const newEditing = { ...editingAttr };
                            delete newEditing[attr.code];
                            setEditingAttr(newEditing);
                          }}
                        >
                          Отмена
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

