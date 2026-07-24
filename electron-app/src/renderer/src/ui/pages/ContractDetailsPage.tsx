import React, { useEffect, useState, useMemo, useRef } from 'react';

import { Button } from '../components/Button.js';
import { EntityReferenceField } from '../components/EntityReferenceField.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { Input } from '../components/Input.js';
import { FormGrid } from '../components/FormGrid.js';
import { FormField } from '../components/FormField.js';
import { NumericField } from '../components/NumericField.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { RowActions } from '../components/RowActions.js';
import { SectionCard } from '../components/SectionCard.js';
import { DataTable } from '../components/DataTable.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { RowReorderButtons } from '../components/RowReorderButtons.js';
import {
  parseContractSections,
  parseContractExecutionParts,
  normalizeContractExecutionParts,
  contractSectionsToLegacy,
  effectiveContractDueAt,
  nextAddonSeq,
  contractSectionAddonToken,
  aggregateContractExecutionProgress,
  CONTRACT_EXECUTION_PARTS_ATTR_CODE,
  STATUS_LABELS,
  type ContractExecutionProgressAggregate,
  type ContractSections,
  type ContractPrimarySection,
  type ContractAddonSection,
  type ContractEngineBrandRow,
  type ContractPartRow,
  type ContractExecutionPartRow,
  type EngineListItem,
  type QuickCreateRequest,
  type QuickCreateResult,
} from '@matricarmz/shared';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { formatMoscowDateTime, formatRuMoney, formatRuNumber } from '../utils/dateUtils.js';
import { quickCreateEntity } from '../utils/quickCreateEntity.js';
import { ensureAttributeDefs, type AttributeDefRow } from '../utils/fieldOrder.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { invalidateListAllPartSpecsCache, listAllPartSpecs } from '../utils/partsPagination.js';
import { getContractProgressVisual } from '../utils/contractProgressVisual.js';
import { moveArrayItem } from '../utils/moveArrayItem.js';
import type { SearchSelectOption } from '../components/SearchSelect.js';
import { mapEntityRowsToSearchOptions, mapPartRowsToSearchOptions } from '../utils/selectOptions.js';

type AttributeDef = {
  id: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  metaJson?: unknown;
};

type ContractEntity = {
  id: string;
  typeId: string;
  createdAt: number;
  updatedAt: number;
  attributes: Record<string, unknown>;
};

type LinkOpt = SearchSelectOption;

type ContractAccountingForm = {
  gozName: string;
  igk: string;
  hasFiles: boolean;
  separateAccountRaw: string;
  separateAccountNumber: string;
  separateAccountBank: string;
  comment: string;
};

const EMPTY_ACCOUNTING_FORM: ContractAccountingForm = {
  gozName: '',
  igk: '',
  hasFiles: false,
  separateAccountRaw: '',
  separateAccountNumber: '',
  separateAccountBank: '',
  comment: '',
};

const CONTRACT_ACCOUNTING_FIELDS: Array<{ code: string; name: string; dataType: string; sortOrder: number; metaJson?: string | null }> = [
  { code: 'contract_sections', name: 'Секции контракта', dataType: 'json', sortOrder: 5 },
  { code: CONTRACT_EXECUTION_PARTS_ATTR_CODE, name: 'Детали исполнения контракта', dataType: 'json', sortOrder: 6 },
  { code: 'goz_name', name: 'Наименование (ГОЗ)', dataType: 'text', sortOrder: 10 },
  { code: 'number', name: 'Номер контракта', dataType: 'text', sortOrder: 20 },
  { code: 'goz_igk', name: 'ИГК', dataType: 'text', sortOrder: 30 },
  { code: 'has_files', name: 'Есть файлы', dataType: 'boolean', sortOrder: 40 },
  { code: 'date', name: 'Дата заключения контракта', dataType: 'date', sortOrder: 50 },
  { code: 'due_date', name: 'Плановая дата исполнения контракта', dataType: 'date', sortOrder: 60 },
  { code: 'goz_separate_account_number', name: 'Отдельный счет (номер)', dataType: 'text', sortOrder: 70 },
  { code: 'goz_separate_account_bank', name: 'Отдельный счет (банк)', dataType: 'text', sortOrder: 80 },
  { code: 'goz_separate_account', name: 'Отдельный счет (реквизиты)', dataType: 'text', sortOrder: 90 },
  { code: 'internal_number', name: 'Внутренний номер', dataType: 'text', sortOrder: 100 },
  { code: 'customer_id', name: 'Контрагент', dataType: 'link', sortOrder: 110, metaJson: JSON.stringify({ linkTargetTypeCode: 'customer' }) },
  { code: 'comment', name: 'Комментарий', dataType: 'text', sortOrder: 120 },
];

function toInputDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '';
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

function parseMetaJson(meta: unknown): Record<string, unknown> | null {
  if (!meta) return null;
  if (typeof meta === 'object') return meta as Record<string, unknown>;
  if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toTextValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

function toBoolValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'да' || v === 'yes' || v === '+';
  }
  return false;
}

function parseSeparateAccount(rawValue: string): { number: string; bank: string } {
  const raw = toTextValue(rawValue).trim();
  if (!raw) return { number: '', bank: '' };
  const parts = raw.split(',');
  const first = parts[0]?.trim() ?? '';
  const tail = parts.slice(1).join(',').trim();
  const numberMatch = first.match(/\d{10,32}/) ?? raw.match(/\d{10,32}/);
  const number = numberMatch?.[0] ? numberMatch[0] : '';
  const bank = tail || (number ? raw.replace(number, '').replace(/^,\s*/, '').trim() : '');
  return { number, bank };
}

function buildAccountingForm(attrs: Record<string, unknown>): ContractAccountingForm {
  const separateAccountRaw = toTextValue(attrs.goz_separate_account);
  const parsed = parseSeparateAccount(separateAccountRaw);
  return {
    gozName: toTextValue(attrs.goz_name),
    igk: toTextValue(attrs.goz_igk),
    hasFiles: toBoolValue(attrs.has_files),
    separateAccountRaw,
    separateAccountNumber: toTextValue(attrs.goz_separate_account_number) || parsed.number,
    separateAccountBank: toTextValue(attrs.goz_separate_account_bank) || parsed.bank,
    comment: toTextValue(attrs.comment),
  };
}

