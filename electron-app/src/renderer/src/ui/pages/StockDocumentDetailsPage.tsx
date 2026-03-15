import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WarehouseDocumentDetails, WarehouseDocumentLineDto, WarehouseDocumentType } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { lookupToSelectOptions, warehouseDocTypeLabel, WAREHOUSE_DOC_TYPE_OPTIONS } from '../utils/warehouseUi.js';

type EditableLine = {
  id: string;
  lineNo: number;
  nomenclatureId: string | null;
  qty: string;
  price: string;
  warehouseId: string | null;
  fromWarehouseId: string | null;
  toWarehouseId: string | null;
  bookQty: string;
  actualQty: string;
  adjustmentQty: string;
  reason: string;
};

function toEditableLine(line: WarehouseDocumentLineDto, index: number): EditableLine {
  return {
    id: String(line.id ?? `line-${index + 1}`),
    lineNo: Number(line.lineNo ?? index + 1),
    nomenclatureId: line.nomenclatureId ?? null,
    qty: String(line.qty ?? 0),
    price: line.price == null ? '' : String(line.price),
    warehouseId: line.warehouseId ?? null,
    fromWarehouseId: line.fromWarehouseId ?? null,
    toWarehouseId: line.toWarehouseId ?? null,
    bookQty: line.bookQty == null ? '' : String(line.bookQty),
    actualQty: line.actualQty == null ? '' : String(line.actualQty),
    adjustmentQty: line.adjustmentQty == null ? '' : String(line.adjustmentQty),
    reason: line.reason ?? '',
  };
}

function createEmptyLine(index: number): EditableLine {
  return {
    id: `new-${index + 1}-${Date.now()}`,
    lineNo: index + 1,
    nomenclatureId: null,
    qty: '1',
    price: '',
    warehouseId: null,
    fromWarehouseId: null,
    toWarehouseId: null,
    bookQty: '',
    actualQty: '',
    adjustmentQty: '',
    reason: '',
  };
}

