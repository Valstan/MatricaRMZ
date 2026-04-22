import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { EngineInstanceListItem, NomenclatureItemType, WarehouseMovementListItem, WarehouseNomenclatureListItem, WarehouseStockListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { NomenclatureTemplateCompositionEditor } from '../components/NomenclatureTemplateCompositionEditor.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { useRecentSelectOptions } from '../hooks/useRecentSelectOptions.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import {
  appendTemplateProperty,
  parseTemplatePropertiesJson,
  serializeTemplatePropertiesJson,
} from '../utils/nomenclatureTemplateProperties.js';
import { lookupToSelectOptions, WAREHOUSE_ITEM_TYPE_OPTIONS, warehouseDocTypeLabel } from '../utils/warehouseUi.js';

function parseEnumValuesFromOptionsJson(optionsJson: string | null | undefined): string[] {
  if (!optionsJson?.trim()) return [];
  try {
    const v = JSON.parse(optionsJson) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v) && 'values' in v && Array.isArray((v as { values: unknown }).values)) {
      return ((v as { values: unknown[] }).values ?? []).map((x) => String(x));
    }
    if (Array.isArray(v)) return v.map((x) => String(x));
  } catch {
    /* ignore */
  }
  return [];
}

export function NomenclatureDetailsPage(props: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { confirm } = useConfirm();
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const [status, setStatus] = useState('');
  const [row, setRow] = useState<WarehouseNomenclatureListItem | null>(null);
  const [balances, setBalances] = useState<WarehouseStockListItem[]>([]);
  const [movements, setMovements] = useState<WarehouseMovementListItem[]>([]);
  const [instances, setInstances] = useState<EngineInstanceListItem[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [itemType, setItemType] = useState('material');
  const [category, setCategory] = useState<'engine' | 'component' | 'assembly'>('component');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [barcode, setBarcode] = useState('');
  const [minStock, setMinStock] = useState('');
  const [maxStock, setMaxStock] = useState('');
  const [defaultBrandId, setDefaultBrandId] = useState<string | null>(null);
  const [isSerialTracked, setIsSerialTracked] = useState(false);
  const [defaultWarehouseId, setDefaultWarehouseId] = useState<string | null>(null);
  const [specJson, setSpecJson] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [propertyValues, setPropertyValues] = useState<Record<string, unknown>>({});
  const [typeOptions, setTypeOptions] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [templateRows, setTemplateRows] = useState<
    Array<{ id: string; code: string; name: string; itemTypeCode: string; directoryKind: string; propertiesJson: string }>
  >([]);
  const [propertyRows, setPropertyRows] = useState<Array<{ id: string; code: string; name: string; dataType?: string | null; optionsJson?: string | null }>>([]);
  const [templateCompositionOpen, setTemplateCompositionOpen] = useState(false);
  const [showAdvancedSpec, setShowAdvancedSpec] = useState(false);
  const [addPropertyPickId, setAddPropertyPickId] = useState<string | null>(null);
  const [quickPropCode, setQuickPropCode] = useState('');
  const [quickPropName, setQuickPropName] = useState('');
  const [quickPropDataType, setQuickPropDataType] = useState('text');
  const [instanceSerial, setInstanceSerial] = useState('');
  const [instanceContractId, setInstanceContractId] = useState<string | null>(null);
  const [instanceWarehouseId, setInstanceWarehouseId] = useState<string | null>('default');
  const { pushRecent, withRecents } = useRecentSelectOptions(`matrica:nomenclature-field-recents:${props.id}`, 8);

  const createLookupEntity = useCallback(async (typeCode: string, label: string): Promise<string | null> => {
    const clean = String(label ?? '').trim();
    if (!clean) return null;
    const types = await window.matrica.admin.entityTypes.list();
    const type = types.find((row) => String(row.code ?? '').trim().toLowerCase() === typeCode);
    const typeId = String(type?.id ?? '').trim();
    if (!typeId) return null;
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created?.ok || !created.id) return null;
    const entityId = String(created.id);
    await window.matrica.admin.entities.setAttr(entityId, 'name', clean).catch(() => null);
    await window.matrica.admin.entities.setAttr(entityId, 'code', clean).catch(() => null);
    return entityId;
  }, []);

  const load = useCallback(async () => {
    try {
      setStatus('Загрузка...');
      const [list, stock, movementRes, instancesRes] = await Promise.all([
        window.matrica.warehouse.nomenclatureList({ id: props.id }),
        window.matrica.warehouse.stockList({ nomenclatureId: props.id }),
        window.matrica.warehouse.movementsList({ nomenclatureId: props.id, limit: 20 }),
        window.matrica.warehouse.engineInstancesList({ nomenclatureId: props.id, limit: 100, offset: 0 }),
      ]);
      if (!list?.ok) {
        setStatus(`Ошибка: ${String(list?.error ?? 'unknown')}`);
        return;
      }
      const found = (list.rows ?? [])[0] ?? null;
      if (!found) {
        setStatus('Позиция не найдена');
        return;
      }
      setRow(found);
      setCode(String(found.code ?? found.sku ?? ''));
      setName(String(found.name ?? ''));
      setItemType(String(found.itemType ?? 'material'));
      setCategory((String(found.category ?? 'component') as 'engine' | 'component' | 'assembly') ?? 'component');
      setGroupId(found.groupId ?? null);
      setUnitId(found.unitId ?? null);
      setBarcode(String(found.barcode ?? ''));
      setMinStock(found.minStock == null ? '' : String(found.minStock));
      setMaxStock(found.maxStock == null ? '' : String(found.maxStock));
      setDefaultBrandId(found.defaultBrandId ?? null);
      setIsSerialTracked(found.isSerialTracked === true);
      setDefaultWarehouseId(found.defaultWarehouseId ?? null);
      setSpecJson(String(found.specJson ?? ''));
      try {
        const parsedSpec = found.specJson ? (JSON.parse(String(found.specJson)) as Record<string, unknown>) : {};
        const parsedTemplateId = typeof parsedSpec.templateId === 'string' && parsedSpec.templateId.trim() ? parsedSpec.templateId.trim() : null;
        const parsedPropertyValues =
          parsedSpec.propertyValues && typeof parsedSpec.propertyValues === 'object' && !Array.isArray(parsedSpec.propertyValues)
            ? (parsedSpec.propertyValues as Record<string, unknown>)
            : {};
        setTemplateId(parsedTemplateId);
        setPropertyValues(parsedPropertyValues);
      } catch {
        setTemplateId(null);
        setPropertyValues({});
      }
      if (stock?.ok) {
        setBalances(stock.rows ?? []);
      } else {
        setBalances([]);
      }
      setMovements(movementRes?.ok ? movementRes.rows ?? [] : []);
      setInstances(instancesRes?.ok ? ((instancesRes.rows ?? []) as EngineInstanceListItem[]) : []);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const reloadTemplateGovernance = useCallback(async () => {
    const [typesRes, templatesRes, propertiesRes] = await Promise.all([
      window.matrica.warehouse.nomenclatureItemTypesList(),
      window.matrica.warehouse.nomenclatureTemplatesList(),
      window.matrica.warehouse.nomenclaturePropertiesList(),
    ]);
    if (typesRes?.ok) {
      setTypeOptions(
        ((typesRes.rows ?? []) as Array<Record<string, unknown>>)
          .map((row) => ({
            id: String(row.id ?? ''),
            code: String(row.code ?? '').trim(),
            name: String(row.name ?? '').trim(),
          }))
          .filter((row) => row.id && row.code && row.name),
      );
    }
    if (templatesRes?.ok) {
      setTemplateRows(
        ((templatesRes.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id ?? ''),
          code: String(row.code ?? '').trim(),
          name: String(row.name ?? '').trim(),
          itemTypeCode: String(row.itemTypeCode ?? ''),
          directoryKind: String(row.directoryKind ?? ''),
          propertiesJson: String(row.propertiesJson ?? '[]'),
        })),
      );
    }
    if (propertiesRes?.ok) {
      setPropertyRows(
        ((propertiesRes.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id ?? ''),
          code: String(row.code ?? '').trim(),
          name: String(row.name ?? '').trim(),
          dataType: row.dataType == null ? null : String(row.dataType ?? ''),
          optionsJson: row.optionsJson == null ? null : String(row.optionsJson ?? ''),
        })),
      );
    }
  }, []);

  useEffect(() => {
    void reloadTemplateGovernance();
  }, [reloadTemplateGovernance]);

  const totalQty = useMemo(() => balances.reduce((sum, row) => sum + Number(row.qty ?? 0), 0), [balances]);
  const itemTypeSelectOptions = useMemo(() => {
    if (typeOptions.length > 0) return typeOptions.map((row) => ({ id: row.code, label: row.name }));
    return WAREHOUSE_ITEM_TYPE_OPTIONS.filter((item) => item.id).map((item) => ({ id: String(item.id), label: item.label }));
  }, [typeOptions]);
  const propertyById = useMemo(() => new Map(propertyRows.map((row) => [row.id, row] as const)), [propertyRows]);
  const selectedTemplateProperties = useMemo(() => {
    const template = templateRows.find((row) => row.id === templateId);
    if (!template?.propertiesJson) return [];
    return parseTemplatePropertiesJson(template.propertiesJson);
  }, [templateRows, templateId]);

  const templateForCompositionEditor = useMemo(() => {
    if (!templateId) return null;
    const t = templateRows.find((row) => row.id === templateId);
    if (!t) return null;
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      itemTypeCode: t.itemTypeCode,
      directoryKind: t.directoryKind,
      propertiesJson: t.propertiesJson,
    };
  }, [templateId, templateRows]);

  const canEditNomenclatureFields = props.canEdit;

  const propertyOptionsForAdd = useMemo(() => {
    const inTpl = new Set(selectedTemplateProperties.map((p) => p.propertyId));
    return propertyRows
      .filter((p) => p.id && !inTpl.has(p.id))
      .map((p) => ({
        id: p.id,
        label: `${p.name} (${p.code})`,
        hintText: p.dataType ?? '',
      }));
  }, [propertyRows, selectedTemplateProperties]);

  async function appendPropertyToCurrentTemplate(propertyId: string) {
    if (!canEditNomenclatureFields) return;
    const pid = String(propertyId ?? '').trim();
    if (!pid) return;
    if (!templateId) {
      setStatus('Сначала выберите шаблон номенклатуры.');
      return;
    }
    const tpl = templateRows.find((r) => r.id === templateId);
    if (!tpl) {
      setStatus('Шаблон не найден в списке. Обновите страницу.');
      return;
    }
    const rows = parseTemplatePropertiesJson(tpl.propertiesJson);
    if (rows.some((r) => r.propertyId === pid)) {
      setStatus('Это свойство уже есть в шаблоне.');
      return;
    }
    const next = appendTemplateProperty(rows, pid);
    const up = await window.matrica.warehouse.nomenclatureTemplateUpsert({
      id: tpl.id,
      code: tpl.code.trim(),
      name: tpl.name.trim(),
      itemTypeCode: tpl.itemTypeCode.trim() || null,
      directoryKind: tpl.directoryKind.trim() || null,
      propertiesJson: serializeTemplatePropertiesJson(next),
    });
    if (!up?.ok) {
      setStatus(`Ошибка: ${String(up?.error ?? 'не удалось обновить шаблон')}`);
      return;
    }
    await reloadTemplateGovernance();
    setPropertyValues((prev) => ({ ...prev, [pid]: prev[pid] ?? '' }));
    setAddPropertyPickId(null);
    setStatus('Свойство добавлено в шаблон. Сохраните карточку при необходимости.');
    setTimeout(() => setStatus(''), 2500);
  }

  async function createQuickPropertyAndAppend() {
    const code = quickPropCode.trim().toLowerCase();
    const name = quickPropName.trim();
    if (!code || !name) {
      setStatus('Укажите код и наименование нового свойства.');
      return;
    }
    const created = await window.matrica.warehouse.nomenclaturePropertyUpsert({
      code,
      name,
      dataType: quickPropDataType,
    });
    if (!created?.ok || !created.id) {
      setStatus(`Ошибка: ${String(!created?.ok && created ? created.error : 'не удалось создать свойство')}`);
      return;
    }
    setQuickPropCode('');
    setQuickPropName('');
    setQuickPropDataType('text');
    await reloadTemplateGovernance();
    await appendPropertyToCurrentTemplate(String(created.id));
  }
  const templateOptions = useMemo(
    () =>
      withRecents(
        'templateId',
        templateRows.map((t) => ({ id: t.id, label: t.name, hintText: t.code })),
      ),
    [templateRows, withRecents],
  );
  const groupOptions = useMemo(() => withRecents('groupId', lookupToSelectOptions(lookups.nomenclatureGroups)), [lookups.nomenclatureGroups, withRecents]);
  const unitOptions = useMemo(() => withRecents('unitId', lookupToSelectOptions(lookups.units)), [lookups.units, withRecents]);
  const brandOptions = useMemo(() => withRecents('defaultBrandId', lookupToSelectOptions(lookups.engineBrands)), [lookups.engineBrands, withRecents]);
  const warehouseOptions = useMemo(() => withRecents('defaultWarehouseId', lookupToSelectOptions(lookups.warehouses)), [lookups.warehouses, withRecents]);
  const instanceWarehouseOptions = useMemo(
    () => withRecents('instanceWarehouseId', lookupToSelectOptions(lookups.warehouses)),
    [lookups.warehouses, withRecents],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {canEditNomenclatureFields ? (
          <Button
            onClick={async () => {
              const result = await window.matrica.warehouse.nomenclatureUpsert({
                id: props.id,
                code: code.trim(),
                sku: null,
                name: name.trim(),
                itemType: itemType as NomenclatureItemType,
                category,
                groupId,
                unitId,
                barcode: barcode.trim() || null,
                minStock: minStock.trim() ? Number(minStock) : null,
                maxStock: maxStock.trim() ? Number(maxStock) : null,
                defaultBrandId,
                isSerialTracked,
                defaultWarehouseId,
                specJson: JSON.stringify({
                  ...(specJson.trim() ? { raw: specJson.trim() } : {}),
                  ...(templateId ? { templateId } : {}),
                  propertyValues,
                }),
                isActive: true,
              });
              if (!result?.ok) {
                setStatus(`Ошибка: ${String(result?.error ?? 'не удалось сохранить')}`);
                return;
              }
              setStatus('Сохранено');
              setTimeout(() => setStatus(''), 1200);
              await load();
            }}
          >
            Сохранить
          </Button>
        ) : null}
        {canEditNomenclatureFields ? (
          <Button
            variant="ghost"
            style={{ color: 'var(--danger)' }}
            onClick={async () => {
              const ok = await confirm({
                detail: `Будет удалена номенклатурная позиция «${name.trim() || code.trim() || props.id}» (код: ${code.trim() || '—'}). Связанные складские документы могут потребовать проверки.`,
              });
              if (!ok) return;
              const result = await window.matrica.warehouse.nomenclatureDelete(props.id);
              if (!result?.ok) {
                setStatus(`Ошибка: ${String(result?.error ?? 'не удалось удалить')}`);
                return;
              }
              props.onClose();
            }}
          >
            Удалить
          </Button>
        ) : null}
        <Button variant="ghost" onClick={props.onClose}>
          Назад
        </Button>
      </div>

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center' }}>
          <div>Код</div>
          <Input value={code} disabled={!canEditNomenclatureFields} onChange={(e) => setCode(e.target.value)} placeholder="Внутренний код / артикул" />
          <div>Наименование</div>
          <Input value={name} disabled={!canEditNomenclatureFields} onChange={(e) => setName(e.target.value)} />
          <div>Тип</div>
          <select value={itemType} disabled={!canEditNomenclatureFields} onChange={(e) => setItemType(e.target.value)} style={{ padding: '8px 10px' }}>
            {itemTypeSelectOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div>Шаблон</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <SearchSelect
                value={templateId}
                disabled={!canEditNomenclatureFields}
                options={templateOptions}
                placeholder="Шаблон номенклатуры"
                showAllWhenEmpty
                emptyQueryLimit={15}
                onChange={(next) => {
                  setTemplateId(next);
                  pushRecent('templateId', next);
                }}
                {...(canEditNomenclatureFields
                  ? {
                      createLabel: 'Новый шаблон',
                      onCreate: async (label: string) => {
                        const up = await window.matrica.warehouse.nomenclatureTemplateUpsert({
                          code: `TPL-${Date.now().toString(36).toUpperCase()}`,
                          name: String(label ?? '').trim() || 'Новый шаблон',
                          itemTypeCode: String(itemType ?? '').trim() || null,
                          directoryKind: row?.directoryKind ? String(row.directoryKind) : null,
                          propertiesJson: '[]',
                        });
                        if (!up?.ok) {
                          setStatus(`Ошибка: ${String(up?.error ?? 'не удалось создать шаблон')}`);
                          return null;
                        }
                        await reloadTemplateGovernance();
                        pushRecent('templateId', up.id);
                        return String(up.id);
                      },
                    }
                  : {})}
              />
            </div>
            {canEditNomenclatureFields && templateId ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setTemplateCompositionOpen(true)}>
                Состав шаблона
              </Button>
            ) : null}
          </div>
          <div>Группа</div>
          <SearchSelect
            value={groupId}
            disabled={!canEditNomenclatureFields}
            options={groupOptions}
            placeholder="Группа номенклатуры"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setGroupId(next);
              pushRecent('groupId', next);
            }}
            {...(canEditNomenclatureFields
              ? {
                  createLabel: 'Новая группа',
                  onCreate: async (label: string) => {
                    const id = await createLookupEntity('nomenclature_group', label);
                    if (!id) {
                      setStatus('Ошибка: не удалось создать группу номенклатуры');
                      return null;
                    }
                    await refreshRefs();
                    pushRecent('groupId', id);
                    return id;
                  },
                }
              : {})}
          />
          <div>Единица измерения</div>
          <SearchSelect
            value={unitId}
            disabled={!canEditNomenclatureFields}
            options={unitOptions}
            placeholder="Единица измерения"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setUnitId(next);
              pushRecent('unitId', next);
            }}
            {...(canEditNomenclatureFields
              ? {
                  createLabel: 'Новая единица',
                  onCreate: async (label: string) => {
                    const id = await createLookupEntity('unit', label);
                    if (!id) {
                      setStatus('Ошибка: не удалось создать единицу измерения');
                      return null;
                    }
                    await refreshRefs();
                    pushRecent('unitId', id);
                    return id;
                  },
                }
              : {})}
          />
          <div>Штрихкод</div>
          <Input value={barcode} disabled={!canEditNomenclatureFields} onChange={(e) => setBarcode(e.target.value)} />
          <div>Мин. остаток</div>
          <Input value={minStock} type="number" disabled={!canEditNomenclatureFields} onChange={(e) => setMinStock(e.target.value)} />
          <div>Макс. остаток</div>
          <Input value={maxStock} type="number" disabled={!canEditNomenclatureFields} onChange={(e) => setMaxStock(e.target.value)} />
          <div>Марка по умолчанию</div>
          <SearchSelect
            value={defaultBrandId}
            disabled={!canEditNomenclatureFields}
            options={brandOptions}
            placeholder="Марка двигателя"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setDefaultBrandId(next);
              pushRecent('defaultBrandId', next);
            }}
            {...(canEditNomenclatureFields
              ? {
                  createLabel: 'Новая марка',
                  onCreate: async (label: string) => {
                    const id = await createLookupEntity('engine_brand', label);
                    if (!id) {
                      setStatus('Ошибка: не удалось создать марку двигателя');
                      return null;
                    }
                    await refreshRefs();
                    pushRecent('defaultBrandId', id);
                    return id;
                  },
                }
              : {})}
          />
          <div>Серийный учет</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={isSerialTracked} disabled={!canEditNomenclatureFields} onChange={(e) => setIsSerialTracked(e.target.checked)} />
            Вести по серийным номерам
          </label>
          <div>Склад по умолчанию</div>
          <SearchSelect
            value={defaultWarehouseId}
            disabled={!canEditNomenclatureFields}
            options={warehouseOptions}
            placeholder="Склад по умолчанию"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setDefaultWarehouseId(next);
              pushRecent('defaultWarehouseId', next);
            }}
            {...(canEditNomenclatureFields
              ? {
                  createLabel: 'Новый склад',
                  onCreate: async (label: string) => {
                    const id = await createLookupEntity('warehouse_ref', label);
                    if (!id) {
                      setStatus('Ошибка: не удалось создать склад');
                      return null;
                    }
                    await refreshRefs();
                    pushRecent('defaultWarehouseId', id);
                    return id;
                  },
                }
              : {})}
          />
          <div style={{ gridColumn: '1 / -1' }}>
            <button type="button" onClick={() => setShowAdvancedSpec((v) => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#2563eb', fontSize: 13 }}>
              {showAdvancedSpec ? '▼' : '▸'} Спецификация (JSON, для отладки)
            </button>
            {showAdvancedSpec ? (
              <textarea
                value={specJson}
                disabled={!canEditNomenclatureFields}
                onChange={(e) => setSpecJson(e.target.value)}
                rows={5}
                style={{ width: '100%', marginTop: 8 }}
              />
            ) : null}
          </div>
          {canEditNomenclatureFields && templateId ? (
            <>
              <div style={{ gridColumn: '1 / -1', fontWeight: 600, marginTop: 4 }}>Добавить свойство в шаблон этой номенклатуры</div>
              <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>
                Свойство будет закреплено в выбранном шаблоне и появится в форме ниже (сохраните карточку, чтобы записать значения).
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end', marginBottom: 8 }}>
                <SearchSelect
                  value={addPropertyPickId}
                  options={propertyOptionsForAdd}
                  placeholder="Выберите свойство из справочника…"
                  showAllWhenEmpty
                  emptyQueryLimit={20}
                  onChange={(next) => setAddPropertyPickId(next)}
                />
                <Button type="button" variant="outline" size="sm" disabled={!addPropertyPickId} onClick={() => void appendPropertyToCurrentTemplate(addPropertyPickId!)}>
                  Добавить в шаблон
                </Button>
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr 100px auto', gap: 8, alignItems: 'end', marginBottom: 8 }}>
                <Input value={quickPropCode} onChange={(e) => setQuickPropCode(e.target.value)} placeholder="Код нового свойства" />
                <Input value={quickPropName} onChange={(e) => setQuickPropName(e.target.value)} placeholder="Наименование" />
                <select value={quickPropDataType} onChange={(e) => setQuickPropDataType(e.target.value)} style={{ padding: '8px 10px' }}>
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="date">date</option>
                  <option value="enum">enum</option>
                  <option value="json">json</option>
                </select>
                <Button type="button" variant="outline" size="sm" onClick={() => void createQuickPropertyAndAppend()}>
                  Создать и в шаблон
                </Button>
              </div>
            </>
          ) : null}
          {selectedTemplateProperties.length > 0 ? (
            <div style={{ gridColumn: '1 / -1', fontWeight: 600, marginTop: 6 }}>Значения по шаблону</div>
          ) : null}
          {selectedTemplateProperties.map((templateProp) => {
            const property = propertyById.get(templateProp.propertyId);
            const value = propertyValues[templateProp.propertyId];
            const dataType = String(property?.dataType ?? 'text').toLowerCase();
            const enumOpts = dataType === 'enum' ? parseEnumValuesFromOptionsJson(property?.optionsJson ?? null) : [];
            return (
              <React.Fragment key={templateProp.propertyId}>
                <div>
                  {property?.name || templateProp.propertyId}
                  {templateProp.required ? ' *' : ''}
                </div>
                {dataType === 'boolean' ? (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      disabled={!canEditNomenclatureFields}
                      onChange={(e) => setPropertyValues((prev) => ({ ...prev, [templateProp.propertyId]: e.target.checked }))}
                    />
                    Да/Нет
                  </label>
                ) : dataType === 'enum' && enumOpts.length > 0 ? (
                  <select
                    value={value == null ? '' : String(value)}
                    disabled={!canEditNomenclatureFields}
                    onChange={(e) => setPropertyValues((prev) => ({ ...prev, [templateProp.propertyId]: e.target.value }))}
                    style={{ padding: '8px 10px', width: '100%' }}
                  >
                    <option value="">—</option>
                    {enumOpts.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={value == null ? '' : String(value)}
                    disabled={!canEditNomenclatureFields}
                    onChange={(e) => setPropertyValues((prev) => ({ ...prev, [templateProp.propertyId]: e.target.value }))}
                    placeholder={property?.code || templateProp.propertyId}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', padding: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Серийные экземпляры</div>
        {canEditNomenclatureFields ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(220px, 1fr) minmax(220px, 1fr) auto', gap: 8, marginBottom: 10 }}>
            <Input value={instanceSerial} onChange={(e) => setInstanceSerial(e.target.value)} placeholder="Серийный номер" />
            <Input value={instanceContractId ?? ''} onChange={(e) => setInstanceContractId(e.target.value || null)} placeholder="Contract ID (опционально)" />
            <SearchSelect
              value={instanceWarehouseId}
              options={instanceWarehouseOptions}
              placeholder="Склад"
              showAllWhenEmpty
              emptyQueryLimit={15}
              onChange={(next) => {
                setInstanceWarehouseId(next);
                pushRecent('instanceWarehouseId', next);
              }}
              {...(canEditNomenclatureFields
                ? {
                    createLabel: 'Новый склад',
                    onCreate: async (label: string) => {
                      const id = await createLookupEntity('warehouse_ref', label);
                      if (!id) {
                        setStatus('Ошибка: не удалось создать склад');
                        return null;
                      }
                      await refreshRefs();
                      pushRecent('instanceWarehouseId', id);
                      return id;
                    },
                  }
                : {})}
            />
            <Button
              type="button"
              onClick={async () => {
                if (!instanceSerial.trim()) {
                  setStatus('Укажите серийный номер экземпляра.');
                  return;
                }
                const up = await window.matrica.warehouse.engineInstanceUpsert({
                  nomenclatureId: props.id,
                  serialNumber: instanceSerial.trim(),
                  contractId: instanceContractId,
                  warehouseId: instanceWarehouseId || 'default',
                  currentStatus: 'in_stock',
                });
                if (!up?.ok) {
                  setStatus(`Ошибка: ${String(up?.error ?? 'не удалось создать экземпляр')}`);
                  return;
                }
                setInstanceSerial('');
                await load();
              }}
            >
              Добавить экземпляр
            </Button>
          </div>
        ) : null}
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Серийник</th>
              <th style={{ textAlign: 'left' }}>Статус</th>
              <th style={{ textAlign: 'left' }}>Склад</th>
              <th style={{ textAlign: 'left' }}>Контракт</th>
              <th style={{ textAlign: 'left' }}>Создан</th>
            </tr>
          </thead>
          <tbody>
            {instances.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 10 }}>
                  Экземпляры не созданы
                </td>
              </tr>
            ) : (
              instances.map((instance) => (
                <tr key={instance.id}>
                  <td>{instance.serialNumber}</td>
                  <td>{instance.currentStatus}</td>
                  <td>
                    {instance.warehouseName ||
                      (String(instance.warehouseId ?? '') === 'default' ? 'Склад по умолчанию' : instance.warehouseId || '—')}
                  </td>
                  <td>{instance.contractName || instance.contractCode || instance.contractId || '—'}</td>
                  <td>{instance.createdAt ? new Date(Number(instance.createdAt)).toLocaleString('ru-RU') : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ border: '1px solid var(--border)', padding: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Остатки по складам (всего: {totalQty})</div>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Склад</th>
              <th style={{ textAlign: 'left' }}>Доступно</th>
              <th style={{ textAlign: 'left' }}>Остаток</th>
              <th style={{ textAlign: 'left' }}>Резерв</th>
            </tr>
          </thead>
          <tbody>
            {balances.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 10 }}>
                  Нет остатков
                </td>
              </tr>
            ) : (
              balances.map((balance) => (
                <tr key={balance.id}>
                  <td>
                    {balance.warehouseName ||
                      (String(balance.warehouseId ?? '') === 'default' ? 'Склад по умолчанию' : balance.warehouseId || '—')}
                  </td>
                  <td>{Number(balance.availableQty ?? 0)}</td>
                  <td>{Number(balance.qty ?? 0)}</td>
                  <td>{Number(balance.reservedQty ?? 0)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ border: '1px solid var(--border)', padding: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Последние движения</div>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Дата</th>
              <th style={{ textAlign: 'left' }}>Склад</th>
              <th style={{ textAlign: 'left' }}>Документ</th>
              <th style={{ textAlign: 'left' }}>Тип</th>
              <th style={{ textAlign: 'left' }}>Операция</th>
              <th style={{ textAlign: 'left' }}>Кол-во</th>
              <th style={{ textAlign: 'left' }}>Основание</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 10 }}>
                  Нет движений
                </td>
              </tr>
            ) : (
              movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{movement.performedAt ? new Date(Number(movement.performedAt)).toLocaleString('ru-RU') : '—'}</td>
                  <td>{movement.warehouseName || movement.warehouseId || '—'}</td>
                  <td>{movement.documentDocNo || '—'}</td>
                  <td>{warehouseDocTypeLabel(movement.documentDocType)}</td>
                  <td>{movement.movementType}</td>
                  <td>{Number(movement.qty ?? 0)}</td>
                  <td>{movement.reasonLabel || movement.reason || movement.counterpartyName || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {row ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--subtle)', fontSize: 12 }}>
          <span>ID: {row.id}</span>
          <Button variant="ghost" onClick={() => void refreshRefs()}>
            Обновить справочники
          </Button>
        </div>
      ) : null}

      <NomenclatureTemplateCompositionEditor
        open={templateCompositionOpen && templateForCompositionEditor != null}
        template={templateForCompositionEditor}
        propertyOptions={propertyRows.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          dataType: String(p.dataType ?? 'text'),
        }))}
        onClose={() => setTemplateCompositionOpen(false)}
        onSaved={() => {
          void reloadTemplateGovernance();
          void load();
        }}
      />
    </div>
  );
}
