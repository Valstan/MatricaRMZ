import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

const ITEM_TYPES = [
  { id: 'material', label: 'Материал' },
  { id: 'component', label: 'Комплектующая' },
  { id: 'product', label: 'Изделие' },
  { id: 'semi_product', label: 'Полуфабрикат' },
  { id: 'waste', label: 'Отходы' },
  { id: 'tool_consumable', label: 'Расходник' },
];

type NomenclatureRow = {
  id: string;
  code?: string | null;
  name?: string | null;
  itemType?: string | null;
  barcode?: string | null;
  minStock?: number | null;
  maxStock?: number | null;
  defaultWarehouseId?: string | null;
  specJson?: string | null;
  isActive?: boolean;
};

type StockRow = {
  id: string;
  warehouseId?: string | null;
  qty?: number;
  reservedQty?: number;
};

export function NomenclatureDetailsPage(props: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState('');
  const [row, setRow] = useState<NomenclatureRow | null>(null);
  const [balances, setBalances] = useState<StockRow[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [itemType, setItemType] = useState('material');
  const [barcode, setBarcode] = useState('');
  const [minStock, setMinStock] = useState('');
  const [maxStock, setMaxStock] = useState('');
  const [defaultWarehouseId, setDefaultWarehouseId] = useState('');
  const [specJson, setSpecJson] = useState('');
  const [isActive, setIsActive] = useState(true);

  const load = useCallback(async () => {
    try {
      setStatus('Загрузка...');
      const list = await window.matrica.warehouse.nomenclatureList();
      if (!list?.ok) {
        setStatus(`Ошибка: ${String(list?.error ?? 'unknown')}`);
        return;
      }
      const found = ((list.rows ?? []) as NomenclatureRow[]).find((x) => String(x.id) === props.id) ?? null;
      if (!found) {
        setStatus('Позиция не найдена');
        return;
      }
      setRow(found);
      setCode(String(found.code ?? ''));
      setName(String(found.name ?? ''));
      setItemType(String(found.itemType ?? 'material'));
      setBarcode(String(found.barcode ?? ''));
      setMinStock(found.minStock == null ? '' : String(found.minStock));
      setMaxStock(found.maxStock == null ? '' : String(found.maxStock));
      setDefaultWarehouseId(String(found.defaultWarehouseId ?? ''));
      setSpecJson(String(found.specJson ?? ''));
      setIsActive(found.isActive !== false);

      const stock = await window.matrica.warehouse.stockList({ nomenclatureId: props.id });
      if (stock?.ok) {
        setBalances((stock.rows ?? []) as StockRow[]);
      } else {
        setBalances([]);
      }
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalQty = useMemo(() => balances.reduce((sum, row) => sum + Number(row.qty ?? 0), 0), [balances]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {props.canEdit ? (
          <Button
            onClick={async () => {
              const result = await window.matrica.warehouse.nomenclatureUpsert({
                id: props.id,
                code: code.trim(),
                name: name.trim(),
                itemType,
                barcode: barcode.trim() || null,
                minStock: minStock.trim() ? Number(minStock) : null,
                maxStock: maxStock.trim() ? Number(maxStock) : null,
                defaultWarehouseId: defaultWarehouseId.trim() || null,
                specJson: specJson.trim() || null,
                isActive,
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
        {props.canEdit ? (
          <Button
            variant="danger"
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

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center' }}>
          <div>Код</div>
          <Input value={code} disabled={!props.canEdit} onChange={(e) => setCode(e.target.value)} />
          <div>Наименование</div>
          <Input value={name} disabled={!props.canEdit} onChange={(e) => setName(e.target.value)} />
          <div>Тип</div>
          <select value={itemType} disabled={!props.canEdit} onChange={(e) => setItemType(e.target.value)} style={{ padding: '8px 10px' }}>
            {ITEM_TYPES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div>Штрихкод</div>
          <Input value={barcode} disabled={!props.canEdit} onChange={(e) => setBarcode(e.target.value)} />
          <div>Мин. остаток</div>
          <Input value={minStock} type="number" disabled={!props.canEdit} onChange={(e) => setMinStock(e.target.value)} />
          <div>Макс. остаток</div>
          <Input value={maxStock} type="number" disabled={!props.canEdit} onChange={(e) => setMaxStock(e.target.value)} />
          <div>Склад по умолчанию</div>
          <Input value={defaultWarehouseId} disabled={!props.canEdit} onChange={(e) => setDefaultWarehouseId(e.target.value)} />
          <div>Активность</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={isActive} disabled={!props.canEdit} onChange={(e) => setIsActive(e.target.checked)} />
            Активна
          </label>
          <div>Спецификация (JSON)</div>
          <textarea value={specJson} disabled={!props.canEdit} onChange={(e) => setSpecJson(e.target.value)} rows={5} style={{ width: '100%' }} />
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', padding: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Остатки по складам (всего: {totalQty})</div>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Склад</th>
              <th style={{ textAlign: 'left' }}>Остаток</th>
              <th style={{ textAlign: 'left' }}>Резерв</th>
            </tr>
          </thead>
          <tbody>
            {balances.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 10 }}>
                  Нет остатков
                </td>
              </tr>
            ) : (
              balances.map((balance) => (
                <tr key={balance.id}>
                  <td>{balance.warehouseId || 'default'}</td>
                  <td>{Number(balance.qty ?? 0)}</td>
                  <td>{Number(balance.reservedQty ?? 0)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {row ? <div style={{ color: 'var(--subtle)', fontSize: 12 }}>ID: {row.id}</div> : null}
    </div>
  );
}