export function StockDocumentDetailsPage(props: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { lookups, nomenclature, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData({ loadNomenclature: true });
  const [status, setStatus] = useState('');
  const [document, setDocument] = useState<WarehouseDocumentDetails | null>(null);
  const [docNo, setDocNo] = useState('');
  const [docDate, setDocDate] = useState('');
  const [docType, setDocType] = useState<WarehouseDocumentType>('stock_receipt');
  const [warehouseId, setWarehouseId] = useState<string | null>('default');
  const [reason, setReason] = useState('');
  const [counterpartyId, setCounterpartyId] = useState<string | null>(null);
  const [lines, setLines] = useState<EditableLine[]>([]);

  const load = useCallback(async () => {
    try {
      setStatus('Загрузка документа...');
      const docRes = await window.matrica.warehouse.documentGet(props.id);
      if (!docRes?.ok) {
        setStatus(`Ошибка: ${String(docRes?.error ?? 'не удалось загрузить документ')}`);
        return;
      }
      const nextDocument = docRes.document;
      setDocument(nextDocument);
      setDocNo(String(nextDocument.header.docNo ?? ''));
      setDocType((nextDocument.header.docType ?? 'stock_receipt') as WarehouseDocumentType);
      setDocDate(nextDocument.header.docDate ? new Date(Number(nextDocument.header.docDate)).toISOString().slice(0, 10) : '');
      setWarehouseId(nextDocument.header.warehouseId ?? 'default');
      setReason(nextDocument.header.reason ?? '');
      setCounterpartyId(nextDocument.header.counterpartyId ?? null);
      setLines((nextDocument.lines ?? []).map((line, index) => toEditableLine(line, index)));
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const canEditDocument = props.canEdit && document?.header.status === 'draft';
  const isTransfer = docType === 'stock_transfer';
  const isInventory = docType === 'stock_inventory';
  const isWriteoff = docType === 'stock_writeoff';

  const totals = useMemo(
    () =>
      lines.reduce(
        (acc, line) => {
          acc.qty += Number(line.qty || 0);
          if (isInventory) {
            const book = Number(line.bookQty || 0);
            const actual = Number(line.actualQty || 0);
            acc.delta += actual - book;
          }
          return acc;
        },
        { qty: 0, delta: 0 },
      ),
    [isInventory, lines],
  );

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setLines((prev) => prev.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)));
  }

  async function loadInventoryLines() {
    if (!warehouseId) {
      setStatus('Для загрузки остатков выберите склад в шапке документа.');
      return;
    }
    setStatus('Загрузка остатков для инвентаризации...');
    const result = await window.matrica.warehouse.stockList({ warehouseId });
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'не удалось загрузить остатки')}`);
      return;
    }
    const nextLines = (result.rows ?? [])
      .filter((row) => row.nomenclatureId)
      .map((row, index) => ({
        id: `inventory-${row.id}-${index}`,
        lineNo: index + 1,
        nomenclatureId: row.nomenclatureId ?? null,
        qty: '0',
        price: '',
        warehouseId: row.warehouseId ?? warehouseId,
        fromWarehouseId: null,
        toWarehouseId: null,
        bookQty: String(Number(row.qty ?? 0)),
        actualQty: String(Number(row.qty ?? 0)),
        adjustmentQty: '',
        reason: '',
      }));
    setLines(nextLines);
    setStatus(nextLines.length ? 'Остатки загружены. Укажите фактическое количество.' : 'На выбранном складе нет остатков.');
  }

  function validateDocument(): string | null {
    if (!docNo.trim()) return 'Укажите номер документа.';
    if (!docDate) return 'Укажите дату документа.';
    if (lines.length === 0) return 'Добавьте хотя бы одну строку документа.';
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      if (!line.nomenclatureId) return `В строке ${index + 1} не выбрана номенклатура.`;
      if (!isInventory && Number(line.qty || 0) <= 0) return `В строке ${index + 1} количество должно быть больше нуля.`;
      if (!isTransfer && !isInventory && !(line.warehouseId || warehouseId)) return `В строке ${index + 1} не указан склад.`;
      if (isTransfer) {
        if (!(line.fromWarehouseId || warehouseId) || !line.toWarehouseId) return `В строке ${index + 1} заполните склады перемещения.`;
        if ((line.fromWarehouseId || warehouseId) === line.toWarehouseId) return `В строке ${index + 1} склады отправителя и получателя совпадают.`;
      }
      if (isInventory) {
        const hasBook = line.bookQty.trim().length > 0;
        const hasActual = line.actualQty.trim().length > 0;
        const hasAdjustment = line.adjustmentQty.trim().length > 0;
        if (!line.warehouseId && !warehouseId) return `В строке ${index + 1} не указан склад инвентаризации.`;
        if (!hasAdjustment && (!hasBook || !hasActual)) return `В строке ${index + 1} заполните учет, факт или корректировку.`;
      }
    }
    return null;
  }

  async function saveDocument() {
    const error = validateDocument();
    if (error) {
      setStatus(`Ошибка: ${error}`);
      return;
    }
    const result = await window.matrica.warehouse.documentCreate({
      id: props.id,
      docType,
      docNo: docNo.trim(),
      docDate: new Date(`${docDate}T00:00:00`).getTime(),
      header: {
        warehouseId: warehouseId ?? null,
        reason: reason.trim() || null,
        counterpartyId,
      },
      lines: lines.map((line) => ({
        qty: Number(line.qty || 0),
        ...(line.price.trim() ? { price: Number(line.price) } : {}),
        ...(line.nomenclatureId ? { nomenclatureId: line.nomenclatureId } : {}),
        ...(line.warehouseId ? { warehouseId: line.warehouseId } : {}),
        ...(line.fromWarehouseId ? { fromWarehouseId: line.fromWarehouseId } : {}),
        ...(line.toWarehouseId ? { toWarehouseId: line.toWarehouseId } : {}),
        ...(line.bookQty.trim() ? { bookQty: Number(line.bookQty) } : {}),
        ...(line.actualQty.trim() ? { actualQty: Number(line.actualQty) } : {}),
        ...(line.adjustmentQty.trim() ? { adjustmentQty: Number(line.adjustmentQty) } : {}),
        ...(line.reason.trim() ? { reason: line.reason.trim() } : {}),
      })),
    });
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'не удалось сохранить документ')}`);
      return;
    }
    setStatus('Документ сохранен.');
    await load();
  }

  async function postDocument() {
    const error = validateDocument();
    if (error) {
      setStatus(`Ошибка: ${error}`);
      return;
    }
    const result = await window.matrica.warehouse.documentPost(props.id);
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'не удалось провести документ')}`);
      return;
    }
    setStatus('Документ проведен.');
    await load();
  }

  async function cancelDocument() {
    const result = await window.matrica.warehouse.documentCancel(props.id);
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'не удалось отменить документ')}`);
      return;
    }
    setStatus('Документ отменен.');
    await load();
  }

  const nomenclatureOptions = useMemo(
    () => nomenclature.map((item) => ({ id: item.id, label: `${item.name} (${item.code})` })),
    [nomenclature],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {canEditDocument ? <Button onClick={() => void saveDocument()}>Сохранить</Button> : null}
        {canEditDocument ? <Button onClick={() => void postDocument()}>Провести</Button> : null}
        {canEditDocument ? (
          <Button variant="ghost" style={{ color: 'var(--danger)' }} onClick={() => void cancelDocument()}>
            Отменить документ
          </Button>
        ) : null}
        {canEditDocument ? (
          <Button variant="ghost" onClick={() => setLines((prev) => [...prev, createEmptyLine(prev.length)])}>
            Добавить строку
          </Button>
        ) : null}
        {canEditDocument && isInventory ? (
          <Button variant="ghost" onClick={() => void loadInventoryLines()}>
            Заполнить по остаткам
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => void refreshRefs()}>
          Обновить справочники
        </Button>
        <Button variant="ghost" onClick={props.onClose}>
          Назад
        </Button>
      </div>

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center' }}>
          <div>Номер документа</div>
          <Input value={docNo} disabled={!canEditDocument} onChange={(e) => setDocNo(e.target.value)} />
          <div>Тип документа</div>
          <select value={docType} disabled={!canEditDocument} onChange={(e) => setDocType(e.target.value as WarehouseDocumentType)} style={{ padding: '8px 10px' }}>
            {WAREHOUSE_DOC_TYPE_OPTIONS.filter((item) => item.id).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div>Дата</div>
          <Input type="date" value={docDate} disabled={!canEditDocument} onChange={(e) => setDocDate(e.target.value)} />
          <div>Склад по умолчанию</div>
          <SearchSelect value={warehouseId} disabled={!canEditDocument} options={lookupToSelectOptions(lookups.warehouses)} placeholder="Склад" onChange={setWarehouseId} />
          <div>Контрагент</div>
          <SearchSelect
            value={counterpartyId}
            disabled={!canEditDocument}
            options={lookupToSelectOptions(lookups.counterparties)}
            placeholder="Контрагент"
            onChange={setCounterpartyId}
          />
          <div>Основание / причина</div>
          {isWriteoff ? (
            <SearchSelect
              value={reason || null}
              disabled={!canEditDocument}
              options={lookupToSelectOptions(lookups.writeoffReasons)}
              placeholder="Причина списания"
              onChange={(value) => setReason(value ?? '')}
            />
          ) : (
            <Input value={reason} disabled={!canEditDocument} onChange={(e) => setReason(e.target.value)} placeholder="Основание документа" />
          )}
          <div>Статус</div>
          <div>
            {document?.header.status || 'draft'}
            {document?.header.warehouseName ? ` • ${document.header.warehouseName}` : ''}
            {document?.header.counterpartyName ? ` • ${document.header.counterpartyName}` : ''}
          </div>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <div style={{ fontWeight: 700 }}>Строки документа</div>
          <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
            Тип: {warehouseDocTypeLabel(docType)} | строк: {lines.length} | кол-во: {totals.qty}
            {isInventory ? ` | дельта: ${totals.delta}` : ''}
          </div>
        </div>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>№</th>
              <th style={{ textAlign: 'left' }}>Номенклатура</th>
              {isTransfer ? <th style={{ textAlign: 'left' }}>Откуда</th> : <th style={{ textAlign: 'left' }}>Склад</th>}
              {isTransfer ? <th style={{ textAlign: 'left' }}>Куда</th> : null}
              {isInventory ? <th style={{ textAlign: 'left' }}>Учет</th> : null}
              {isInventory ? <th style={{ textAlign: 'left' }}>Факт</th> : null}
              {isInventory ? <th style={{ textAlign: 'left' }}>Корр.</th> : null}
              {isInventory ? <th style={{ textAlign: 'left' }}>Дельта</th> : null}
              {!isInventory ? <th style={{ textAlign: 'left' }}>Кол-во</th> : null}
              <th style={{ textAlign: 'left' }}>Цена</th>
              <th style={{ textAlign: 'left' }}>Причина</th>
              {canEditDocument ? <th style={{ textAlign: 'left' }}>Действие</th> : null}
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={canEditDocument ? 11 : 10} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 10 }}>
                  Нет строк. Добавьте строки вручную или загрузите остатки для инвентаризации.
                </td>
              </tr>
            ) : (
              lines.map((line, idx) => {
                const inventoryDelta =
                  Number(line.adjustmentQty || 0) ||
                  (line.bookQty.trim() || line.actualQty.trim() ? Number(line.actualQty || 0) - Number(line.bookQty || 0) : 0);
                return (
                  <tr key={line.id || idx}>
                    <td>{idx + 1}</td>
                    <td style={{ minWidth: 280 }}>
                      <SearchSelect
                        value={line.nomenclatureId}
                        disabled={!canEditDocument}
                        options={nomenclatureOptions}
                        placeholder="Номенклатура"
                        onChange={(value) => updateLine(idx, { nomenclatureId: value })}
                      />
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <SearchSelect
                        value={isTransfer ? line.fromWarehouseId || warehouseId : line.warehouseId || warehouseId}
                        disabled={!canEditDocument}
                        options={lookupToSelectOptions(lookups.warehouses)}
                        placeholder="Склад"
                        onChange={(value) => updateLine(idx, isTransfer ? { fromWarehouseId: value } : { warehouseId: value })}
                      />
                    </td>
                    {isTransfer ? (
                      <td style={{ minWidth: 220 }}>
                        <SearchSelect
                          value={line.toWarehouseId}
                          disabled={!canEditDocument}
                          options={lookupToSelectOptions(lookups.warehouses)}
                          placeholder="Склад назначения"
                          onChange={(value) => updateLine(idx, { toWarehouseId: value })}
                        />
                      </td>
                    ) : null}
                    {isInventory ? (
                      <td>
                        <Input type="number" value={line.bookQty} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { bookQty: e.target.value })} />
                      </td>
                    ) : null}
                    {isInventory ? (
                      <td>
                        <Input type="number" value={line.actualQty} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { actualQty: e.target.value })} />
                      </td>
                    ) : null}
                    {isInventory ? (
                      <td>
                        <Input type="number" value={line.adjustmentQty} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { adjustmentQty: e.target.value })} />
                      </td>
                    ) : null}
                    {isInventory ? <td style={{ color: inventoryDelta === 0 ? 'var(--subtle)' : inventoryDelta > 0 ? 'var(--success)' : 'var(--danger)' }}>{inventoryDelta}</td> : null}
                    {!isInventory ? (
                      <td>
                        <Input type="number" value={line.qty} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { qty: e.target.value })} />
                      </td>
                    ) : null}
                    <td>
                      <Input type="number" value={line.price} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { price: e.target.value })} />
                    </td>
                    <td>
                      <Input value={line.reason} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { reason: e.target.value })} placeholder={isWriteoff ? 'Локальная причина / примечание' : 'Примечание'} />
                    </td>
                    {canEditDocument ? (
                      <td>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setLines((prev) => prev.filter((_, lineIndex) => lineIndex !== idx).map((item, lineIndex) => ({ ...item, lineNo: lineIndex + 1 })))
                          }
                        >
                          Удалить
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