function keyValueTable(rows: Array<[string, string]>) {
  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td></tr>`)
    .join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

function fileListHtml(list: unknown) {
  const items = Array.isArray(list)
    ? list.filter((x) => x && typeof x === 'object' && typeof (x as { name?: string }).name === 'string')
    : [];
  if (items.length === 0) return '<div class="muted">Нет файлов</div>';
  return `<ul>${items
    .map((f) => {
      const entry = f as { name: string; isObsolete?: boolean };
      const obsoleteBadge =
        entry.isObsolete === true
          ? ' <span style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#991b1b;background:#fee2e2;border:1px solid #fecaca;">Устаревшая версия</span>'
          : '';
      return `<li>${escapeHtml(String(entry.name))}${obsoleteBadge}</li>`;
    })
    .join('')}</ul>`;
}

function rowSum(qty: number, unitPrice: number): number {
  return (qty || 0) * (unitPrice || 0);
}

function computeSectionTotals(sections: ContractSections): { totalQty: number; totalSum: number; dueAt: number | null } {
  let totalQty = 0;
  let totalSum = 0;

  const addRows = (eb: ContractEngineBrandRow[], parts: ContractPartRow[]) => {
    for (const r of eb) {
      totalQty += r.qty || 0;
      totalSum += rowSum(r.qty || 0, r.unitPrice || 0);
    }
    for (const p of parts) {
      totalQty += p.qty || 0;
      totalSum += rowSum(p.qty || 0, p.unitPrice || 0);
    }
  };

  addRows(sections.primary.engineBrands, sections.primary.parts);
  for (const addon of sections.addons) {
    addRows(addon.engineBrands, addon.parts);
  }
  return { totalQty, totalSum, dueAt: effectiveContractDueAt(sections) };
}

type ContractExecutionState = 'не исполнен' | 'исполнен частично' | 'исполнен полностью';

function getExecutionState(progressPct: number | null): { state: ContractExecutionState; color: string; background: string } {
  if (progressPct == null || progressPct <= 0) {
    return { state: 'не исполнен', color: '#6b7280', background: '#f3f4f6' };
  }
  if (progressPct < 100) {
    return { state: 'исполнен частично', color: '#b45309', background: '#fffbeb' };
  }
  return { state: 'исполнен полностью', color: '#15803d', background: '#ecfdf5' };
}

function normalizeContractNumber(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function collectProgressContractNumbers(sections: ContractSections | null): Set<string> {
  const out = new Set<string>();
  if (!sections) return out;
  const primary = normalizeContractNumber(sections.primary.number);
  if (primary) out.add(primary);
  for (const addon of sections.addons) {
    const addonNumber = normalizeContractNumber(addon.number);
    if (addonNumber) out.add(addonNumber);
  }
  return out;
}

function toggleExpanded(prev: Record<string, boolean>, key: string): Record<string, boolean> {
  return { ...prev, [key]: prev[key] === false };
}

function engineOptionLabel(engine: EngineListItem): string {
  const internal = engine.internalNumberFull?.trim();
  const parts = [engine.engineNumber, internal ? `внутр. ${internal}` : '', engine.engineBrand].filter(
    (value) => typeof value === 'string' && value.trim(),
  );
  return parts.length > 0 ? parts.join(' — ') : engine.id.slice(0, 8);
}

function currentEngineStatusLabel(engine: EngineListItem): string {
  const flags = engine.statusFlags ?? {};
  if (flags.status_rejected) return STATUS_LABELS.status_rejected;
  // Утиль — терминальный исход, приоритетнее промежуточных статусов. «Признан утильным»
  // (ещё на заводе, собирается к возврату) идёт следом — судьба двигателя уже решена.
  if (flags.status_rework_sent) return STATUS_LABELS.status_rework_sent;
  if (flags.status_scrap_confirmed) return STATUS_LABELS.status_scrap_confirmed;
  if (flags.status_customer_accepted) return STATUS_LABELS.status_customer_accepted;
  if (flags.status_customer_sent) return STATUS_LABELS.status_customer_sent;
  if (flags.status_repaired) return STATUS_LABELS.status_repaired;
  if (flags.status_repair_started) return STATUS_LABELS.status_repair_started;
  if (flags.status_storage_received || engine.arrivalDate) return 'Приход на завод';
  return '—';
}

function renderCompactTableHtml(headers: string[], rows: string[][]) {
  if (rows.length === 0) return '<div class="muted">Нет данных</div>';
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell || '—')}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function SectionBlock(props: {
  title: string;
  section: ContractPrimarySection | ContractAddonSection;
  isPrimary: boolean;
  engineBrandOptions: LinkOpt[];
  partOptions: LinkOpt[];
  customerOptions?: LinkOpt[];
  onChange: (section: ContractPrimarySection | ContractAddonSection) => void;
  onRemove?: () => void;
  canEdit: boolean;
  canEditMasterData: boolean;
  createMasterDataItem: (typeCode: string, label: string) => Promise<string | null>;
  quickCreateMasterDataItem: (request: QuickCreateRequest) => Promise<QuickCreateResult | null>;
  onOpenCounterparty?: (counterpartyId: string) => void;
  onOpenPart?: (partId: string) => void;
  onOpenEngineBrand?: (engineBrandId: string) => void;
  // C-#6: двигатели, привязанные к этой ДС, + привязка существующего двигателя.
  relatedEngines?: EngineListItem[];
  engineOptions?: LinkOpt[];
  onOpenEngine?: (engineId: string) => void | Promise<void>;
  onAttachEngineToSection?: (engineId: string, sectionToken: string) => void | Promise<void>;
}) {
  const { confirm } = useConfirm();
  const {
    title,
    section,
    isPrimary,
    engineBrandOptions,
    partOptions,
    customerOptions = [],
    onChange,
    onRemove,
    canEdit,
    canEditMasterData,
    createMasterDataItem,
    quickCreateMasterDataItem,
    onOpenCounterparty,
    onOpenPart,
    onOpenEngineBrand,
    relatedEngines = [],
    engineOptions = [],
    onOpenEngine,
    onAttachEngineToSection,
  } = props;

  // C-#6: токен привязки этой секции — то, что хранит engine.contract_section_number.
  // Primary → номер договора; ДС → стабильный addon-токен (как в buildContractSectionOptions).
  const sectionToken = isPrimary
    ? String((section as ContractPrimarySection).number ?? '').trim()
    : contractSectionAddonToken((section as ContractAddonSection).seq);
  const sectionEngines = sectionToken
    ? relatedEngines.filter((e) => String(e.contractSectionNumber ?? '').trim() === sectionToken)
    : [];
  const sectionEngineIds = new Set(sectionEngines.map((e) => e.id));
  const engineOptionsForSection = engineOptions.filter((o) => !sectionEngineIds.has(o.id));
  const [addEngineOpen, setAddEngineOpen] = useState(false);

  const update = (patch: Partial<ContractPrimarySection | ContractAddonSection>) => {
    onChange({ ...section, ...patch });
  };

  const addEngineBrand = () => {
    const last = section.engineBrands[section.engineBrands.length - 1];
    const next: ContractEngineBrandRow = {
      engineBrandId: last?.engineBrandId ?? '',
      qty: last?.qty ?? 1,
      unitPrice: last?.unitPrice ?? 0,
    };
    update({ engineBrands: [...section.engineBrands, next] });
  };

  const removeEngineBrand = async (idx: number) => {
    const row = section.engineBrands[idx];
    const label = row ? engineBrandOptions.find((o) => o.id === row.engineBrandId)?.label ?? row.engineBrandId : '';
    const ok = await confirm({
      detail: `Будет удалена строка марки двигателя в разделе «${title}»${label ? ` (марка «${label}»)` : ''}.`,
    });
    if (!ok) return;
    const next = section.engineBrands.filter((_, i) => i !== idx);
    update({ engineBrands: next });
  };

  const moveEngineBrand = (from: number, to: number) => {
    update({ engineBrands: moveArrayItem(section.engineBrands, from, to) });
  };

  const updateEngineBrand = (idx: number, patch: Partial<ContractEngineBrandRow>) => {
    const next = [...section.engineBrands];
    const current = next[idx] ?? { engineBrandId: '', qty: 1, unitPrice: 0 };
    next[idx] = { ...current, ...patch };
    update({ engineBrands: next });
  };

  const addPart = () => {
    const last = section.parts[section.parts.length - 1];
    const next: ContractPartRow = {
      partId: last?.partId ?? '',
      qty: last?.qty ?? 1,
      unitPrice: last?.unitPrice ?? 0,
    };
    update({ parts: [...section.parts, next] });
  };

  const removePart = async (idx: number) => {
    const row = section.parts[idx];
    const label = row ? partOptions.find((o) => o.id === row.partId)?.label ?? row.partId : '';
    const ok = await confirm({
      detail: `Будет удалена строка детали в разделе «${title}»${label ? ` (деталь «${label}»)` : ''}.`,
    });
    if (!ok) return;
    const next = section.parts.filter((_, i) => i !== idx);
    update({ parts: next });
  };

  const movePart = (from: number, to: number) => {
    update({ parts: moveArrayItem(section.parts, from, to) });
  };

  const updatePart = (idx: number, patch: Partial<ContractPartRow>) => {
    const next = [...section.parts];
    const current = next[idx] ?? { partId: '', qty: 1, unitPrice: 0 };
    next[idx] = { ...current, ...patch };
    update({ parts: next });
  };

  const primarySection = isPrimary ? (section as ContractPrimarySection) : null;

  // C-#6: пустые под-разделы не показывают таблицу — только компактную «➕ Добавить…».
  const hasBrands = section.engineBrands.length > 0;
  const hasParts = section.parts.length > 0;
  const hasEngines = sectionEngines.length > 0;

  return (
    <SectionCard
      title={title}
      style={{ borderRadius: 0, padding: 16, minWidth: 0, overflow: 'hidden' }}
      actions={
        onRemove && canEdit ? (
          <Button
            variant="ghost"
            tone="danger"
            size="sm"
            onClick={() => {
              void (async () => {
                const ok = await confirm({ detail: `Будет удалено дополнительное соглашение «${title}» из карточки контракта.` });
                if (!ok) return;
                onRemove();
              })();
            }}
          >
            Удалить ДС
          </Button>
        ) : undefined
      }
    >

      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        <FormGrid columns="repeat(2, minmax(220px, 1fr))" gap={10}>
          {isPrimary ? (
            <FormField label="Номер контракта">
              <Input
                value={section.number}
                disabled={!canEdit}
                onChange={(e) => update({ number: e.target.value })}
                style={{ width: '100%' }}
              />
            </FormField>
          ) : null}
          <FormField label="Дата заключения">
            <Input
              type="date"
              value={toInputDate(section.signedAt)}
              disabled={!canEdit}
              onChange={(e) => update({ signedAt: fromInputDate(e.target.value) })}
              style={{ width: '100%' }}
            />
          </FormField>
          <FormField label="Дата исполнения">
            <Input
              type="date"
              value={toInputDate(section.dueAt)}
              disabled={!canEdit}
              onChange={(e) => update({ dueAt: fromInputDate(e.target.value) })}
              style={{ width: '100%' }}
            />
          </FormField>
          {isPrimary && primarySection && (
            <>
              <FormField label="Внутренний номер">
                <Input
                  value={primarySection.internalNumber}
                  disabled={!canEdit}
                  onChange={(e) => update({ internalNumber: e.target.value })}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="Контрагент" fullWidth>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start', minWidth: 0 }}>
                  <EntityReferenceField
                    target="customer"
                    targetLabel="Контрагент"
                    value={primarySection.customerId ?? null}
                    options={customerOptions}
                    disabled={!canEdit}
                    canCreate={canEditMasterData}
                    createLabel="Новый контрагент"
                    onChange={(next) => update({ customerId: next ?? null })}
                    onCreate={async (label) => {
                      const id = await createMasterDataItem('customer', label);
                      if (id) update({ customerId: id });
                      return id;
                    }}
                    onQuickCreate={quickCreateMasterDataItem}
                    {...(onOpenCounterparty ? { onOpen: onOpenCounterparty } : {})}
                  />
                </div>
              </FormField>
            </>
          )}
        </FormGrid>

        {!isPrimary && (
          <FormField label="Примечание" fullWidth>
            <textarea
              value={(section as ContractAddonSection).note ?? ''}
              disabled={!canEdit}
              rows={3}
              placeholder="Примечание к дополнительному соглашению…"
              onChange={(e) => update({ note: e.target.value })}
              style={{
                width: '100%',
                padding: 'var(--ui-input-padding, 4px 6px)',
                border: '1px solid var(--input-border)',
                outline: 'none',
                background: canEdit ? 'var(--input-bg)' : 'var(--input-bg-disabled)',
                color: 'var(--text)',
                fontSize: 'var(--ui-input-font-size, 13px)',
                lineHeight: 1.35,
                minHeight: 72,
                resize: 'vertical',
                boxShadow: 'var(--input-shadow)',
              }}
            />
          </FormField>
        )}

        {/* C-#6: компактные «➕ Добавить…» для пустых под-разделов — в один ряд */}
        {canEdit && (!hasBrands || !hasParts || (Boolean(sectionToken) && !hasEngines && !addEngineOpen)) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!hasBrands && (
              <Button variant="outline" tone="neutral" size="sm" onClick={addEngineBrand}>
                ➕ Добавить марку
              </Button>
            )}
            {!hasParts && (
              <Button variant="outline" tone="neutral" size="sm" onClick={addPart}>
                ➕ Добавить деталь
              </Button>
            )}
            {Boolean(sectionToken) && !hasEngines && !addEngineOpen && (
              <Button variant="outline" tone="neutral" size="sm" onClick={() => setAddEngineOpen(true)}>
                ➕ Добавить двигатель
              </Button>
            )}
          </div>
        )}

        {hasBrands && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label className="ui-muted">Марки двигателей</label>
            {canEdit && (
              <Button variant="ghost" size="sm" onClick={addEngineBrand}>
                + Добавить марку двигателя
              </Button>
            )}
          </div>
          <DataTable className="list-table">
              <colgroup>
                <col />
                <col style={{ width: 110 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 140 }} />
                {canEdit && <col style={{ width: 124 }} />}
              </colgroup>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }} data-col-kind="name">Марка</th>
                  <th className="num" data-col-kind="num" title="Кол-во">Кол-во</th>
                  <th className="num" data-col-kind="num" title="Цена">Цена</th>
                  <th className="num" data-col-kind="num" title="Сумма">Сумма</th>
                  {canEdit && <th style={{ textAlign: 'center', width: 120 }}>Действия</th>}
                </tr>
              </thead>
              <tbody>
                {section.engineBrands.map((row, idx) => {
                  const resolved = engineBrandOptions.find((o) => o.id === row.engineBrandId)?.label ?? null;
                  const dangling = !resolved && Boolean(row.engineBrandId) && engineBrandOptions.length > 0;
                  const label = resolved ?? (row.engineBrandId ? '⚠ марка удалена' : '—');
                  return (
                    <tr key={idx}>
                      <td data-col-kind="name" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
                          {canEdit ? (
                            <EntityReferenceField
                              target="engine_brand"
                              targetLabel="Марка двигателя"
                              value={row.engineBrandId || null}
                              options={engineBrandOptions}
                              disabled={!canEdit}
                              canCreate={canEditMasterData}
                              createLabel="Новая марка"
                              onChange={(id) => updateEngineBrand(idx, { engineBrandId: id ?? '' })}
                              onCreate={async (l) => {
                                const id = await createMasterDataItem('engine_brand', l);
                                if (id) updateEngineBrand(idx, { engineBrandId: id });
                                return id;
                              }}
                              onQuickCreate={quickCreateMasterDataItem}
                              {...(onOpenEngineBrand ? { onOpen: onOpenEngineBrand } : {})}
                            />
                          ) : (
                            <span style={dangling ? { color: 'var(--danger, #b91c1c)' } : undefined}>{label}</span>
                          )}
                        </div>
                      </td>
                      <td className="num" data-col-kind="num">
                        <NumericField
                          min={0}
                          value={row.qty}
                          disabled={!canEdit}
                          onChange={(next) => updateEngineBrand(idx, { qty: next })}
                          width={90}
                        />
                      </td>
                      <td className="num" data-col-kind="num">
                        <NumericField
                          min={0}
                          value={row.unitPrice}
                          disabled={!canEdit}
                          onChange={(next) => updateEngineBrand(idx, { unitPrice: next })}
                          width={110}
                        />
                      </td>
                      <td className="num" data-col-kind="num" style={{ fontWeight: 700 }}>
                        {formatRuNumber(rowSum(row.qty, row.unitPrice))}
                      </td>
                      {canEdit && (
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'center' }}>
                          <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <RowReorderButtons
                              canMoveUp={idx > 0}
                              canMoveDown={idx < section.engineBrands.length - 1}
                              onMoveUp={() => moveEngineBrand(idx, idx - 1)}
                              onMoveDown={() => moveEngineBrand(idx, idx + 1)}
                            />
                            <Button variant="ghost" tone="danger" size="sm" onClick={() => void removeEngineBrand(idx)}>
                              ×
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
          </DataTable>
        </div>
        )}

        {hasParts && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label className="ui-muted">Детали</label>
            {canEdit && (
              <Button variant="ghost" size="sm" onClick={addPart}>
                + Строка
              </Button>
            )}
          </div>
          <DataTable className="list-table">
              <colgroup>
                <col />
                <col style={{ width: 110 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 140 }} />
                {canEdit && <col style={{ width: 124 }} />}
              </colgroup>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }} data-col-kind="name">Деталь</th>
                  <th className="num" data-col-kind="num" title="Кол-во">Кол-во</th>
                  <th className="num" data-col-kind="num" title="Цена">Цена</th>
                  <th className="num" data-col-kind="num" title="Сумма">Сумма</th>
                  {canEdit && <th style={{ textAlign: 'center', width: 120 }}>Действия</th>}
                </tr>
              </thead>
              <tbody>
                {section.parts.map((row, idx) => {
                  const label = partOptions.find((o) => o.id === row.partId)?.label ?? (row.partId || '—');
                  return (
                    <tr key={idx}>
                      <td data-col-kind="name" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
                          {canEdit ? (
                            <EntityReferenceField
                              target="part"
                              targetLabel="Деталь"
                              value={row.partId || null}
                              options={partOptions}
                              disabled={!canEdit}
                              canCreate={canEditMasterData}
                              createLabel="Новая деталь"
                              onChange={(id) => updatePart(idx, { partId: id ?? '' })}
                              onCreate={async (label) => {
                                const id = await createMasterDataItem('part', label);
                                if (id) updatePart(idx, { partId: id });
                                return id;
                              }}
                              onQuickCreate={quickCreateMasterDataItem}
                              {...(onOpenPart ? { onOpen: onOpenPart } : {})}
                            />
                          ) : (
                            <span>{label}</span>
                          )}
                        </div>
                      </td>
                      <td className="num" data-col-kind="num">
                        <NumericField
                          min={0}
                          value={row.qty}
                          disabled={!canEdit}
                          onChange={(next) => updatePart(idx, { qty: next })}
                          width={90}
                        />
                      </td>
                      <td className="num" data-col-kind="num">
                        <NumericField
                          min={0}
                          value={row.unitPrice}
                          disabled={!canEdit}
                          onChange={(next) => updatePart(idx, { unitPrice: next })}
                          width={110}
                        />
                      </td>
                      <td className="num" data-col-kind="num" style={{ fontWeight: 700 }}>
                        {formatRuNumber(rowSum(row.qty, row.unitPrice))}
                      </td>
                      {canEdit && (
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'center' }}>
                          <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <RowReorderButtons
                              canMoveUp={idx > 0}
                              canMoveDown={idx < section.parts.length - 1}
                              onMoveUp={() => movePart(idx, idx - 1)}
                              onMoveDown={() => movePart(idx, idx + 1)}
                            />
                            <Button variant="ghost" tone="danger" size="sm" onClick={() => void removePart(idx)}>
                              ×
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
        </div>
        )}

        {/* C-#6: Двигатели, привязанные к этой ДС (показ + привязать существующий) */}
        {(hasEngines || addEngineOpen) && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label className="ui-muted">Двигатели</label>
              {canEdit && Boolean(sectionToken) && hasEngines && !addEngineOpen && (
                <Button variant="ghost" size="sm" onClick={() => setAddEngineOpen(true)}>
                  + Привязать
                </Button>
              )}
            </div>
            {hasEngines && (
              <DataTable className="list-table">
                <colgroup>
                  <col style={{ width: '40%' }} />
                  <col style={{ width: '30%' }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }} data-col-kind="name">Номер двигателя</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }} data-col-kind="name">Марка</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }} data-col-kind="text">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {sectionEngines.map((engine) => (
                    <tr key={engine.id}>
                      <td data-col-kind="name" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                        {onOpenEngine ? (
                          <button
                            type="button"
                            onClick={() => void onOpenEngine(engine.id)}
                            style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--info)', cursor: 'pointer', font: 'inherit' }}
                          >
                            {engine.engineNumber || '—'}
                          </button>
                        ) : (
                          engine.engineNumber || '—'
                        )}
                      </td>
                      <td data-col-kind="name" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{engine.engineBrand || '—'}</td>
                      <td data-col-kind="text" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{currentEngineStatusLabel(engine)}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
            {canEdit && addEngineOpen && (
              <div style={{ display: 'grid', gap: 8, marginTop: hasEngines ? 8 : 0 }}>
                <EntityReferenceField
                  target="engine"
                  targetLabel="Двигатель"
                  value={null}
                  options={engineOptionsForSection}
                  placeholder="Найти двигатель по номеру или марке"
                  onChange={(engineId) => {
                    if (engineId && onAttachEngineToSection) void onAttachEngineToSection(engineId, sectionToken);
                    setAddEngineOpen(false);
                  }}
                />
                <div>
                  <Button variant="ghost" tone="neutral" size="sm" onClick={() => setAddEngineOpen(false)}>
                    Отмена
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

export function ContractDetailsPage(props: {
  contractId: string;
  canEdit: boolean;
  canEditMasterData: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  onClose: () => void;
  onOpenCounterparty: (counterpartyId: string) => void;
  onOpenEngine?: (engineId: string) => void | Promise<void>;
  onOpenPart?: (partId: string) => void;
  onOpenEngineBrand?: (engineBrandId: string) => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [contract, setContract] = useState<ContractEntity | null>(null);
  const [status, setStatus] = useState<string>('');
  const [sections, setSections] = useState<ContractSections | null>(null);
  const [entityTypes, setEntityTypes] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [engineBrandOptions, setEngineBrandOptions] = useState<LinkOpt[]>([]);
  const [customerOptions, setCustomerOptions] = useState<LinkOpt[]>([]);
  const [partOptions, setPartOptions] = useState<LinkOpt[]>([]);
  const [allEngineOptions, setAllEngineOptions] = useState<LinkOpt[]>([]);
  const [relatedEngines, setRelatedEngines] = useState<EngineListItem[]>([]);
  const [executionParts, setExecutionParts] = useState<ContractExecutionPartRow[]>([]);
  const [defs, setDefs] = useState<AttributeDef[]>([]);
  const [contractProgress, setContractProgress] = useState<ContractExecutionProgressAggregate | null>(null);
  const [accountingForm, setAccountingForm] = useState<ContractAccountingForm>(EMPTY_ACCOUNTING_FORM);
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({
    attachedEngines: true,
    contractParts: true,
  });
  const [addEngineOpen, setAddEngineOpen] = useState(false);
  const [addPartOpen, setAddPartOpen] = useState(false);
  const [engineAttachStatus, setEngineAttachStatus] = useState('');
  const [partsExecutionStatus, setPartsExecutionStatus] = useState('');
  const dirtyRef = useRef(false);
  const skipNextEngineAttachIdRef = useRef('');
  // Phase 3d: recovery-draft движок пилота. Снимок = локальный несохранённый стейт редактора
  // (sections/executionParts/accountingForm); привязки двигателей и файлы пишутся сразу.
  const draftTimerRef = useRef<number | null>(null);
  const draftRestoredRef = useRef(false);
  const DRAFT_CARD_TYPE = 'contract';

  type ContractDraftSnapshot = {
    sections: ContractSections | null;
    executionParts: ContractExecutionPartRow[];
    accountingForm: ContractAccountingForm;
  };

  function currentDraftSnapshot(): ContractDraftSnapshot {
    return { sections, executionParts, accountingForm };
  }

  function buildDraftTitle(s: ContractDraftSnapshot): string {
    const number = String(s.sections?.primary.number ?? '').trim();
    return `Контракт «${number || 'без номера'}»`;
  }

  async function saveDraftNow(s: ContractDraftSnapshot, kind: 'recovery' | 'explicit' = 'recovery') {
    if (!props.canEdit) return false;
    try {
      const r = await window.matrica.drafts.save({
        cardType: DRAFT_CARD_TYPE,
        cardId: props.contractId,
        kind,
        title: buildDraftTitle(s),
        payloadJson: JSON.stringify(s),
        baseUpdatedAt: null,
      });
      return Boolean(r?.ok);
    } catch {
      // autosave is best-effort — a write failure must never block editing
      return false;
    }
  }

  async function clearDraft() {
    try {
      await window.matrica.drafts.clear({ cardType: DRAFT_CARD_TYPE, cardId: props.contractId });
    } catch {
      // best-effort
    }
  }

  function cancelPendingDraftSave() {
    if (draftTimerRef.current != null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }

  function applyDraftSnapshot(s: Partial<ContractDraftSnapshot>) {
    if (s.sections && typeof s.sections === 'object') setSections(s.sections as ContractSections);
    if (Array.isArray(s.executionParts)) setExecutionParts(s.executionParts as ContractExecutionPartRow[]);
    if (s.accountingForm && typeof s.accountingForm === 'object') {
      setAccountingForm({ ...EMPTY_ACCOUNTING_FORM, ...(s.accountingForm as ContractAccountingForm) });
    }
  }

  const contractTypeId = useMemo(() => entityTypes.find((t) => String(t.code) === 'contract')?.id ?? '', [entityTypes]);
  // Deferred-create: pass the contract type as fallbackTypeId so the first write to a
  // not-yet-saved card materializes the row. For an existing contract it is ignored.
  async function setContractAttr(code: string, value: unknown) {
    return window.matrica.admin.entities.setAttr(props.contractId, code, value, contractTypeId || undefined);
  }

  async function loadContract() {
    try {
      setStatus('Загрузка…');
      const types = (await window.matrica.admin.entityTypes.list()) as Array<{ id: string; code: string; name: string }>;
      setEntityTypes(types);
      const contractType = types.find((t) => String(t.code) === 'contract') ?? null;
      if (!contractType?.id) {
        setContract(null);
        setSections(null);
        setStatus('Справочник «Контракты» не найден (contract).');
        return;
      }
      // fallbackTypeId: a not-yet-saved (deferred-create) contract has no row — synthesize an
      // empty card so it opens instead of throwing.
      const d = (await window.matrica.admin.entities.get(props.contractId, contractType.id)) as ContractEntity;
      setContract(d);
      setSections(parseContractSections(d.attributes ?? {}));
      setExecutionParts(parseContractExecutionParts(d.attributes ?? {}));
      let defsList = (await window.matrica.admin.attributeDefs.listByEntityType(contractType.id)) as AttributeDef[];
      defsList = (await ensureAttributeDefs(contractType.id, CONTRACT_ACCOUNTING_FIELDS, defsList as AttributeDefRow[])) as AttributeDef[];
      setDefs(defsList);
      dirtyRef.current = false;
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadEngineBrands() {
    try {
      const type = entityTypes.find((t) => String(t.code) === 'engine_brand') ?? null;
      if (!type?.id) {
        setEngineBrandOptions([]);
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(type.id);
      setEngineBrandOptions(mapEntityRowsToSearchOptions(rows, { fallbackToShortId: true }));
    } catch {
      setEngineBrandOptions([]);
    }
  }

  async function loadCustomers() {
    try {
      const type = entityTypes.find((t) => String(t.code) === 'customer') ?? null;
      if (!type?.id) {
        setCustomerOptions([]);
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(type.id);
      setCustomerOptions(mapEntityRowsToSearchOptions(rows, { fallbackToShortId: true }));
    } catch {
      setCustomerOptions([]);
    }
  }

  async function loadParts() {
    try {
      const r = await listAllPartSpecs();
      if (!r?.ok || !r.parts) {
        setPartOptions([]);
        return;
      }
      setPartOptions(mapPartRowsToSearchOptions(r.parts as { id: string; name?: string; article?: string; templateName?: string }[]));
    } catch {
      setPartOptions([]);
    }
  }

  async function resolveRelatedContractIds(currentSections: ContractSections | null): Promise<Set<string>> {
    const relatedContractIds = new Set<string>([String(props.contractId)]);
    const relatedNumbers = collectProgressContractNumbers(currentSections);
    const contractTypeId = entityTypes.find((t) => String(t.code) === 'contract')?.id ?? '';
    if (relatedNumbers.size === 0 || !contractTypeId) return relatedContractIds;

    const contractRows = await window.matrica.admin.entities.listByEntityType(contractTypeId).catch(() => []);
    if (!Array.isArray(contractRows)) return relatedContractIds;

    for (const row of contractRows as Array<{ id?: string; displayName?: string }>) {
      const id = row?.id ? String(row.id) : '';
      if (!id) continue;
      const numberKey = normalizeContractNumber(row?.displayName ?? '');
      if (numberKey && relatedNumbers.has(numberKey)) relatedContractIds.add(id);
    }
    return relatedContractIds;
  }

  async function loadProgress() {
    try {
      const relatedContractIds = await resolveRelatedContractIds(sections);
      const engines = await window.matrica.engines.list();
      const engineItems = Array.isArray(engines)
        ? engines.filter((e) => relatedContractIds.has(String(e.contractId ?? '')))
        : [];
      const sortedEngineItems = [...engineItems].sort((a, b) => {
        const byNumber = String(a.engineNumber ?? '').localeCompare(String(b.engineNumber ?? ''), 'ru');
        if (byNumber !== 0) return byNumber;
        return b.updatedAt - a.updatedAt;
      });
      setRelatedEngines(sortedEngineItems);
      const engineOpts = (Array.isArray(engines) ? engines : []).map((engine) => ({
        id: engine.id,
        label: engineOptionLabel(engine),
      }));
      engineOpts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setAllEngineOptions(engineOpts);
      const aggregate = aggregateContractExecutionProgress({
        sections,
        engineItems: sortedEngineItems,
        executionParts,
      });
      setContractProgress(aggregate);
    } catch {
      setContractProgress(null);
      setRelatedEngines([]);
      setAllEngineOptions([]);
    }
  }

  useEffect(() => {
    void loadContract();
  }, [props.contractId]);

  useEffect(() => {
    if (entityTypes.length === 0) return;
    void loadEngineBrands();
    void loadCustomers();
    void loadParts();
  }, [entityTypes.length]);

  useEffect(() => {
    if (contract) void loadProgress();
  }, [contract?.id, contract?.updatedAt, sections, executionParts, entityTypes.length]);

  useEffect(() => {
    if (!contract) {
      setAccountingForm(EMPTY_ACCOUNTING_FORM);
      return;
    }
    setAccountingForm(buildAccountingForm(contract.attributes ?? {}));
    // Phase 3d: несохранённый снимок (крах / «оставить черновик») побеждает committed-копию.
    // Один раз на маунт (draftRestoredRef) — «Сброс» перезагружает committed. Восстановление
    // именно здесь: этот эффект — последний, кто заполняет стейт из contract, и иначе
    // перетёр бы применённый снимок.
    if (props.canEdit && !draftRestoredRef.current) {
      void (async () => {
        try {
          const d = await window.matrica.drafts.get({ cardType: DRAFT_CARD_TYPE, cardId: props.contractId });
          if (d.ok && d.draft?.payloadJson) {
            applyDraftSnapshot(JSON.parse(d.draft.payloadJson) as Partial<ContractDraftSnapshot>);
            dirtyRef.current = true;
            draftRestoredRef.current = true;
          }
        } catch {
          // битый/отсутствующий черновик → остаёмся на committed-копии
        }
      })();
    }
  }, [contract?.id, contract?.updatedAt]);

  // Phase 3d: debounced recovery-автосейв (~1.5с после последней правки, пока карточка dirty).
  useEffect(() => {
    if (!props.canEdit || !dirtyRef.current) return;
    const snapshot = currentDraftSnapshot();
    const timer = window.setTimeout(() => {
      void saveDraftNow(snapshot);
    }, 1500);
    draftTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (draftTimerRef.current === timer) draftTimerRef.current = null;
    };
  }, [sections, executionParts, accountingForm, props.canEdit]);

  useLiveDataRefresh(
    async () => {
      if (dirtyRef.current) return;
      await loadContract();
      await loadProgress();
    },
    { intervalMs: 20000 },
  );

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await saveAllAndClose();
      },
      reset: async () => {
        await loadContract();
        await loadProgress();
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
        void clearDraft();
      },
      keepDraft: async () => {
        cancelPendingDraftSave();
        if (props.canEdit) await saveDraftNow(currentDraftSnapshot());
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        const contractTypeId = entityTypes.find((t) => t.code === 'contract')?.id;
        if (!contractTypeId) return;
        const created = await window.matrica.admin.entities.create(contractTypeId);
        if (created?.ok && 'id' in created && sections) {
          await window.matrica.admin.entities.setAttr(created.id, 'contract_sections', { ...sections, primary: { ...sections.primary, number: (sections.primary.number ?? '') + ' (копия)' } });
          await window.matrica.admin.entities.setAttr(created.id, CONTRACT_EXECUTION_PARTS_ATTR_CODE, normalizeContractExecutionParts(executionParts));
        }
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
    // accountingForm в deps: keepDraft/saveAndClose читают его из замыкания — без него
    // зарегистрированные actions видели бы устаревшие реквизиты ГОЗ.
  }, [sections, executionParts, accountingForm, entityTypes, props.registerCardCloseActions]);

  async function createMasterDataItem(typeCode: string, label: string): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    if (typeCode === 'part') {
      const created = await window.matrica.warehouse.nomenclatureDirectoryPartCreate({ name: label });
      if (!created?.ok || !created?.part?.id) {
        throw new Error(!created?.ok && created ? created.error : 'Не удалось создать деталь');
      }
      invalidateListAllPartSpecsCache();
      await loadParts();
      return created.part.id;
    }
    const typeId = entityTypes.find((t) => String(t.code) === typeCode)?.id ?? null;
    if (!typeId) throw new Error(`Не найден справочник ${typeCode}`);
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created?.ok || !created?.id) {
      throw new Error(!created?.ok && created ? created.error : 'Не удалось создать элемент');
    }
    const attrByType: Record<string, string> = { engine_brand: 'name', customer: 'name' };
    const attr = attrByType[typeCode] ?? 'name';
    await window.matrica.admin.entities.setAttr(created.id, attr, label);
    await loadEngineBrands();
    await loadCustomers();
    return created.id;
  }

  async function quickCreateMasterDataItem(request: QuickCreateRequest): Promise<QuickCreateResult | null> {
    if (request.target === 'part') {
      const article = request.fields?.article == null ? '' : String(request.fields.article).trim();
      const created = await window.matrica.warehouse.nomenclatureDirectoryPartCreate({
        name: request.label,
        code: article || null,
      });
      if (!created?.ok || !created.part?.id) throw new Error(!created?.ok && created ? created.error : 'Не удалось создать деталь');
      invalidateListAllPartSpecsCache();
      await loadParts();
      return { id: created.part.id, label: request.label, existing: false };
    }
    const result = await quickCreateEntity(request);
    if (result) {
      await loadEngineBrands();
      await loadCustomers();
    }
    return result;
  }

  async function saveSections() {
    if (!props.canEdit || !sections) return;
    try {
      setStatus('Сохранение…');
      const normalizedSections: ContractSections = {
        ...sections,
        addons: sections.addons.map((addon) => ({ ...addon, number: sections.primary.number })),
      };
      await setContractAttr('contract_sections', normalizedSections);
      await setContractAttr(CONTRACT_EXECUTION_PARTS_ATTR_CODE, normalizeContractExecutionParts(executionParts));
      const legacy = contractSectionsToLegacy(normalizedSections);
      await setContractAttr('number', legacy.number);
      await setContractAttr('internal_number', legacy.internal_number);
      await setContractAttr('date', legacy.date);
      await setContractAttr('due_date', legacy.due_date);
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 1200);
      void loadContract();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function attachEngineToContract(engineId: string) {
    const normalizedId = String(engineId ?? '').trim();
    if (!normalizedId) return;
    if (relatedEngines.some((engine) => engine.id === normalizedId)) {
      setEngineAttachStatus('Этот двигатель уже прикреплен к контракту.');
      setAddEngineOpen(false);
      return;
    }
    try {
      setEngineAttachStatus('Прикрепление двигателя…');
      await window.matrica.engines.setAttr(normalizedId, 'contract_id', props.contractId);
      await loadProgress();
      setAddEngineOpen(false);
      setEngineAttachStatus('Двигатель добавлен.');
      setTimeout(() => setEngineAttachStatus(''), 1500);
    } catch (e) {
      setEngineAttachStatus(`Ошибка: ${String(e)}`);
    }
  }

  // C-#6: привязка существующего двигателя к конкретной ДС (из карточки контракта).
  // Ставит и contract_id (контракт), и contract_section_number (токен секции) — затем
  // reload, чтобы relatedEngines/раздел ДС обновились.
  async function attachEngineToSection(engineId: string, sectionToken: string) {
    const normalizedId = String(engineId ?? '').trim();
    const token = String(sectionToken ?? '').trim();
    if (!normalizedId || !token) return;
    try {
      setEngineAttachStatus('Привязка двигателя к ДС…');
      await window.matrica.engines.setAttr(normalizedId, 'contract_id', props.contractId);
      await window.matrica.engines.setAttr(normalizedId, 'contract_section_number', token);
      await loadProgress();
      setEngineAttachStatus('Двигатель привязан к ДС.');
      setTimeout(() => setEngineAttachStatus(''), 1500);
    } catch (e) {
      setEngineAttachStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function createAndOpenEngine(label: string): Promise<string | null> {
    if (!props.canEdit) return null;
    const nextLabel = String(label ?? '').trim();
    try {
      setEngineAttachStatus('Создание двигателя…');
      const created = await window.matrica.engines.create();
      if (!created?.id) return null;
      await window.matrica.engines.setAttr(created.id, 'contract_id', props.contractId);
      if (nextLabel) await window.matrica.engines.setAttr(created.id, 'engine_number', nextLabel);
      await loadProgress();
      setAddEngineOpen(false);
      setEngineAttachStatus('Двигатель создан.');
      setTimeout(() => setEngineAttachStatus(''), 1500);
      skipNextEngineAttachIdRef.current = created.id;
      if (props.onOpenEngine) await props.onOpenEngine(created.id);
      return created.id;
    } catch (e) {
      setEngineAttachStatus(`Ошибка: ${String(e)}`);
      return null;
    }
  }

  function updateExecutionPart(idx: number, patch: Partial<ContractExecutionPartRow>) {
    dirtyRef.current = true;
    setExecutionParts((current) => current.map((row, rowIdx) => (rowIdx === idx ? { ...row, ...patch } : row)));
  }

  function removeExecutionPart(idx: number) {
    dirtyRef.current = true;
    setExecutionParts((current) => current.filter((_, rowIdx) => rowIdx !== idx));
  }

  function moveExecutionPart(from: number, to: number) {
    dirtyRef.current = true;
    setExecutionParts((current) => moveArrayItem(current, from, to));
  }

  function addExecutionPartRow(partId: string) {
    const normalizedId = String(partId ?? '').trim();
    if (!normalizedId) return;
    if (executionParts.some((row) => row.partId === normalizedId)) {
      setPartsExecutionStatus('Эта деталь уже есть в списке исполнения.');
      setAddPartOpen(false);
      return;
    }
    dirtyRef.current = true;
    setExecutionParts((current) => [...current, { partId: normalizedId, plannedQty: 1, completedQty: 0 }]);
    setAddPartOpen(false);
    setPartsExecutionStatus('Деталь добавлена.');
    setTimeout(() => setPartsExecutionStatus(''), 1500);
  }

  function buildSeparateAccountRaw(form: ContractAccountingForm): string {
    const raw = toTextValue(form.separateAccountRaw).trim();
    if (raw) return raw;
    const number = toTextValue(form.separateAccountNumber).trim();
    const bank = toTextValue(form.separateAccountBank).trim();
    if (number && bank) return `${number}, ${bank}`;
    return number || bank;
  }

  async function saveAccountingFields(opts?: { silent?: boolean; reload?: boolean }) {
    if (!props.canEdit) return;
    const silent = opts?.silent === true;
    const shouldReload = opts?.reload !== false;
    try {
      if (!silent) setStatus('Сохранение реквизитов ГОЗ…');
      const nextRaw = buildSeparateAccountRaw(accountingForm);
      const nextAccount = parseSeparateAccount(nextRaw);

      await setContractAttr('goz_name', toTextValue(accountingForm.gozName).trim());
      await setContractAttr('goz_igk', toTextValue(accountingForm.igk).trim());
      await setContractAttr('has_files', Boolean(accountingForm.hasFiles));
      await setContractAttr('goz_separate_account', nextRaw);
      await setContractAttr('goz_separate_account_number', nextAccount.number);
      await setContractAttr('goz_separate_account_bank', nextAccount.bank);
      await setContractAttr('comment', toTextValue(accountingForm.comment).trim());

      if (!silent) {
        setStatus('Реквизиты ГОЗ сохранены');
        setTimeout(() => setStatus(''), 1200);
      }
      if (shouldReload) void loadContract();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function saveAllAndClose() {
    if (props.canEdit) {
      if (sections) await saveSections();
      await saveAccountingFields({ silent: true, reload: false });
      // Полный коммит вытесняет recovery-снимок; отменяем отложенный автосейв,
      // чтобы он не переписал черновик после очистки.
      cancelPendingDraftSave();
      await clearDraft();
    }
    dirtyRef.current = false;
  }

  async function handleDelete() {
    if (!props.canEdit) return;
    try {
      setStatus('Удаление…');
      const r = await window.matrica.admin.entities.softDelete(props.contractId);
      if (!r?.ok) {
        setStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      setStatus('Удалено');
      setTimeout(() => setStatus(''), 900);
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  function addAddon() {
    if (!sections) return;
    dirtyRef.current = true;
    setSections({
      ...sections,
      addons: [
        ...sections.addons,
        {
          number: sections.primary.number,
          seq: nextAddonSeq(sections),
          signedAt: null,
          dueAt: sections.primary.dueAt ?? null,
          createdAt: Date.now(),
          note: '',
          engineBrands: [],
          parts: [],
        },
      ],
    });
  }

  function removeAddon(idx: number) {
    if (!sections) return;
    dirtyRef.current = true;
    setSections({
      ...sections,
      addons: sections.addons.filter((_, i) => i !== idx),
    });
  }

  const headerTitle = sections?.primary.number?.trim() ? `Контракт: ${sections.primary.number.trim()}` : 'Карточка контракта';
  const { totalQty, totalSum, dueAt } = useMemo(() => (sections ? computeSectionTotals(sections) : { totalQty: 0, totalSum: 0, dueAt: null }), [sections]);
  const relatedEngineIds = useMemo(() => new Set(relatedEngines.map((engine) => engine.id)), [relatedEngines]);
  const executionPartIds = useMemo(() => new Set(executionParts.map((row) => row.partId)), [executionParts]);
  const availableEngineOptions = useMemo(
    () => allEngineOptions.filter((option) => !relatedEngineIds.has(option.id)),
    [allEngineOptions, relatedEngineIds],
  );
  const availablePartOptions = useMemo(
    () => partOptions.filter((option) => !executionPartIds.has(option.id)),
    [partOptions, executionPartIds],
  );
  const daysLeft = dueAt != null ? Math.ceil((dueAt - Date.now()) / (24 * 60 * 60 * 1000)) : null;
  const progressPct = contractProgress?.progressPct ?? 0;
  const dateMs = sections?.primary.signedAt ?? (typeof contract?.attributes?.date === 'number' ? Number(contract.attributes.date) : null);
  const isFullyExecuted = Boolean(contractProgress?.progressPct != null && contractProgress.progressPct >= 100);
  const progressVisual = getContractProgressVisual({
    progressPct: contractProgress?.progressPct ?? null,
    dateMs,
    dueDateMs: dueAt,
    isFullyExecuted,
    isOverdue: daysLeft != null && daysLeft < 0 && !isFullyExecuted,
  });
  const executionState = getExecutionState(contractProgress?.progressPct ?? null);

  function printContractCard() {
    if (!contract || !sections) return;
    const attrs = contract.attributes ?? {};
    const accounting = buildAccountingForm(attrs);
    const mainRows: Array<[string, string]> = [
      ['Номер', sections.primary.number || '—'],
      ['Дата заключения', toInputDate(sections.primary.signedAt) || '—'],
      ['Дата исполнения', toInputDate(effectiveContractDueAt(sections)) || '—'],
      ['Внутренний номер', sections.primary.internalNumber || '—'],
      ['Контрагент', customerOptions.find((o) => o.id === sections.primary.customerId)?.label ?? '—'],
      ['Наименование (ГОЗ)', accounting.gozName || '—'],
      ['ИГК', accounting.igk || '—'],
      ['Есть файлы', accounting.hasFiles ? 'Да' : 'Нет'],
      ['Отдельный счет (номер)', accounting.separateAccountNumber || '—'],
      ['Отдельный счет (банк)', accounting.separateAccountBank || '—'],
      ['Комментарий', accounting.comment || '—'],
    ];
    const summaryRows: Array<[string, string]> = [
      ['Кол-во (всего)', String(totalQty)],
      ['Сумма контракта', formatRuMoney(totalSum)],
      ['Двигателей по плану', String(contractProgress?.enginePlannedCount ?? 0)],
      ['Двигателей принято заказчиком', String(contractProgress?.engineAcceptedCount ?? 0)],
      ['Деталей по плану', String(contractProgress?.partPlannedCount ?? 0)],
      ['Деталей исполнено', String(contractProgress?.rawPartCompletedCount ?? 0)],
      ['Прогресс исполнения', contractProgress?.progressPct != null ? `${Math.round(contractProgress.progressPct)}%` : '—'],
    ];
    const addonRows = sections.addons.map((addon) => [
      String(addon.seq),
      addon.number || sections.primary.number || '—',
      toInputDate(addon.signedAt) || '—',
      toInputDate(addon.dueAt) || '—',
      addon.note?.trim() || '—',
      String(addon.engineBrands.length),
      String(addon.parts.length),
    ]);
    const engineRows = relatedEngines.map((engine) => [
      String(engine.engineNumber ?? '—'),
      String(engine.engineBrand ?? '—'),
      currentEngineStatusLabel(engine),
    ]);
    const partRows = executionParts.map((row) => [
      partOptions.find((option) => option.id === row.partId)?.label ?? row.partId,
      formatRuNumber(row.plannedQty),
      formatRuNumber(row.completedQty),
    ]);
    const fileDefs = defs.filter((d) => d.dataType === 'json' && parseMetaJson(d.metaJson)?.ui === 'files');
    const filesHtml =
      `<div><strong>Вложения</strong>${fileListHtml((attrs as Record<string, unknown>).attachments)}</div>` +
      fileDefs
        .map((d) => `<div style="margin-top:8px;"><strong>${escapeHtml(d.name)}</strong>${fileListHtml((attrs as Record<string, unknown>)[d.code])}</div>`)
        .join('');

    openPrintPreview({
      title: 'Карточка контракта',
      ...(sections.primary.number ? { subtitle: `Номер: ${sections.primary.number}` } : {}),
      sections: [
        { id: 'main', title: 'Карточка контракта', html: keyValueTable(mainRows) },
        {
          id: 'addons',
          title: 'Дополнительные соглашения',
          html: renderCompactTableHtml(
            ['ДС', 'Номер', 'Дата заключения', 'Дата исполнения', 'Примечание', 'Строк двигателей', 'Строк деталей'],
            addonRows,
          ),
        },
        { id: 'summary', title: 'Сводка исполнения', html: keyValueTable(summaryRows) },
        {
          id: 'engines',
          title: 'Список двигателей',
          html: renderCompactTableHtml(['Номер двигателя', 'Марка двигателя', 'Статус'], engineRows),
        },
        {
          id: 'parts',
          title: 'Список деталей',
          html: renderCompactTableHtml(['Деталь', 'План', 'Исполнено'], partRows),
        },
        { id: 'files', title: 'Файлы', html: filesHtml },
        {
          id: 'meta',
          title: 'Карточка',
          checked: false,
          html: keyValueTable([
            ['ID', contract.id],
            ['Создано', formatMoscowDateTime(contract.createdAt)],
            ['Обновлено', formatMoscowDateTime(contract.updatedAt)],
          ]),
        },
      ],
    });
  }

  if (!contract || !sections) {
    return <div>{status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}</div>;
  }

  const fileDefs = defs.filter((d) => d.dataType === 'json' && parseMetaJson(d.metaJson)?.ui === 'files');

  return (
    <EntityCardShell
      title={headerTitle}
      layout="two-column"
      cardActions={
        <CardActionBar
          canEdit={props.canEdit}
          cardLabel="Контракт"
          onCopyToNew={() => {
            void (async () => {
              const contractTypeId = entityTypes.find((t) => t.code === 'contract')?.id;
              if (!contractTypeId) return;
              const created = await window.matrica.admin.entities.create(contractTypeId);
              if (created?.ok && 'id' in created && sections) {
                await window.matrica.admin.entities.setAttr(created.id, 'contract_sections', { ...sections, primary: { ...sections.primary, number: (sections.primary.number ?? '') + ' (копия)' } });
                await window.matrica.admin.entities.setAttr(created.id, CONTRACT_EXECUTION_PARTS_ATTR_CODE, normalizeContractExecutionParts(executionParts));
              }
            })();
          }}
          onSave={() => { void saveAllAndClose().catch(() => undefined); }}
          onSaveAndClose={() => { void saveAllAndClose().then(() => props.onClose()); }}
          onSaveAsDraft={() => {
            void (async () => {
              // Явная парковка в черновик: без записи в EAV; отменяем отложенный
              // автосейв, чтобы он не перештамповал kind обратно в recovery.
              cancelPendingDraftSave();
              const ok = await saveDraftNow(currentDraftSnapshot(), 'explicit');
              if (!ok) {
                setStatus('Ошибка: не удалось сохранить черновик');
                return;
              }
              dirtyRef.current = false;
              props.onClose();
            })();
          }}
          onReset={() => {
            void (async () => {
              await loadContract();
              await loadProgress();
              dirtyRef.current = false;
            })();
          }}
          onDelete={() => void handleDelete()}
          deleteConfirmDetail={`Будет удалён контракт №${String(sections?.primary.number ?? '').trim() || props.contractId}. Действие обычно нельзя отменить.`}
          onClose={() => props.requestClose?.()}
        />
      }
      actions={
        <RowActions>
          <Button variant="ghost" tone="info" onClick={printContractCard}>
            Распечатать
          </Button>
        </RowActions>
      }
      status={status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{status}</div> : null}
    >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(520px, 100%), 1fr))', gap: 16, minWidth: 0, width: '100%' }}>
          <SectionBlock
            title="Первичный контракт"
            section={sections.primary}
            isPrimary
            engineBrandOptions={engineBrandOptions}
            partOptions={partOptions}
            customerOptions={customerOptions}
            relatedEngines={relatedEngines}
            engineOptions={allEngineOptions}
            {...(props.onOpenEngine ? { onOpenEngine: props.onOpenEngine } : {})}
            onAttachEngineToSection={attachEngineToSection}
            onOpenCounterparty={props.onOpenCounterparty}
            {...(props.onOpenPart ? { onOpenPart: props.onOpenPart } : {})}
            {...(props.onOpenEngineBrand ? { onOpenEngineBrand: props.onOpenEngineBrand } : {})}
            onChange={(primary) => { dirtyRef.current = true; setSections((s) => (s ? { ...s, primary: primary as ContractPrimarySection } : s)); }}
            canEdit={props.canEdit}
            canEditMasterData={props.canEditMasterData}
            createMasterDataItem={createMasterDataItem}
            quickCreateMasterDataItem={quickCreateMasterDataItem}
          />

          {sections.addons.map((addon, idx) => (
            <SectionBlock
              key={idx}
              title={`Дополнительное соглашение ${addon.seq} (ДС ${addon.seq})`}
              section={addon}
              isPrimary={false}
              engineBrandOptions={engineBrandOptions}
              partOptions={partOptions}
              relatedEngines={relatedEngines}
              engineOptions={allEngineOptions}
              {...(props.onOpenEngine ? { onOpenEngine: props.onOpenEngine } : {})}
              onAttachEngineToSection={attachEngineToSection}
              {...(props.onOpenPart ? { onOpenPart: props.onOpenPart } : {})}
              {...(props.onOpenEngineBrand ? { onOpenEngineBrand: props.onOpenEngineBrand } : {})}
              onChange={(addonSection) => {
                dirtyRef.current = true;
                setSections((s) =>
                  s ? { ...s, addons: s.addons.map((a, i) => (i === idx ? (addonSection as ContractAddonSection) : a)) } : s
                );
              }}
              onRemove={() => removeAddon(idx)}
              canEdit={props.canEdit}
              canEditMasterData={props.canEditMasterData}
              createMasterDataItem={createMasterDataItem}
              quickCreateMasterDataItem={quickCreateMasterDataItem}
            />
          ))}

          {props.canEdit && (
            <SectionCard style={{ borderRadius: 0, padding: 16, alignSelf: 'start', minWidth: 0 }}>
              <Button variant="outline" tone="neutral" onClick={addAddon} style={{ width: '100%' }}>
                + Добавить ДС
              </Button>
            </SectionCard>
          )}

          <SectionCard className="entity-card-span-full" title="Прикрепленные двигатели" style={{ borderRadius: 0, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
                Всего двигателей: {relatedEngines.length}
              </div>
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => setExpandedBlocks((prev) => toggleExpanded(prev, 'attachedEngines'))}
              >
                {expandedBlocks.attachedEngines === false ? 'Развернуть' : 'Свернуть'}
              </Button>
            </div>
            {engineAttachStatus ? (
              <div style={{ marginTop: 10, color: engineAttachStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>
                {engineAttachStatus}
              </div>
            ) : null}
            {expandedBlocks.attachedEngines !== false && (
              <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
                <DataTable className="list-table">
                  <colgroup>
                    <col style={{ width: '35%' }} />
                    <col style={{ width: '35%' }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }} data-col-kind="name">Номер двигателя</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }} data-col-kind="name">Марка двигателя</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }} data-col-kind="text">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {relatedEngines.map((engine) => (
                      <tr key={engine.id}>
                        <td data-col-kind="name" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                          {props.onOpenEngine ? (
                            <button
                              type="button"
                              onClick={() => void props.onOpenEngine?.(engine.id)}
                              style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--info)', cursor: 'pointer', font: 'inherit' }}
                            >
                              {engine.engineNumber || '—'}
                            </button>
                          ) : (
                            engine.engineNumber || '—'
                          )}
                        </td>
                        <td data-col-kind="name" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{engine.engineBrand || '—'}</td>
                        <td data-col-kind="text" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{currentEngineStatusLabel(engine)}</td>
                      </tr>
                    ))}
                    {relatedEngines.length === 0 && (
                      <tr>
                        <td colSpan={3} style={{ padding: 12, color: 'var(--subtle)', fontSize: 13 }}>
                          Нет прикрепленных двигателей
                        </td>
                      </tr>
                    )}
                  </tbody>
                </DataTable>

                {props.canEdit && (
                  addEngineOpen ? (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <EntityReferenceField
                        target="engine"
                        targetLabel="Двигатель"
                        value={null}
                        options={availableEngineOptions}
                        createLabel="Новый двигатель"
                        placeholder="Найти двигатель по номеру или марке"
                        onChange={(next) => {
                          const id = String(next ?? '').trim();
                          if (!id) return;
                          if (skipNextEngineAttachIdRef.current && skipNextEngineAttachIdRef.current === id) {
                            skipNextEngineAttachIdRef.current = '';
                            return;
                          }
                          void attachEngineToContract(id);
                        }}
                        onCreate={createAndOpenEngine}
                      />
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <Button variant="ghost" tone="neutral" size="sm" onClick={() => setAddEngineOpen(false)}>
                          Отмена
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button variant="outline" tone="neutral" onClick={() => setAddEngineOpen(true)}>
                        Добавить двигатель
                      </Button>
                    </div>
                  )
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard className="entity-card-span-full" title="Детали" style={{ borderRadius: 0, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
                План: {contractProgress?.partPlannedCount ?? 0} · Исполнено: {contractProgress?.rawPartCompletedCount ?? 0}
              </div>
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => setExpandedBlocks((prev) => toggleExpanded(prev, 'contractParts'))}
              >
                {expandedBlocks.contractParts === false ? 'Развернуть' : 'Свернуть'}
              </Button>
            </div>
            {partsExecutionStatus ? (
              <div style={{ marginTop: 10, color: partsExecutionStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>
                {partsExecutionStatus}
              </div>
            ) : null}
            {expandedBlocks.contractParts !== false && (
              <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
                <DataTable className="list-table">
                  <colgroup>
                    <col />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 140 }} />
                    {props.canEdit && <col style={{ width: 124 }} />}
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }} data-col-kind="name">Деталь</th>
                      <th className="num" data-col-kind="num" title="План">План</th>
                      <th className="num" data-col-kind="num" title="Исполнено">Исполнено</th>
                      {props.canEdit && <th style={{ textAlign: 'center', width: 120 }}>Действия</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {executionParts.map((row, idx) => {
                      const label = partOptions.find((option) => option.id === row.partId)?.label ?? row.partId;
                      return (
                        <tr key={row.partId}>
                          <td data-col-kind="name" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                            {row.partId && props.onOpenPart ? (
                              <button
                                type="button"
                                onClick={() => props.onOpenPart?.(row.partId)}
                                style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--info)', cursor: 'pointer', font: 'inherit' }}
                              >
                                {label}
                              </button>
                            ) : (
                              label
                            )}
                          </td>
                          <td className="num" data-col-kind="num">
                            <NumericField
                              min={0}
                              value={row.plannedQty}
                              disabled={!props.canEdit}
                              onChange={(next) => updateExecutionPart(idx, { plannedQty: next })}
                              width={100}
                            />
                          </td>
                          <td className="num" data-col-kind="num">
                            <NumericField
                              min={0}
                              value={row.completedQty}
                              disabled={!props.canEdit}
                              onChange={(next) => updateExecutionPart(idx, { completedQty: next })}
                              width={120}
                            />
                          </td>
                          {props.canEdit && (
                            <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'center' }}>
                              <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                <RowReorderButtons
                                  canMoveUp={idx > 0}
                                  canMoveDown={idx < executionParts.length - 1}
                                  onMoveUp={() => moveExecutionPart(idx, idx - 1)}
                                  onMoveDown={() => moveExecutionPart(idx, idx + 1)}
                                />
                                <Button variant="ghost" tone="danger" size="sm" onClick={() => removeExecutionPart(idx)}>
                                  ×
                                </Button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                    {executionParts.length === 0 && (
                      <tr>
                        <td colSpan={props.canEdit ? 4 : 3} style={{ padding: 12, color: 'var(--subtle)', fontSize: 13 }}>
                          Нет деталей исполнения
                        </td>
                      </tr>
                    )}
                  </tbody>
                </DataTable>

                {props.canEdit && (
                  addPartOpen ? (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <EntityReferenceField
                        target="part"
                        targetLabel="Деталь"
                        value={null}
                        options={availablePartOptions}
                        createLabel="Новая деталь"
                        placeholder="Найти или создать деталь"
                        onChange={(next) => {
                          const id = String(next ?? '').trim();
                          if (!id) return;
                          addExecutionPartRow(id);
                        }}
                        onCreate={(label) => createMasterDataItem('part', label)}
                        onQuickCreate={quickCreateMasterDataItem}
                      />
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <Button variant="ghost" tone="neutral" size="sm" onClick={() => setAddPartOpen(false)}>
                          Отмена
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button variant="outline" tone="neutral" onClick={() => setAddPartOpen(true)}>
                        Добавить деталь
                      </Button>
                    </div>
                  )
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard className="entity-card-span-full" title="Реквизиты ГОЗ (бухгалтерия)" style={{ borderRadius: 0, padding: 16 }}>
            <FormGrid columns="repeat(2, minmax(240px, 1fr))" gap={10}>
              <FormField label="Наименование (ГОЗ)" fullWidth>
                <Input
                  value={accountingForm.gozName}
                  disabled={!props.canEdit}
                  onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, gozName: e.target.value })); }}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="ИГК">
                <Input
                  value={accountingForm.igk}
                  disabled={!props.canEdit}
                  onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, igk: e.target.value })); }}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="Есть файлы">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 36 }}>
                  <input
                    type="checkbox"
                    checked={accountingForm.hasFiles}
                    disabled={!props.canEdit}
                    onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, hasFiles: e.target.checked })); }}
                  />
                  <span>{accountingForm.hasFiles ? 'Да' : 'Нет'}</span>
                </label>
              </FormField>
              <FormField label="Отдельный счет (реквизиты)" fullWidth>
                <Input
                  value={accountingForm.separateAccountRaw}
                  disabled={!props.canEdit}
                  onChange={(e) => setAccountingForm((s) => ({ ...s, separateAccountRaw: e.target.value }))}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="Отдельный счет (номер)">
                <Input
                  value={accountingForm.separateAccountNumber}
                  disabled={!props.canEdit}
                  onChange={(e) => setAccountingForm((s) => ({ ...s, separateAccountNumber: e.target.value }))}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="Отдельный счет (банк)">
                <Input
                  value={accountingForm.separateAccountBank}
                  disabled={!props.canEdit}
                  onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, separateAccountBank: e.target.value })); }}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="Комментарий" fullWidth>
                <Input
                  value={accountingForm.comment}
                  disabled={!props.canEdit}
                  onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, comment: e.target.value })); }}
                  style={{ width: '100%' }}
                />
              </FormField>
            </FormGrid>
            {props.canEdit && (
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="ghost" tone="success" onClick={() => void saveAccountingFields()}>
                  Сохранить реквизиты ГОЗ
                </Button>
              </div>
            )}
          </SectionCard>

          <SectionCard className="entity-card-span-full" title="Сводка" style={{ borderRadius: 0, padding: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--subtle)' }}>Кол-во</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{totalQty}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--subtle)' }}>Сумма контракта</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{formatRuMoney(totalSum)}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--subtle)' }}>Дней до окончания</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{daysLeft != null ? daysLeft : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--subtle)' }}>Степень исполнения</div>
                <span
                  style={{
                    marginTop: 2,
                    display: 'inline-flex',
                    padding: '4px 10px',
                    borderRadius: 999,
                    fontWeight: 600,
                    fontSize: 12,
                    color: executionState.color,
                    background: executionState.background,
                    border: '1px solid rgba(17, 24, 39, 0.08)',
                  }}
                >
                  {executionState.state}
                </span>
              </div>
            </div>
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12, color: 'var(--subtle)' }}>
                <span>Прогресс выполнения</span>
                <span>{contractProgress != null ? Math.round(progressPct) + '%' : '—'}</span>
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 0,
                  background: 'var(--border)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, Math.max(0, progressPct))}%`,
                    height: '100%',
                    background: progressVisual.barColor,
                    transition: 'width 0.2s',
                  }}
                />
              </div>
            </div>
          </SectionCard>

          <div className="entity-card-span-full">
            <AttachmentsPanel
              title="Вложения к контракту"
              value={contract.attributes?.attachments}
              canView={props.canViewFiles}
              canUpload={props.canUploadFiles && props.canEdit}
              scope={{ ownerType: 'contract', ownerId: contract.id, category: 'attachments' }}
              onChange={(next) => {
                void setContractAttr('attachments', next).then(() => void loadContract());
              }}
            />
          </div>

          {fileDefs.length > 0 && (
            <div className="entity-card-span-full">
              {fileDefs.map((def) => {
                const meta = parseMetaJson(def.metaJson);
                const category = typeof meta?.category === 'string' && meta.category.trim() ? String(meta.category) : def.code;
                return (
                  <AttachmentsPanel
                    key={def.id}
                    title={def.name}
                    value={contract.attributes?.[def.code]}
                    canView={props.canViewFiles}
                    canUpload={props.canUploadFiles && props.canEdit}
                    scope={{ ownerType: 'contract', ownerId: contract.id, category }}
                    onChange={(next) => {
                      void setContractAttr(def.code, next).then(() => void loadContract());
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
    </EntityCardShell>
  );
}
