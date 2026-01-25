import React, { useEffect, useMemo, useState } from 'react';

import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { SearchSelect } from './components/SearchSelect.js';
import { AttachmentsPanel } from './components/AttachmentsPanel.js';
import {
  getEntity,
  listAttributeDefs,
  listEntities,
  listEntityTypes,
  setEntityAttr,
  createEntity,
  upsertAttributeDef,
} from '../api/masterdata.js';

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

type EngineCountItem = { label: string; count: number };

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

function parseMetaJson(meta: unknown): Record<string, unknown> | null {
  if (!meta) return null;
  if (typeof meta === 'object') return meta as any;
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

function getLinkTargetTypeCode(def: AttributeDef): string | null {
  const meta = parseMetaJson(def.metaJson);
  const code = meta?.linkTargetTypeCode;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

function calcEngineTotal(items: EngineCountItem[]): number {
  return items.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
}

export function ContractDetailsPage(props: {
  contractId: string;
  canEditMasterData: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
}) {
  const [contract, setContract] = useState<ContractEntity | null>(null);
  const [defs, setDefs] = useState<AttributeDef[]>([]);
  const [status, setStatus] = useState<string>('');
  const [contractTypeId, setContractTypeId] = useState<string>('');
  const [entityTypes, setEntityTypes] = useState<Array<{ id: string; code: string; name: string }>>([]);

  const [engineBrandOptions, setEngineBrandOptions] = useState<LinkOpt[]>([]);
  const [engineBrandId, setEngineBrandId] = useState<string>('');

  const [number, setNumber] = useState<string>('');
  const [internalNumber, setInternalNumber] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const [contractAmount, setContractAmount] = useState<string>('');
  const [unitPrice, setUnitPrice] = useState<string>('');

  const [engineCountItems, setEngineCountItems] = useState<EngineCountItem[]>([]);
  const [editingAttr, setEditingAttr] = useState<Record<string, unknown>>({});

  const [linkOptionsByCode, setLinkOptionsByCode] = useState<Record<string, LinkOpt[]>>({});
  const [linkLoadingByCode, setLinkLoadingByCode] = useState<Record<string, boolean>>({});

  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [newFieldCode, setNewFieldCode] = useState('');
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldFormat, setNewFieldFormat] = useState<'text' | 'number' | 'boolean' | 'date' | 'json' | 'link' | 'file' | 'image'>('text');
  const [newFieldSortOrder, setNewFieldSortOrder] = useState('100');
  const [newFieldIsRequired, setNewFieldIsRequired] = useState(false);
  const [newFieldLinkTarget, setNewFieldLinkTarget] = useState('');
  const [addFieldStatus, setAddFieldStatus] = useState('');

  async function loadContract() {
    try {
      setStatus('Загрузка…');
      const typesRes = await listEntityTypes();
      if (!typesRes?.ok) throw new Error(typesRes?.error ?? 'types load failed');
      const types = typesRes.rows ?? [];
      setEntityTypes(types);
      const contractType = types.find((t: any) => String(t.code) === 'contract') ?? null;
      if (!contractType?.id) {
        setContract(null);
        setDefs([]);
        setStatus('Справочник «Контракты» не найден (contract).');
        return;
      }
      setContractTypeId(String(contractType.id));
      const d = await getEntity(props.contractId);
      if (!d?.ok) throw new Error(d?.error ?? 'contract load failed');
      setContract(d.entity as any);
      const defsRes = await listAttributeDefs(String(contractType.id));
      if (defsRes?.ok) setDefs(defsRes.rows ?? []);
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
      const rowsRes = await listEntities(String(type.id));
      if (!rowsRes?.ok) {
        setEngineBrandOptions([]);
        return;
      }
      const opts = (rowsRes.rows as any[]).map((r) => ({
        id: String(r.id),
        label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setEngineBrandOptions(opts);
    } catch {
      setEngineBrandOptions([]);
    }
  }

  useEffect(() => {
    void loadContract();
  }, [props.contractId]);

  useEffect(() => {
    if (entityTypes.length === 0) return;
    void loadEngineBrands();
  }, [entityTypes.length]);

  useEffect(() => {
    if (!contract) return;
    const attrs = contract.attributes ?? {};
    setNumber(String(attrs.number ?? ''));
    setInternalNumber(String(attrs.internal_number ?? ''));
    setDate(typeof attrs.date === 'number' ? toInputDate(attrs.date) : '');
    setContractAmount(attrs.contract_amount_rub == null ? '' : String(attrs.contract_amount_rub));
    setUnitPrice(attrs.unit_price_rub == null ? '' : String(attrs.unit_price_rub));
    setEngineBrandId(String(attrs.engine_brand_id ?? ''));

    const items = Array.isArray(attrs.engine_count_items)
      ? (attrs.engine_count_items as any[]).map((i) => ({
          label: String(i?.label ?? ''),
          count: Number(i?.count ?? 0) || 0,
        }))
      : [];
    if (items.length === 0) {
      setEngineCountItems([{ label: 'Количество двигателей по первоначальному контракту', count: 0 }]);
    } else {
      setEngineCountItems(items);
    }
  }, [contract?.id, contract?.updatedAt]);

  async function saveAttr(code: string, value: unknown) {
    if (!props.canEditMasterData) return;
    try {
      setStatus('Сохранение…');
      const r = await setEntityAttr(props.contractId, code, value);
      if (!r?.ok) {
        setStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 1200);
      void loadContract();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function saveEngineCounts(items: EngineCountItem[]) {
    const total = calcEngineTotal(items);
    await saveAttr('engine_count_items', items);
    await saveAttr('engine_count_total', total);
  }

  async function saveCore() {
    if (!props.canEditMasterData) return;
    await saveAttr('number', number);
    await saveAttr('internal_number', internalNumber);
    await saveAttr('date', fromInputDate(date));
    await saveAttr('engine_brand_id', engineBrandId || null);
    await saveAttr('contract_amount_rub', contractAmount ? Number(contractAmount) : null);
    await saveAttr('unit_price_rub', unitPrice ? Number(unitPrice) : null);
    await saveEngineCounts(engineCountItems);
  }

  async function createMasterDataItem(typeCode: string, label: string): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    const typeId = entityTypes.find((t) => String(t.code) === typeCode)?.id ?? null;
    if (!typeId) return null;
    const created = await createEntity(String(typeId));
    if (!created?.ok || !created?.id) return null;
    await setEntityAttr(created.id, 'name', label);
    await loadEngineBrands();
    return created.id;
  }

  async function loadLinkOptions(typeCode: string, attrCode: string) {
    if (!typeCode) return;
    setLinkLoadingByCode((p) => ({ ...p, [attrCode]: true }));
    try {
      const type = entityTypes.find((t) => String(t.code) === typeCode) ?? null;
      if (!type?.id) {
        setLinkOptionsByCode((p) => ({ ...p, [attrCode]: [] }));
        return;
      }
      const rowsRes = await listEntities(String(type.id));
      if (!rowsRes?.ok) {
        setLinkOptionsByCode((p) => ({ ...p, [attrCode]: [] }));
        return;
      }
      const opts = (rowsRes.rows as any[]).map((r) => ({
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

  useEffect(() => {
    if (!contract || defs.length === 0) return;
    for (const def of defs) {
      if (def.dataType !== 'link') continue;
      const targetTypeCode = getLinkTargetTypeCode(def);
      if (!targetTypeCode) continue;
      if (linkOptionsByCode[def.code] || linkLoadingByCode[def.code]) continue;
      void loadLinkOptions(targetTypeCode, def.code);
    }
  }, [contract?.id, contract?.updatedAt, defs.length, linkOptionsByCode, linkLoadingByCode, entityTypes.length]);

  async function createNewField() {
    if (!props.canEditMasterData) return;
    try {
      const code = newFieldCode.trim();
      const name = newFieldName.trim();
      if (!contractTypeId) {
        setAddFieldStatus('Ошибка: тип контракта не найден');
        return;
      }
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
      if (newFieldFormat === 'link' && !newFieldLinkTarget) {
        setAddFieldStatus('Ошибка: выберите справочник');
        return;
      }
      const sortOrder = Number(newFieldSortOrder) || 0;
      const dataType = newFieldFormat === 'file' || newFieldFormat === 'image' ? 'json' : newFieldFormat;
      const metaJson =
        newFieldFormat === 'link'
          ? JSON.stringify({ linkTargetTypeCode: newFieldLinkTarget })
          : newFieldFormat === 'file' || newFieldFormat === 'image'
            ? JSON.stringify({ ui: 'files', category: code, kind: newFieldFormat })
            : null;

      setAddFieldStatus('Создание поля…');
      const r = await upsertAttributeDef({
        entityTypeId: contractTypeId,
        code,
        name,
        dataType,
        isRequired: newFieldIsRequired,
        sortOrder,
        metaJson,
      });
      if (!r?.ok) {
        setAddFieldStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      setAddFieldStatus('Поле добавлено');
      setTimeout(() => setAddFieldStatus(''), 1200);
      setAddFieldOpen(false);
      setNewFieldCode('');
      setNewFieldName('');
      setNewFieldFormat('text');
      setNewFieldSortOrder('100');
      setNewFieldIsRequired(false);
      setNewFieldLinkTarget('');
      void loadContract();
    } catch (e) {
      setAddFieldStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!contract) {
    return <div>{status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}</div>;
  }

  const sortedDefs = [...defs].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  const coreCodes = new Set([
    'number',
    'internal_number',
    'date',
    'engine_brand_id',
    'engine_count_items',
    'engine_count_total',
    'contract_amount_rub',
    'unit_price_rub',
    'attachments',
  ]);
  const fileDefs = sortedDefs.filter((d) => d.dataType === 'json' && parseMetaJson(d.metaJson)?.ui === 'files');
  const extraDefs = sortedDefs.filter((d) => !coreCodes.has(d.code) && !fileDefs.find((f) => f.code === d.code));

  const engineTotal = calcEngineTotal(engineCountItems);
  const headerTitle = number.trim() ? `Контракт: ${number.trim()}` : 'Карточка контракта';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ fontSize: 20, fontWeight: 800, flex: 1 }}>{headerTitle}</div>
        {status && <div style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 12 }}>{status}</div>}
        <Button variant="ghost" onClick={() => void loadContract()}>
          Обновить
        </Button>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(520px, 1fr))', gap: 10 }}>
        <div className="card">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <strong>Основное</strong>
            <span style={{ flex: 1 }} />
            {props.canEditMasterData && (
              <Button variant="ghost" onClick={() => void saveCore()}>
                Сохранить
              </Button>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 180px) 1fr', gap: 10, alignItems: 'center' }}>
            <div style={{ color: '#6b7280' }}>Номер контракта</div>
            <Input value={number} disabled={!props.canEditMasterData} onChange={(e) => setNumber(e.target.value)} onBlur={() => void saveAttr('number', number)} />

            <div style={{ color: '#6b7280' }}>Дата контракта</div>
            <Input type="date" value={date} disabled={!props.canEditMasterData} onChange={(e) => setDate(e.target.value)} onBlur={() => void saveAttr('date', fromInputDate(date))} />

            <div style={{ color: '#6b7280' }}>Внутренний номер</div>
            <Input value={internalNumber} disabled={!props.canEditMasterData} onChange={(e) => setInternalNumber(e.target.value)} onBlur={() => void saveAttr('internal_number', internalNumber)} />

            <div style={{ color: '#6b7280' }}>Марка двигателя</div>
            <SearchSelect
              value={engineBrandId || null}
              options={engineBrandOptions}
              disabled={!props.canEditMasterData}
              onChange={(next) => {
                const v = next ?? '';
                setEngineBrandId(v);
                void saveAttr('engine_brand_id', next ?? null);
              }}
              onCreate={props.canEditMasterData ? async (label) => createMasterDataItem('engine_brand', label) : undefined}
              createLabel="Новая марка двигателя"
            />

            <div style={{ color: '#6b7280' }}>Сумма контракта (₽)</div>
            <Input
              type="number"
              value={contractAmount}
              disabled={!props.canEditMasterData}
              onChange={(e) => setContractAmount(e.target.value)}
              onBlur={() => void saveAttr('contract_amount_rub', contractAmount ? Number(contractAmount) : null)}
            />

            <div style={{ color: '#6b7280' }}>Цена за единицу (₽)</div>
            <Input
              type="number"
              value={unitPrice}
              disabled={!props.canEditMasterData}
              onChange={(e) => setUnitPrice(e.target.value)}
              onBlur={() => void saveAttr('unit_price_rub', unitPrice ? Number(unitPrice) : null)}
            />
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <strong>Количество двигателей</strong>
            <span style={{ flex: 1 }} />
            {props.canEditMasterData && (
              <Button variant="ghost" onClick={() => void saveEngineCounts(engineCountItems)}>
                Сохранить
              </Button>
            )}
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {engineCountItems.map((item, idx) => (
              <div key={`${idx}-${item.label}`} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 80px', gap: 8 }}>
                <Input
                  value={item.label}
                  disabled={!props.canEditMasterData}
                  placeholder="Описание (например: Допсоглашение №45)"
                  onChange={(e) => {
                    const next = [...engineCountItems];
                    next[idx] = { ...next[idx], label: e.target.value };
                    setEngineCountItems(next);
                  }}
                  onBlur={() => void saveEngineCounts(engineCountItems)}
                />
                <Input
                  type="number"
                  value={String(item.count ?? 0)}
                  disabled={!props.canEditMasterData}
                  onChange={(e) => {
                    const next = [...engineCountItems];
                    next[idx] = { ...next[idx], count: Number(e.target.value) || 0 };
                    setEngineCountItems(next);
                  }}
                  onBlur={() => void saveEngineCounts(engineCountItems)}
                />
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (!props.canEditMasterData) return;
                    const next = engineCountItems.filter((_, i) => i !== idx);
                    const fallback = next.length ? next : [{ label: 'Количество двигателей по первоначальному контракту', count: 0 }];
                    setEngineCountItems(fallback);
                    void saveEngineCounts(fallback);
                  }}
                >
                  Удалить
                </Button>
              </div>
            ))}
            {props.canEditMasterData && (
              <Button variant="ghost" onClick={() => setEngineCountItems((prev) => [...prev, { label: '', count: 0 }])}>
                + Добавить строку
              </Button>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 80px', gap: 8, alignItems: 'center' }}>
              <div style={{ color: '#6b7280' }}>Итого по контракту</div>
              <Input value={String(engineTotal)} disabled />
              <span />
            </div>
          </div>
        </div>

        <div style={{ gridColumn: '1 / -1' }}>
          <AttachmentsPanel
            title="Вложения к контракту"
            value={contract.attributes?.attachments}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEditMasterData}
            scope={{ ownerType: 'contract', ownerId: contract.id, category: 'attachments' }}
            onChange={(next) => saveAttr('attachments', next)}
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
                  canUpload={props.canUploadFiles && props.canEditMasterData}
                  scope={{ ownerType: 'contract', ownerId: contract.id, category }}
                  onChange={(next) => saveAttr(def.code, next)}
                />
              );
            })}
          </div>
        )}

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <strong>Дополнительные поля</strong>
            <span style={{ flex: 1 }} />
            {addFieldStatus && (
              <span style={{ color: addFieldStatus.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 12 }}>{addFieldStatus}</span>
            )}
            {props.canEditMasterData && (
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
          </div>

          {addFieldOpen && props.canEditMasterData && (
            <div style={{ marginBottom: 14, border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Новое поле для контрактов (появится в карточке у всех контрактов).</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8, alignItems: 'center' }}>
                <Input value={newFieldCode} onChange={(e) => setNewFieldCode(e.target.value)} placeholder="code (например: note)" />
                <Input value={newFieldName} onChange={(e) => setNewFieldName(e.target.value)} placeholder="название (например: Примечание)" />

                <select
                  value={newFieldFormat}
                  onChange={(e) => setNewFieldFormat(e.target.value as any)}
                  style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                >
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="date">date</option>
                  <option value="json">json</option>
                  <option value="link">link</option>
                  <option value="file">file</option>
                  <option value="image">image</option>
                </select>

                <Input value={newFieldSortOrder} onChange={(e) => setNewFieldSortOrder(e.target.value)} placeholder="sortOrder (например: 300)" />

                <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: '#111827', fontSize: 14 }}>
                  <input type="checkbox" checked={newFieldIsRequired} onChange={(e) => setNewFieldIsRequired(e.target.checked)} />
                  обязательное
                </label>

                {newFieldFormat === 'link' && (
                  <select
                    value={newFieldLinkTarget}
                    onChange={(e) => setNewFieldLinkTarget(e.target.value)}
                    style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                  >
                    <option value="">связь с (раздел)…</option>
                    {entityTypes.map((t) => (
                      <option key={t.id} value={t.code}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}

                <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
                  <Button onClick={() => void createNewField()}>Добавить</Button>
                  <Button variant="ghost" onClick={() => setAddFieldOpen(false)}>
                    Отмена
                  </Button>
                </div>
              </div>
            </div>
          )}

          {extraDefs.length === 0 ? (
            <div style={{ color: '#6b7280', fontSize: 13 }}>Нет дополнительных полей.</div>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              {extraDefs.map((def) => {
                const value = editingAttr[def.code] !== undefined ? editingAttr[def.code] : contract.attributes?.[def.code];
                const isEditing = editingAttr[def.code] !== undefined;
                const linkOpt =
                  def.dataType === 'link' && typeof value === 'string'
                    ? (linkOptionsByCode[def.code] ?? []).find((o) => o.id === value) ?? null
                    : null;

                return (
                  <div key={def.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontWeight: 600, fontSize: 14, color: '#374151' }}>
                      {def.name}
                      <span style={{ color: '#6b7280', fontWeight: 400 }}> ({def.code})</span>
                      {def.isRequired && <span style={{ color: '#b91c1c' }}> *</span>}
                    </label>
                    {!props.canEditMasterData || !isEditing ? (
                      <div
                        style={{
                          padding: '10px 12px',
                          border: '1px solid #e5e7eb',
                          borderRadius: 8,
                          backgroundColor: props.canEditMasterData ? '#f9fafb' : '#ffffff',
                          fontSize: 14,
                          color: '#111827',
                          cursor: props.canEditMasterData ? 'pointer' : 'default',
                          whiteSpace: 'pre-wrap',
                        }}
                        onClick={() => {
                          if (props.canEditMasterData) setEditingAttr({ ...editingAttr, [def.code]: value });
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
                        {def.dataType === 'text' ? (
                          <Input value={String(value ?? '')} onChange={(e) => setEditingAttr({ ...editingAttr, [def.code]: e.target.value })} style={{ flex: 1 }} />
                        ) : def.dataType === 'link' ? (
                          <SearchSelect
                            value={typeof value === 'string' && value ? value : null}
                            options={linkOptionsByCode[def.code] ?? []}
                            placeholder="Выберите значение"
                            disabled={!props.canEditMasterData || linkLoadingByCode[def.code]}
                            onChange={(next) => setEditingAttr({ ...editingAttr, [def.code]: next })}
                          />
                        ) : def.dataType === 'number' ? (
                          <Input
                            type="number"
                            value={String(value ?? '')}
                            onChange={(e) => setEditingAttr({ ...editingAttr, [def.code]: Number(e.target.value) || 0 })}
                            style={{ flex: 1 }}
                          />
                        ) : def.dataType === 'boolean' ? (
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <input type="checkbox" checked={!!value} onChange={(e) => setEditingAttr({ ...editingAttr, [def.code]: e.target.checked })} />
                            <span>{value ? 'Да' : 'Нет'}</span>
                          </label>
                        ) : def.dataType === 'date' ? (
                          <Input
                            type="date"
                            value={value && typeof value === 'number' ? toInputDate(value) : ''}
                            onChange={(e) => {
                              const d = fromInputDate(e.target.value);
                              setEditingAttr({ ...editingAttr, [def.code]: d });
                            }}
                            style={{ flex: 1 }}
                          />
                        ) : (
                          <Input
                            value={JSON.stringify(value ?? '')}
                            onChange={(e) => {
                              try {
                                const parsed = JSON.parse(e.target.value);
                                setEditingAttr({ ...editingAttr, [def.code]: parsed });
                              } catch {
                                // ignore
                              }
                            }}
                            style={{ flex: 1 }}
                          />
                        )}
                        <Button
                          onClick={() => {
                            void saveAttr(def.code, value);
                            const next = { ...editingAttr };
                            delete next[def.code];
                            setEditingAttr(next);
                          }}
                        >
                          Сохранить
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            const next = { ...editingAttr };
                            delete next[def.code];
                            setEditingAttr(next);
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
    </div>
  );
}
