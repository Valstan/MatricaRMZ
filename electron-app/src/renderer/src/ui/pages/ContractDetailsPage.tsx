import React, { useEffect, useState, useMemo, useRef } from 'react';

import { Button } from '../components/Button.js';
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
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import {
  parseContractSections,
  contractSectionsToLegacy,
  aggregateProgress,
  type ProgressLinkedItem,
  type ContractSections,
  type ContractPrimarySection,
  type ContractAddonSection,
  type ContractEngineBrandRow,
  type ContractPartRow,
} from '@matricarmz/shared';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { ensureAttributeDefs, type AttributeDefRow } from '../utils/fieldOrder.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

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

type LinkOpt = { id: string; label: string };

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
  return `<ul>${items.map((f) => `<li>${escapeHtml(String((f as { name: string }).name))}</li>`).join('')}</ul>`;
}

function rowSum(qty: number, unitPrice: number): number {
  return (qty || 0) * (unitPrice || 0);
}

function computeSectionTotals(sections: ContractSections): { totalQty: number; totalSum: number; maxDueAt: number | null } {
  let totalQty = 0;
  let totalSum = 0;
  let maxDueAt: number | null = null;

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
  if (sections.primary.dueAt != null && (maxDueAt == null || sections.primary.dueAt > maxDueAt)) {
    maxDueAt = sections.primary.dueAt;
  }
  for (const addon of sections.addons) {
    addRows(addon.engineBrands, addon.parts);
    if (addon.dueAt != null && (maxDueAt == null || addon.dueAt > maxDueAt)) {
      maxDueAt = addon.dueAt;
    }
  }
  return { totalQty, totalSum, maxDueAt };
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
}) {
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
  } = props;

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

  const removeEngineBrand = (idx: number) => {
    const next = section.engineBrands.filter((_, i) => i !== idx);
    update({ engineBrands: next });
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

  const removePart = (idx: number) => {
    const next = section.parts.filter((_, i) => i !== idx);
    update({ parts: next });
  };

  const updatePart = (idx: number, patch: Partial<ContractPartRow>) => {
    const next = [...section.parts];
    const current = next[idx] ?? { partId: '', qty: 1, unitPrice: 0 };
    next[idx] = { ...current, ...patch };
    update({ parts: next });
  };

  const primarySection = isPrimary ? (section as ContractPrimarySection) : null;

  return (
    <SectionCard
      title={title}
      style={{ borderRadius: 0, padding: 16, minWidth: 0, overflow: 'hidden' }}
      actions={
        onRemove && canEdit ? (
          <Button variant="ghost" tone="danger" size="sm" onClick={onRemove}>
            Удалить ДС
          </Button>
        ) : undefined
      }
    >

      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        <FormGrid columns="repeat(2, minmax(220px, 1fr))" gap={10}>
          <FormField label="Номер контракта">
            <Input
              value={section.number}
              disabled={!canEdit}
              onChange={(e) => update({ number: e.target.value })}
              style={{ width: '100%' }}
            />
          </FormField>
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
                <SearchSelectWithCreate
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
                />
              </FormField>
            </>
          )}
        </FormGrid>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label className="ui-muted">Марки двигателей</label>
            {canEdit && (
              <Button variant="ghost" size="sm" onClick={addEngineBrand}>
                + Строка
              </Button>
            )}
          </div>
          <DataTable>
              <colgroup>
                <col />
                <col style={{ width: 110 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 140 }} />
                {canEdit && <col style={{ width: 44 }} />}
              </colgroup>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Марка</th>
                  <th className="num">Кол-во</th>
                  <th className="num">Цена</th>
                  <th className="num">Сумма</th>
                  {canEdit && <th style={{ width: 40 }} />}
                </tr>
              </thead>
              <tbody>
                {section.engineBrands.map((row, idx) => {
                  const label = engineBrandOptions.find((o) => o.id === row.engineBrandId)?.label ?? (row.engineBrandId || '—');
                  return (
                    <tr key={idx}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                        {canEdit ? (
                          <div style={{ minWidth: 0 }}>
                            <SearchSelectWithCreate
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
                            />
                          </div>
                        ) : (
                          label
                        )}
                      </td>
                      <td className="num">
                        <NumericField
                          min={0}
                          value={row.qty}
                          disabled={!canEdit}
                          onChange={(next) => updateEngineBrand(idx, { qty: next })}
                          width={90}
                        />
                      </td>
                      <td className="num">
                        <NumericField
                          min={0}
                          value={row.unitPrice}
                          disabled={!canEdit}
                          onChange={(next) => updateEngineBrand(idx, { unitPrice: next })}
                          width={110}
                        />
                      </td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {rowSum(row.qty, row.unitPrice).toLocaleString('ru-RU')}
                      </td>
                      {canEdit && (
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                          <Button variant="ghost" tone="danger" size="sm" onClick={() => removeEngineBrand(idx)}>
                            ×
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {section.engineBrands.length === 0 && (
                  <tr>
                    <td colSpan={canEdit ? 5 : 4} style={{ padding: 12, color: 'var(--subtle)', fontSize: 13 }}>
                      Нет строк
                    </td>
                  </tr>
                )}
              </tbody>
          </DataTable>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label className="ui-muted">Детали</label>
            {canEdit && (
              <Button variant="ghost" size="sm" onClick={addPart}>
                + Строка
              </Button>
            )}
          </div>
          <DataTable>
              <colgroup>
                <col />
                <col style={{ width: 110 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 140 }} />
                {canEdit && <col style={{ width: 44 }} />}
              </colgroup>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Деталь</th>
                  <th className="num">Кол-во</th>
                  <th className="num">Цена</th>
                  <th className="num">Сумма</th>
                  {canEdit && <th style={{ width: 40 }} />}
                </tr>
              </thead>
              <tbody>
                {section.parts.map((row, idx) => {
                  const label = partOptions.find((o) => o.id === row.partId)?.label ?? (row.partId || '—');
                  return (
                    <tr key={idx}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                        {canEdit ? (
                          <div style={{ minWidth: 0 }}>
                            <SearchSelectWithCreate
                              value={row.partId || null}
                              options={partOptions}
                              disabled={!canEdit}
                              canCreate={props.canEditMasterData}
                              createLabel="Новая деталь"
                              onChange={(id) => updatePart(idx, { partId: id ?? '' })}
                              onCreate={async (label) => {
                                const id = await createMasterDataItem('part', label);
                                if (id) updatePart(idx, { partId: id });
                                return id;
                              }}
                            />
                          </div>
                        ) : (
                          label
                        )}
                      </td>
                      <td className="num">
                        <NumericField
                          min={0}
                          value={row.qty}
                          disabled={!canEdit}
                          onChange={(next) => updatePart(idx, { qty: next })}
                          width={90}
                        />
                      </td>
                      <td className="num">
                        <NumericField
                          min={0}
                          value={row.unitPrice}
                          disabled={!canEdit}
                          onChange={(next) => updatePart(idx, { unitPrice: next })}
                          width={110}
                        />
                      </td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {rowSum(row.qty, row.unitPrice).toLocaleString('ru-RU')}
                      </td>
                      {canEdit && (
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                          <Button variant="ghost" tone="danger" size="sm" onClick={() => removePart(idx)}>
                            ×
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {section.parts.length === 0 && (
                  <tr>
                    <td colSpan={canEdit ? 5 : 4} style={{ padding: 12, color: 'var(--subtle)', fontSize: 13 }}>
                      Нет строк
                    </td>
                  </tr>
                )}
              </tbody>
            </DataTable>
        </div>
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
  const [defs, setDefs] = useState<AttributeDef[]>([]);
  const [contractProgress, setContractProgress] = useState<number | null>(null);
  const [accountingForm, setAccountingForm] = useState<ContractAccountingForm>(EMPTY_ACCOUNTING_FORM);
  const dirtyRef = useRef(false);

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
      const d = (await window.matrica.admin.entities.get(props.contractId)) as ContractEntity;
      setContract(d);
      setSections(parseContractSections(d.attributes ?? {}));
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
      const rows = (await window.matrica.admin.entities.listByEntityType(type.id)) as Array<{ id: string; displayName?: string }>;
      const opts = rows.map((r) => ({ id: String(r.id), label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8) }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setEngineBrandOptions(opts);
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
      const rows = (await window.matrica.admin.entities.listByEntityType(type.id)) as Array<{ id: string; displayName?: string }>;
      const opts = rows.map((r) => ({ id: String(r.id), label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8) }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setCustomerOptions(opts);
    } catch {
      setCustomerOptions([]);
    }
  }

  async function loadParts() {
    try {
      const r = await window.matrica.parts.list({ limit: 5000 });
      if (!r?.ok || !r.parts) {
        setPartOptions([]);
        return;
      }
      const opts = r.parts.map((p: { id: string; name?: string; article?: string }) => ({
        id: p.id,
        label: [p.name, p.article].filter(Boolean).join(' — ') || p.id.slice(0, 8),
      }));
      opts.sort((a: LinkOpt, b: LinkOpt) => a.label.localeCompare(b.label, 'ru'));
      setPartOptions(opts);
    } catch {
      setPartOptions([]);
    }
  }

  async function loadProgress() {
    try {
      const engines = await window.matrica.engines.list();
      const byContract: ProgressLinkedItem[] = Array.isArray(engines) ? engines.filter((e) => e.contractId === props.contractId) : [];
      const partsRes = await window.matrica.parts.list({ limit: 5000 });
      const parts: ProgressLinkedItem[] = partsRes?.ok && partsRes.parts ? partsRes.parts : [];
      const partStatusMap = parts.filter((p) => p.contractId === props.contractId);
      const aggregate = aggregateProgress([
        ...byContract,
        ...partStatusMap,
      ]);
      setContractProgress(aggregate.progressPct);
    } catch {
      setContractProgress(null);
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
  }, [contract?.id, contract?.updatedAt, sections]);

  useEffect(() => {
    if (!contract) {
      setAccountingForm(EMPTY_ACCOUNTING_FORM);
      return;
    }
    setAccountingForm(buildAccountingForm(contract.attributes ?? {}));
  }, [contract?.id, contract?.updatedAt]);

  useLiveDataRefresh(
    async () => {
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
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        const contractTypeId = entityTypes.find((t) => t.code === 'contract')?.id;
        if (!contractTypeId) return;
        const created = await window.matrica.admin.entities.create(contractTypeId);
        if (created?.ok && 'id' in created && sections) {
          await window.matrica.admin.entities.setAttr(created.id, 'contract_sections', { ...sections, primary: { ...sections.primary, number: (sections.primary.number ?? '') + ' (копия)' } });
        }
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
  }, [sections, entityTypes, props.registerCardCloseActions]);

  async function createMasterDataItem(typeCode: string, label: string): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    if (typeCode === 'part') {
      const created = await window.matrica.parts.create({ attributes: { name: label } });
      if (!created?.ok || !created?.part?.id) return null;
      await loadParts();
      return created.part.id;
    }
    const typeId = entityTypes.find((t) => String(t.code) === typeCode)?.id ?? null;
    if (!typeId) return null;
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created?.ok || !created?.id) return null;
    const attrByType: Record<string, string> = { engine_brand: 'name', customer: 'name' };
    const attr = attrByType[typeCode] ?? 'name';
    await window.matrica.admin.entities.setAttr(created.id, attr, label);
    await loadEngineBrands();
    await loadCustomers();
    return created.id;
  }

  async function saveSections() {
    if (!props.canEdit || !sections) return;
    try {
      setStatus('Сохранение…');
      await window.matrica.admin.entities.setAttr(props.contractId, 'contract_sections', sections);
      const legacy = contractSectionsToLegacy(sections);
      await window.matrica.admin.entities.setAttr(props.contractId, 'number', legacy.number);
      await window.matrica.admin.entities.setAttr(props.contractId, 'internal_number', legacy.internal_number);
      await window.matrica.admin.entities.setAttr(props.contractId, 'date', legacy.date);
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 1200);
      void loadContract();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
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
    if (!props.canEditMasterData) return;
    const silent = opts?.silent === true;
    const shouldReload = opts?.reload !== false;
    try {
      if (!silent) setStatus('Сохранение реквизитов ГОЗ…');
      const nextRaw = buildSeparateAccountRaw(accountingForm);
      const nextAccount = parseSeparateAccount(nextRaw);

      await window.matrica.admin.entities.setAttr(props.contractId, 'goz_name', toTextValue(accountingForm.gozName).trim());
      await window.matrica.admin.entities.setAttr(props.contractId, 'goz_igk', toTextValue(accountingForm.igk).trim());
      await window.matrica.admin.entities.setAttr(props.contractId, 'has_files', Boolean(accountingForm.hasFiles));
      await window.matrica.admin.entities.setAttr(props.contractId, 'goz_separate_account', nextRaw);
      await window.matrica.admin.entities.setAttr(props.contractId, 'goz_separate_account_number', nextAccount.number);
      await window.matrica.admin.entities.setAttr(props.contractId, 'goz_separate_account_bank', nextAccount.bank);
      await window.matrica.admin.entities.setAttr(props.contractId, 'comment', toTextValue(accountingForm.comment).trim());

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
    if (props.canEditMasterData) {
      if (sections) await saveSections();
      await saveAccountingFields({ silent: true, reload: false });
    }
    dirtyRef.current = false;
  }

  async function handleDelete() {
    if (!props.canEditMasterData) return;
    if (!confirm('Удалить контракт?')) return;
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
        { number: '', signedAt: null, dueAt: null, engineBrands: [], parts: [] },
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
  const { totalQty, totalSum, maxDueAt } = useMemo(() => (sections ? computeSectionTotals(sections) : { totalQty: 0, totalSum: 0, maxDueAt: null }), [sections]);
  const daysLeft = maxDueAt != null ? Math.ceil((maxDueAt - Date.now()) / (24 * 60 * 60 * 1000)) : null;
  const progressPct = contractProgress != null ? contractProgress : 0;
  const executionState = getExecutionState(progressPct);

  function printContractCard() {
    if (!contract || !sections) return;
    const attrs = contract.attributes ?? {};
    const accounting = buildAccountingForm(attrs);
    const mainRows: Array<[string, string]> = [
      ['Номер', sections.primary.number || '—'],
      ['Дата заключения', toInputDate(sections.primary.signedAt) || '—'],
      ['Дата исполнения', toInputDate(sections.primary.dueAt) || '—'],
      ['Внутренний номер', sections.primary.internalNumber || '—'],
      ['Контрагент', customerOptions.find((o) => o.id === sections.primary.customerId)?.label ?? '—'],
      ['Наименование (ГОЗ)', accounting.gozName || '—'],
      ['ИГК', accounting.igk || '—'],
      ['Есть файлы', accounting.hasFiles ? 'Да' : 'Нет'],
      ['Отдельный счет (номер)', accounting.separateAccountNumber || '—'],
      ['Отдельный счет (банк)', accounting.separateAccountBank || '—'],
      ['Комментарий', accounting.comment || '—'],
      ['Кол-во (всего)', String(totalQty)],
      ['Сумма контракта', totalSum.toLocaleString('ru-RU') + ' ₽'],
    ];
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
        { id: 'main', title: 'Основное', html: keyValueTable(mainRows) },
        { id: 'files', title: 'Файлы', html: filesHtml },
        {
          id: 'meta',
          title: 'Карточка',
          html: keyValueTable([
            ['ID', contract.id],
            ['Создано', new Date(contract.createdAt).toLocaleString('ru-RU')],
            ['Обновлено', new Date(contract.updatedAt).toLocaleString('ru-RU')],
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
          canEdit={props.canEditMasterData}
          onCopyToNew={() => {
            void (async () => {
              const contractTypeId = entityTypes.find((t) => t.code === 'contract')?.id;
              if (!contractTypeId) return;
              const created = await window.matrica.admin.entities.create(contractTypeId);
              if (created?.ok && 'id' in created && sections) {
                await window.matrica.admin.entities.setAttr(created.id, 'contract_sections', { ...sections, primary: { ...sections.primary, number: (sections.primary.number ?? '') + ' (копия)' } });
              }
            })();
          }}
          onSaveAndClose={() => { void saveAllAndClose().then(() => props.onClose()); }}
          onCloseWithoutSave={() => { dirtyRef.current = false; props.onClose(); }}
          onDelete={() => void handleDelete()}
          onClose={() => props.requestClose?.()}
        />
      }
      actions={
        <RowActions>
          <Button variant="ghost" tone="info" onClick={printContractCard}>
            Распечатать
          </Button>
          <Button variant="ghost" tone="neutral" onClick={() => void loadContract()}>
            Обновить
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
            onChange={(primary) => { dirtyRef.current = true; setSections((s) => (s ? { ...s, primary: primary as ContractPrimarySection } : s)); }}
            canEdit={props.canEdit}
            canEditMasterData={props.canEditMasterData}
            createMasterDataItem={createMasterDataItem}
          />

          {sections.addons.map((addon, idx) => (
            <SectionBlock
              key={idx}
              title={`Дополнительное соглашение ${idx + 1}`}
              section={addon}
              isPrimary={false}
              engineBrandOptions={engineBrandOptions}
              partOptions={partOptions}
              onChange={(addonSection) => {
                dirtyRef.current = true;
                setSections((s) =>
                  s ? { ...s, addons: s.addons.map((a, i) => (i === idx ? addonSection : a)) } : s
                );
              }}
              onRemove={() => removeAddon(idx)}
              canEdit={props.canEdit}
              canEditMasterData={props.canEditMasterData}
              createMasterDataItem={createMasterDataItem}
            />
          ))}

          {props.canEdit && (
            <SectionCard style={{ borderRadius: 0, padding: 16, alignSelf: 'start', minWidth: 0 }}>
              <Button variant="outline" tone="neutral" onClick={addAddon} style={{ width: '100%' }}>
                + Добавить ДС
              </Button>
            </SectionCard>
          )}

          <SectionCard className="entity-card-span-full" title="Реквизиты ГОЗ (бухгалтерия)" style={{ borderRadius: 0, padding: 16 }}>
            <FormGrid columns="repeat(2, minmax(240px, 1fr))" gap={10}>
              <FormField label="Наименование (ГОЗ)" fullWidth>
                <Input
                  value={accountingForm.gozName}
                  disabled={!props.canEditMasterData}
                  onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, gozName: e.target.value })); }}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="ИГК">
                <Input
                  value={accountingForm.igk}
                  disabled={!props.canEditMasterData}
                  onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, igk: e.target.value })); }}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="Есть файлы">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 36 }}>
                  <input
                    type="checkbox"
                    checked={accountingForm.hasFiles}
                    disabled={!props.canEditMasterData}
                    onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, hasFiles: e.target.checked })); }}
                  />
                  <span>{accountingForm.hasFiles ? 'Да' : 'Нет'}</span>
                </label>
              </FormField>
              <FormField label="Отдельный счет (реквизиты)" fullWidth>
                <Input
                  value={accountingForm.separateAccountRaw}
                  disabled={!props.canEditMasterData}
                  onChange={(e) => setAccountingForm((s) => ({ ...s, separateAccountRaw: e.target.value }))}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="Отдельный счет (номер)">
                <Input
                  value={accountingForm.separateAccountNumber}
                  disabled={!props.canEditMasterData}
                  onChange={(e) => setAccountingForm((s) => ({ ...s, separateAccountNumber: e.target.value }))}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="Отдельный счет (банк)">
                <Input
                  value={accountingForm.separateAccountBank}
                  disabled={!props.canEditMasterData}
                  onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, separateAccountBank: e.target.value })); }}
                  style={{ width: '100%' }}
                />
              </FormField>
              <FormField label="Комментарий" fullWidth>
                <Input
                  value={accountingForm.comment}
                  disabled={!props.canEditMasterData}
                  onChange={(e) => { dirtyRef.current = true; setAccountingForm((s) => ({ ...s, comment: e.target.value })); }}
                  style={{ width: '100%' }}
                />
              </FormField>
            </FormGrid>
            {props.canEditMasterData && (
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
                <div style={{ fontSize: 18, fontWeight: 600 }}>{totalSum.toLocaleString('ru-RU')} ₽</div>
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
                    background: 'var(--success)',
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
                void window.matrica.admin.entities.setAttr(props.contractId, 'attachments', next).then(() => void loadContract());
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
                      void window.matrica.admin.entities.setAttr(props.contractId, def.code, next).then(() => void loadContract());
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
