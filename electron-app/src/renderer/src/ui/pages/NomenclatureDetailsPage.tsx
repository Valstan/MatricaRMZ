import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { EngineInstanceListItem, NomenclatureItemType, WarehouseMovementListItem, WarehouseNomenclatureListItem, WarehouseStockListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { lookupToSelectOptions, WAREHOUSE_ITEM_TYPE_OPTIONS, warehouseDocTypeLabel } from '../utils/warehouseUi.js';

export function NomenclatureDetailsPage(props: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
}) {
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
  const [templateRows, setTemplateRows] = useState<Array<{ id: string; code: string; name: string; propertiesJson?: string | null }>>([]);
  const [propertyRows, setPropertyRows] = useState<Array<{ id: string; code: string; name: string; dataType?: string | null }>>([]);
  const [instanceSerial, setInstanceSerial] = useState('');
  const [instanceContractId, setInstanceContractId] = useState<string | null>(null);
  const [instanceWarehouseId, setInstanceWarehouseId] = useState<string | null>('default');

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

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [typesRes, templatesRes, propertiesRes] = await Promise.all([
        window.matrica.warehouse.nomenclatureItemTypesList(),
        window.matrica.warehouse.nomenclatureTemplatesList(),
        window.matrica.warehouse.nomenclaturePropertiesList(),
      ]);
      if (!alive) return;
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
            propertiesJson: row.propertiesJson == null ? null : String(row.propertiesJson ?? ''),
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
          })),
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const totalQty = useMemo(() => balances.reduce((sum, row) => sum + Number(row.qty ?? 0), 0), [balances]);
  const itemTypeSelectOptions = useMemo(() => {
    if (typeOptions.length > 0) return typeOptions.map((row) => ({ id: row.code, label: row.name }));
    return WAREHOUSE_ITEM_TYPE_OPTIONS.filter((item) => item.id).map((item) => ({ id: String(item.id), label: item.label }));
  }, [typeOptions]);
  const propertyById = useMemo(() => new Map(propertyRows.map((row) => [row.id, row] as const)), [propertyRows]);
  const selectedTemplateProperties = useMemo(() => {
    const template = templateRows.find((row) => row.id === templateId);
    if (!template?.propertiesJson) return [] as Array<{ propertyId: string; required?: boolean }>;
    try {
      const parsed = JSON.parse(template.propertiesJson) as Array<{ propertyId?: string; required?: boolean }>;
      return parsed
        .map((row) => ({ propertyId: String(row?.propertyId ?? '').trim(), required: row?.required === true }))
        .filter((row) => row.propertyId);
    } catch {
      return [];
    }
  }, [templateRows, templateId]);

  const canEditNomenclatureFields = props.canEdit;

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
              if (!confirm('Удалить номенклатурную позицию?')) return;
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
          <SearchSelect
            value={templateId}
            disabled={!canEditNomenclatureFields}
            options={templateRows.map((row) => ({ id: row.id, label: row.name, secondaryText: row.code }))}
            placeholder="Шаблон номенклатуры"
            onChange={setTemplateId}
          />
          <div>Группа</div>
          <SearchSelect
            value={groupId}
            disabled={!canEditNomenclatureFields}
            options={lookupToSelectOptions(lookups.nomenclatureGroups)}
            placeholder="Группа номенклатуры"
            onChange={setGroupId}
          />
          <div>Единица измерения</div>
          <SearchSelect
            value={unitId}
            disabled={!canEditNomenclatureFields}
            options={lookupToSelectOptions(lookups.units)}
            placeholder="Единица измерения"
            onChange={setUnitId}
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
            options={lookupToSelectOptions(lookups.engineBrands)}
            placeholder="Марка двигателя"
            onChange={setDefaultBrandId}
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
            options={lookupToSelectOptions(lookups.warehouses)}
            placeholder="Склад по умолчанию"
            onChange={setDefaultWarehouseId}
          />
          <div>Спецификация (JSON)</div>
          <textarea value={specJson} disabled={!canEditNomenclatureFields} onChange={(e) => setSpecJson(e.target.value)} rows={5} style={{ width: '100%' }} />
          {selectedTemplateProperties.map((templateProp) => {
            const property = propertyById.get(templateProp.propertyId);
            const value = propertyValues[templateProp.propertyId];
            const dataType = String(property?.dataType ?? 'text').toLowerCase();
            return (
              <React.Fragment key={templateProp.propertyId}>
                <div>{property?.name || templateProp.propertyId}{templateProp.required ? ' *' : ''}</div>
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
              options={lookupToSelectOptions(lookups.warehouses)}
              placeholder="Склад"
              onChange={setInstanceWarehouseId}
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
                  <td>{instance.warehouseName || instance.warehouseId || 'default'}</td>
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
                  <td>{balance.warehouseName || balance.warehouseId || 'default'}</td>
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
    </div>
  );
}
