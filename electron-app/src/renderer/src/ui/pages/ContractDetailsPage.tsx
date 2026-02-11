import React, { useEffect, useState, useMemo } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
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
    next[idx] = { ...next[idx], ...patch };
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
    next[idx] = { ...next[idx], ...patch };
    update({ parts: next });
  };

  const primarySection = isPrimary ? (section as ContractPrimarySection) : null;

  return (
    <div className="card-panel" style={{ borderRadius: 12, padding: 16, minWidth: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <strong>{title}</strong>
        <span style={{ flex: 1 }} />
        {onRemove && canEdit && (
          <Button variant="ghost" tone="danger" size="sm" onClick={onRemove}>
            Удалить ДС
          </Button>
        )}
      </div>

      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, minWidth: 0 }}>
          <div style={{ minWidth: 0 }}>
            <label style={{ fontSize: 12, color: '#6b7280' }}>Номер</label>
            <Input
              value={section.number}
              disabled={!canEdit}
              onChange={(e) => update({ number: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <label style={{ fontSize: 12, color: '#6b7280' }}>Дата заключения</label>
            <Input
              type="date"
              value={toInputDate(section.signedAt)}
              disabled={!canEdit}
              onChange={(e) => update({ signedAt: fromInputDate(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <label style={{ fontSize: 12, color: '#6b7280' }}>Дата исполнения</label>
            <Input
              type="date"
              value={toInputDate(section.dueAt)}
              disabled={!canEdit}
              onChange={(e) => update({ dueAt: fromInputDate(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>
          {isPrimary && primarySection && (
            <>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Внутренний номер</label>
                <Input
                  value={primarySection.internalNumber}
                  disabled={!canEdit}
                  onChange={(e) => update({ internalNumber: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Контрагент</label>
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
              </div>
            </>
          )}
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: '#6b7280' }}>Марки двигателей</label>
            {canEdit && (
              <Button variant="ghost" size="sm" onClick={addEngineBrand}>
                + Строка
              </Button>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #e5e7eb' }}>Марка</th>
                  <th style={{ width: 92, textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #e5e7eb' }}>Кол-во</th>
                  <th style={{ width: 110, textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #e5e7eb' }}>Цена</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #e5e7eb' }}>Сумма</th>
                  {canEdit && <th style={{ width: 40 }} />}
                </tr>
              </thead>
              <tbody>
                {section.engineBrands.map((row, idx) => {
                  const label = engineBrandOptions.find((o) => o.id === row.engineBrandId)?.label ?? (row.engineBrandId || '—');
                  return (
                    <tr key={idx}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>
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
                      <td style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #f3f4f6' }}>
                        <Input
                          type="number"
                          min={0}
                          value={row.qty}
                          disabled={!canEdit}
                          onChange={(e) => updateEngineBrand(idx, { qty: Number(e.target.value) || 0 })}
                          style={{ width: 70, textAlign: 'right' }}
                        />
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #f3f4f6' }}>
                        <Input
                          type="number"
                          min={0}
                          value={row.unitPrice}
                          disabled={!canEdit}
                          onChange={(e) => updateEngineBrand(idx, { unitPrice: Number(e.target.value) || 0 })}
                          style={{ width: 90, textAlign: 'right' }}
                        />
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #f3f4f6' }}>
                        {rowSum(row.qty, row.unitPrice).toLocaleString('ru-RU')}
                      </td>
                      {canEdit && (
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>
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
                    <td colSpan={canEdit ? 5 : 4} style={{ padding: 12, color: '#9ca3af', fontSize: 13 }}>
                      Нет строк
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: '#6b7280' }}>Детали</label>
            {canEdit && (
              <Button variant="ghost" size="sm" onClick={addPart}>
                + Строка
              </Button>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #e5e7eb' }}>Деталь</th>
                  <th style={{ width: 92, textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #e5e7eb' }}>Кол-во</th>
                  <th style={{ width: 110, textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #e5e7eb' }}>Цена</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #e5e7eb' }}>Сумма</th>
                  {canEdit && <th style={{ width: 40 }} />}
                </tr>
              </thead>
              <tbody>
                {section.parts.map((row, idx) => {
                  const label = partOptions.find((o) => o.id === row.partId)?.label ?? (row.partId || '—');
                  return (
                    <tr key={idx}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>
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
                      <td style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #f3f4f6' }}>
                        <Input
                          type="number"
                          min={0}
                          value={row.qty}
                          disabled={!canEdit}
                          onChange={(e) => updatePart(idx, { qty: Number(e.target.value) || 0 })}
                          style={{ width: 70, textAlign: 'right' }}
                        />
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #f3f4f6' }}>
                        <Input
                          type="number"
                          min={0}
                          value={row.unitPrice}
                          disabled={!canEdit}
                          onChange={(e) => updatePart(idx, { unitPrice: Number(e.target.value) || 0 })}
                          style={{ width: 90, textAlign: 'right' }}
                        />
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #f3f4f6' }}>
                        {rowSum(row.qty, row.unitPrice).toLocaleString('ru-RU')}
                      </td>
                      {canEdit && (
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>
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
                    <td colSpan={canEdit ? 5 : 4} style={{ padding: 12, color: '#9ca3af', fontSize: 13 }}>
                      Нет строк
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ContractDetailsPage(props: {
  contractId: string;
  canEdit: boolean;
  canEditMasterData: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  onClose: () => void;
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
      defsList = (await ensureAttributeDefs(contractType.id, [{ code: 'contract_sections', name: 'Секции контракта', dataType: 'json', sortOrder: 5 }], defsList as AttributeDefRow[])) as AttributeDef[];
      setDefs(defsList);
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

  async function saveAllAndClose() {
    if (props.canEditMasterData && sections) {
      await saveSections();
    }
    props.onClose();
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
    setSections({
      ...sections,
      addons: sections.addons.filter((_, i) => i !== idx),
    });
  }

  const headerTitle = sections?.primary.number?.trim() ? `Контракт: ${sections.primary.number.trim()}` : 'Карточка контракта';
  const { totalQty, totalSum, maxDueAt } = useMemo(() => (sections ? computeSectionTotals(sections) : { totalQty: 0, totalSum: 0, maxDueAt: null }), [sections]);
  const daysLeft = maxDueAt != null ? Math.ceil((maxDueAt - Date.now()) / (24 * 60 * 60 * 1000)) : null;
  const progressPct = contractProgress != null ? contractProgress : 0;

  function printContractCard() {
    if (!contract || !sections) return;
    const attrs = contract.attributes ?? {};
    const mainRows: Array<[string, string]> = [
      ['Номер', sections.primary.number || '—'],
      ['Дата заключения', toInputDate(sections.primary.signedAt) || '—'],
      ['Дата исполнения', toInputDate(sections.primary.dueAt) || '—'],
      ['Внутренний номер', sections.primary.internalNumber || '—'],
      ['Контрагент', customerOptions.find((o) => o.id === sections.primary.customerId)?.label ?? '—'],
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
      subtitle: sections.primary.number ? `Номер: ${sections.primary.number}` : undefined,
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
    return <div>{status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}</div>;
  }

  const fileDefs = defs.filter((d) => d.dataType === 'json' && parseMetaJson(d.metaJson)?.ui === 'files');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
        <div style={{ margin: 0, flex: '1 1 320px', minWidth: 0, fontSize: 20, fontWeight: 800 }}>{headerTitle}</div>
        {props.canEditMasterData && (
          <Button variant="ghost" tone="success" onClick={() => void saveAllAndClose()}>
            Сохранить
          </Button>
        )}
        {props.canEditMasterData && (
          <Button variant="ghost" tone="danger" onClick={() => void handleDelete()}>
            Удалить
          </Button>
        )}
        <Button variant="ghost" tone="info" onClick={printContractCard}>
          Распечатать
        </Button>
        {status && <div style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 12 }}>{status}</div>}
        <Button variant="ghost" tone="neutral" onClick={() => void loadContract()}>
          Обновить
        </Button>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16, minWidth: 0, width: '100%', maxWidth: 1400 }}>
          <SectionBlock
            title="Первичный контракт"
            section={sections.primary}
            isPrimary
            engineBrandOptions={engineBrandOptions}
            partOptions={partOptions}
            customerOptions={customerOptions}
            onChange={(primary) => setSections((s) => (s ? { ...s, primary } : s))}
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
              onChange={(addonSection) =>
                setSections((s) =>
                  s ? { ...s, addons: s.addons.map((a, i) => (i === idx ? addonSection : a)) } : s
                )
              }
              onRemove={() => removeAddon(idx)}
              canEdit={props.canEdit}
              canEditMasterData={props.canEditMasterData}
              createMasterDataItem={createMasterDataItem}
            />
          ))}

          {props.canEdit && (
            <div className="card-panel" style={{ borderRadius: 12, padding: 16, alignSelf: 'start', minWidth: 0 }}>
              <Button variant="outline" tone="neutral" onClick={addAddon} style={{ width: '100%' }}>
                + Добавить ДС
              </Button>
            </div>
          )}

          <div className="card-panel" style={{ gridColumn: '1 / -1', borderRadius: 12, padding: 16 }}>
            <strong>Сводка</strong>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Кол-во</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{totalQty}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Сумма контракта</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{totalSum.toLocaleString('ru-RU')} ₽</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Дней до окончания</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{daysLeft != null ? daysLeft : '—'}</div>
              </div>
            </div>
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12, color: '#6b7280' }}>
                <span>Прогресс выполнения</span>
                <span>{contractProgress != null ? Math.round(progressPct) + '%' : '—'}</span>
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: '#e5e7eb',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, Math.max(0, progressPct))}%`,
                    height: '100%',
                    background: 'var(--color-success, #22c55e)',
                    transition: 'width 0.2s',
                  }}
                />
              </div>
            </div>
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
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
            <div style={{ gridColumn: '1 / -1' }}>
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
      </div>
    </div>
  );
}
