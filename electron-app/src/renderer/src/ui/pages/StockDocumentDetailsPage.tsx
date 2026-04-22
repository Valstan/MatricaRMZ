import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WarehouseDocumentDetails, WarehouseDocumentLineDto, WarehouseDocumentType, WarehouseIncomingSourceType } from '@matricarmz/shared';
import { tryParseWarehousePartNomenclatureMirror } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { RowReorderButtons } from '../components/RowReorderButtons.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useRecentSelectOptions } from '../hooks/useRecentSelectOptions.js';
import { buildNomenclatureCode } from '../utils/nomenclatureCode.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { moveArrayItem } from '../utils/moveArrayItem.js';
import { fetchWarehouseStockAllPages } from '../utils/warehousePagedFetch.js';
import {
  lookupToSelectOptions,
  warehouseDocTypeLabel,
  warehouseDocumentStatusLabel,
  WAREHOUSE_DOC_TYPE_OPTIONS,
} from '../utils/warehouseUi.js';

type EditableLine = {
  id: string;
  lineNo: number;
  nomenclatureId: string | null;
  qty: string;
  price: string;
  unit: string;
  batch: string;
  note: string;
  warehouseId: string | null;
  fromWarehouseId: string | null;
  toWarehouseId: string | null;
  bookQty: string;
  actualQty: string;
  adjustmentQty: string;
  reason: string;
};

const INCOMING_DOC_TYPES: WarehouseDocumentType[] = [
  'inventory_opening',
  'purchase_receipt',
  'production_release',
  'repair_recovery',
  'engine_dismantling',
];

const INCOMING_SOURCE_OPTIONS: Array<{ id: WarehouseIncomingSourceType; label: string }> = [
  { id: 'opening_balance', label: 'Начальные остатки' },
  { id: 'supplier_purchase', label: 'Закупка у поставщика' },
  { id: 'production_release', label: 'Выпуск производства' },
  { id: 'repair_recovery', label: 'Восстановление после ремонта' },
  { id: 'engine_dismantling', label: 'Разборка двигателя' },
];

function toEditableLine(line: WarehouseDocumentLineDto, index: number): EditableLine {
  return {
    id: String(line.id ?? `line-${index + 1}`),
    lineNo: Number(line.lineNo ?? index + 1),
    nomenclatureId: line.nomenclatureId ?? null,
    qty: String(line.qty ?? 0),
    price: line.price == null ? '' : String(line.price),
    unit: String(line.unit ?? ''),
    batch: String(line.batch ?? ''),
    note: String(line.note ?? ''),
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
    unit: '',
    batch: '',
    note: '',
    warehouseId: null,
    fromWarehouseId: null,
    toWarehouseId: null,
    bookQty: '',
    actualQty: '',
    adjustmentQty: '',
    reason: '',
  };
}

function normalizeLineOrder(lines: EditableLine[]): EditableLine[] {
  return lines.map((line, index) => ({ ...line, lineNo: index + 1 }));
}

export function StockDocumentDetailsPage(props: {
  id: string;
  canEdit: boolean;
  /** Быстрое создание детали (шаблон подставится автоматически по имени, как в Производстве) */
  canCreateParts?: boolean;
  onClose: () => void;
}) {
  const { lookups, nomenclature, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData({ loadNomenclature: true });
  const { pushRecent, withRecents } = useRecentSelectOptions(`matrica:stock-doc-recents:${props.id}`, 8);
  const [status, setStatus] = useState('');
  const [document, setDocument] = useState<WarehouseDocumentDetails | null>(null);
  const [docNo, setDocNo] = useState('');
  const [docDate, setDocDate] = useState('');
  const [docType, setDocType] = useState<WarehouseDocumentType>('stock_receipt');
  const [warehouseId, setWarehouseId] = useState<string | null>('default');
  const [expectedDate, setExpectedDate] = useState('');
  const [sourceType, setSourceType] = useState<WarehouseIncomingSourceType>('supplier_purchase');
  const [sourceRef, setSourceRef] = useState('');
  const [contractId, setContractId] = useState('');
  const [reason, setReason] = useState('');
  const [counterpartyId, setCounterpartyId] = useState<string | null>(null);
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [incomingSaveStatus, setIncomingSaveStatus] = useState<'draft' | 'planned'>('draft');
  const isIncoming = INCOMING_DOC_TYPES.includes(docType);

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
      const expectedMs = Number(nextDocument.header.expectedDate ?? nextDocument.header.docDate ?? 0);
      setExpectedDate(expectedMs ? new Date(expectedMs).toISOString().slice(0, 10) : '');
      const nextSourceType = String(nextDocument.header.sourceType ?? '').trim();
      setSourceType(
        (nextSourceType || (nextDocument.header.docType === 'inventory_opening' ? 'opening_balance' : 'supplier_purchase')) as WarehouseIncomingSourceType,
      );
      setSourceRef(String(nextDocument.header.sourceRef ?? ''));
      setContractId(String(nextDocument.header.contractId ?? ''));
      setReason(nextDocument.header.reason ?? '');
      setCounterpartyId(nextDocument.header.counterpartyId ?? null);
      setLines((nextDocument.lines ?? []).map((line, index) => toEditableLine(line, index)));
      if (INCOMING_DOC_TYPES.includes((nextDocument.header.docType ?? 'stock_receipt') as WarehouseDocumentType)) {
        setIncomingSaveStatus(nextDocument.header.status === 'planned' ? 'planned' : 'draft');
      } else {
        setIncomingSaveStatus('draft');
      }
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isIncoming) return;
    if (docType === 'inventory_opening' && sourceType !== 'opening_balance') setSourceType('opening_balance');
    if (!['draft', 'planned'].includes(incomingSaveStatus)) setIncomingSaveStatus('draft');
  }, [docType, incomingSaveStatus, isIncoming, sourceType]);

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
    let stockRows: Awaited<ReturnType<typeof fetchWarehouseStockAllPages>>;
    try {
      stockRows = await fetchWarehouseStockAllPages({ warehouseId });
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
      return;
    }
    const nextLines = stockRows
      .filter((row) => row.nomenclatureId)
      .map((row, index) => ({
        id: `inventory-${row.id}-${index}`,
        lineNo: index + 1,
        nomenclatureId: row.nomenclatureId ?? null,
        qty: '0',
        price: '',
        unit: '',
        batch: '',
        note: '',
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
    if (isIncoming) {
      if (!expectedDate) return 'Для документа прихода укажите ожидаемую дату.';
      if (!sourceType) return 'Для документа прихода укажите источник.';
      if (docType === 'inventory_opening' && (counterpartyId || contractId.trim())) {
        return 'Для inventory_opening не заполняются контрагент и договор.';
      }
    }
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

  function moveLine(from: number, to: number) {
    setLines((prev) => normalizeLineOrder(moveArrayItem(prev, from, to)));
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
      status: 'draft',
      docNo: docNo.trim(),
      docDate: new Date(`${docDate}T00:00:00`).getTime(),
      header: {
        warehouseId: warehouseId ?? null,
        ...(isIncoming ? { expectedDate: new Date(`${expectedDate}T00:00:00`).getTime() } : {}),
        ...(isIncoming ? { sourceType } : {}),
        ...(isIncoming && sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
        ...(isIncoming && contractId.trim() ? { contractId: contractId.trim() } : {}),
        reason: reason.trim() || null,
        counterpartyId,
      },
      lines: lines.map((line) => ({
        qty: Number(line.qty || 0),
        ...(line.price.trim() ? { price: Number(line.price) } : {}),
        ...(line.price.trim() ? { cost: Number(line.price) } : {}),
        ...(line.nomenclatureId ? { nomenclatureId: line.nomenclatureId } : {}),
        ...(line.unit.trim() ? { unit: line.unit.trim() } : {}),
        ...(line.batch.trim() ? { batch: line.batch.trim() } : {}),
        ...(line.note.trim() ? { note: line.note.trim() } : {}),
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
    if (isIncoming && incomingSaveStatus === 'planned') {
      const planResult = await window.matrica.warehouse.documentPlan(props.id);
      if (!planResult?.ok) {
        setStatus(`Ошибка: ${String(planResult?.error ?? 'документ сохранён, но не удалось перевести в planned')}`);
        await load();
        return;
      }
      setStatus('Документ сохранен и переведен в статус planned.');
      await load();
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
    const saveResult = await window.matrica.warehouse.documentCreate({
      id: props.id,
      docType,
      status: 'draft',
      docNo: docNo.trim(),
      docDate: new Date(`${docDate}T00:00:00`).getTime(),
      header: {
        warehouseId: warehouseId ?? null,
        ...(isIncoming ? { expectedDate: new Date(`${expectedDate}T00:00:00`).getTime() } : {}),
        ...(isIncoming ? { sourceType } : {}),
        ...(isIncoming && sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
        ...(isIncoming && contractId.trim() ? { contractId: contractId.trim() } : {}),
        reason: reason.trim() || null,
        counterpartyId,
      },
      ...(document?.header?.updatedAt != null ? { expectedUpdatedAt: Number(document.header.updatedAt) } : {}),
      lines: lines.map((line) => ({
        qty: Number(line.qty || 0),
        ...(line.price.trim() ? { price: Number(line.price) } : {}),
        ...(line.price.trim() ? { cost: Number(line.price) } : {}),
        ...(line.nomenclatureId ? { nomenclatureId: line.nomenclatureId } : {}),
        ...(line.unit.trim() ? { unit: line.unit.trim() } : {}),
        ...(line.batch.trim() ? { batch: line.batch.trim() } : {}),
        ...(line.note.trim() ? { note: line.note.trim() } : {}),
        ...(line.warehouseId ? { warehouseId: line.warehouseId } : {}),
        ...(line.fromWarehouseId ? { fromWarehouseId: line.fromWarehouseId } : {}),
        ...(line.toWarehouseId ? { toWarehouseId: line.toWarehouseId } : {}),
        ...(line.bookQty.trim() ? { bookQty: Number(line.bookQty) } : {}),
        ...(line.actualQty.trim() ? { actualQty: Number(line.actualQty) } : {}),
        ...(line.adjustmentQty.trim() ? { adjustmentQty: Number(line.adjustmentQty) } : {}),
        ...(line.reason.trim() ? { reason: line.reason.trim() } : {}),
      })),
    });
    if (!saveResult?.ok) {
      setStatus(`Ошибка: ${String(saveResult?.error ?? 'не удалось сохранить документ перед проведением')}`);
      return;
    }
    const result = await window.matrica.warehouse.documentPost({
      id: props.id,
      ...(document?.header?.updatedAt != null ? { expectedUpdatedAt: Number(document.header.updatedAt) } : {}),
    });
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'не удалось провести документ')}`);
      return;
    }
    setStatus(result.queued ? 'Команда на проведение поставлена в очередь.' : 'Документ проведен.');
    await load();
  }

  async function planDocument() {
    const error = validateDocument();
    if (error) {
      setStatus(`Ошибка: ${error}`);
      return;
    }
    const saveResult = await window.matrica.warehouse.documentCreate({
      id: props.id,
      docType,
      status: 'draft',
      docNo: docNo.trim(),
      docDate: new Date(`${docDate}T00:00:00`).getTime(),
      header: {
        warehouseId: warehouseId ?? null,
        ...(isIncoming ? { expectedDate: new Date(`${expectedDate}T00:00:00`).getTime() } : {}),
        ...(isIncoming ? { sourceType } : {}),
        ...(isIncoming && sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
        ...(isIncoming && contractId.trim() ? { contractId: contractId.trim() } : {}),
        reason: reason.trim() || null,
        counterpartyId,
      },
      lines: lines.map((line) => ({
        qty: Number(line.qty || 0),
        ...(line.price.trim() ? { price: Number(line.price) } : {}),
        ...(line.price.trim() ? { cost: Number(line.price) } : {}),
        ...(line.nomenclatureId ? { nomenclatureId: line.nomenclatureId } : {}),
        ...(line.unit.trim() ? { unit: line.unit.trim() } : {}),
        ...(line.batch.trim() ? { batch: line.batch.trim() } : {}),
        ...(line.note.trim() ? { note: line.note.trim() } : {}),
        ...(line.warehouseId ? { warehouseId: line.warehouseId } : {}),
        ...(line.fromWarehouseId ? { fromWarehouseId: line.fromWarehouseId } : {}),
        ...(line.toWarehouseId ? { toWarehouseId: line.toWarehouseId } : {}),
        ...(line.bookQty.trim() ? { bookQty: Number(line.bookQty) } : {}),
        ...(line.actualQty.trim() ? { actualQty: Number(line.actualQty) } : {}),
        ...(line.adjustmentQty.trim() ? { adjustmentQty: Number(line.adjustmentQty) } : {}),
        ...(line.reason.trim() ? { reason: line.reason.trim() } : {}),
      })),
    });
    if (!saveResult?.ok) {
      setStatus(`Ошибка: ${String(saveResult?.error ?? 'не удалось сохранить документ перед планированием')}`);
      return;
    }
    const result = await window.matrica.warehouse.documentPlan(props.id);
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'не удалось перевести документ в planned')}`);
      return;
    }
    setStatus('Документ переведен в статус planned.');
    await load();
  }

  async function cancelDocument() {
    const result = await window.matrica.warehouse.documentCancel({
      id: props.id,
      ...(document?.header?.updatedAt != null ? { expectedUpdatedAt: Number(document.header.updatedAt) } : {}),
    });
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'не удалось отменить документ')}`);
      return;
    }
    setStatus(result.queued ? 'Команда на отмену поставлена в очередь.' : 'Документ отменен.');
    await load();
  }

  const nomenclatureOptions = useMemo(
    () =>
      withRecents(
        'nomenclatureId',
        nomenclature.map((item) => ({ id: item.id, label: `${item.name} (${item.code})` })),
      ),
    [nomenclature, withRecents],
  );
  const warehouseOptions = useMemo(() => withRecents('warehouseId', lookupToSelectOptions(lookups.warehouses)), [lookups.warehouses, withRecents]);
  const counterpartyOptions = useMemo(
    () => withRecents('counterpartyId', lookupToSelectOptions(lookups.counterparties)),
    [lookups.counterparties, withRecents],
  );
  const writeoffReasonOptions = useMemo(
    () => withRecents('writeoffReason', lookupToSelectOptions(lookups.writeoffReasons)),
    [lookups.writeoffReasons, withRecents],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {canEditDocument ? <Button onClick={() => void saveDocument()}>Сохранить</Button> : null}
        {canEditDocument && isIncoming ? <Button onClick={() => void planDocument()}>Запланировать</Button> : null}
        {props.canEdit && ((isIncoming && document?.header.status === 'planned') || (!isIncoming && document?.header.status === 'draft')) ? (
          <Button onClick={() => void postDocument()}>Провести</Button>
        ) : null}
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
          <SearchSelect
            value={warehouseId}
            disabled={!canEditDocument}
            options={warehouseOptions}
            placeholder="Склад"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setWarehouseId(next);
              pushRecent('warehouseId', next);
            }}
          />
          {isIncoming ? <div>Ожидаемая дата</div> : null}
          {isIncoming ? <Input type="date" value={expectedDate} disabled={!canEditDocument} onChange={(e) => setExpectedDate(e.target.value)} /> : null}
          {isIncoming ? <div>Источник прихода</div> : null}
          {isIncoming ? (
            <select
              value={sourceType}
              disabled={!canEditDocument}
              onChange={(e) => setSourceType(e.target.value as WarehouseIncomingSourceType)}
              style={{ padding: '8px 10px' }}
            >
              {INCOMING_SOURCE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null}
          {isIncoming ? <div>Источник / ссылка</div> : null}
          {isIncoming ? (
            <Input value={sourceRef} disabled={!canEditDocument} onChange={(e) => setSourceRef(e.target.value)} placeholder="Номер накладной, заказ, акт..." />
          ) : null}
          {isIncoming ? <div>Договор (опц.)</div> : null}
          {isIncoming ? <Input value={contractId} disabled={!canEditDocument} onChange={(e) => setContractId(e.target.value)} placeholder="ID/номер договора" /> : null}
          {isIncoming ? <div>Режим прихода</div> : null}
          {isIncoming ? (
            <select
              value={incomingSaveStatus}
              disabled={!canEditDocument}
              onChange={(e) => setIncomingSaveStatus(e.target.value === 'planned' ? 'planned' : 'draft')}
              style={{ padding: '8px 10px' }}
            >
              <option value="draft">Черновик</option>
              <option value="planned">Запланировано</option>
            </select>
          ) : null}
          <div>Контрагент</div>
          <SearchSelect
            value={counterpartyId}
            disabled={!canEditDocument}
            options={counterpartyOptions}
            placeholder="Контрагент"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setCounterpartyId(next);
              pushRecent('counterpartyId', next);
            }}
          />
          <div>Основание / причина</div>
          {isWriteoff ? (
            <SearchSelect
              value={reason || null}
              disabled={!canEditDocument}
              options={writeoffReasonOptions}
              placeholder="Причина списания"
              showAllWhenEmpty
              emptyQueryLimit={15}
              onChange={(value) => {
                setReason(value ?? '');
                pushRecent('writeoffReason', value ?? null);
              }}
            />
          ) : (
            <Input value={reason} disabled={!canEditDocument} onChange={(e) => setReason(e.target.value)} placeholder="Основание документа" />
          )}
          <div>Статус</div>
          <div>
            {warehouseDocumentStatusLabel(document?.header.status ?? 'draft')}
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
              <th style={{ textAlign: 'left' }}>Ед.</th>
              <th style={{ textAlign: 'left' }}>Партия</th>
              <th style={{ textAlign: 'left' }}>Причина</th>
              <th style={{ textAlign: 'left' }}>Примечание</th>
              {canEditDocument ? <th style={{ textAlign: 'center' }}>Действия</th> : null}
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={20} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 10 }}>
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
                        showAllWhenEmpty
                        emptyQueryLimit={20}
                        {...(props.canCreateParts
                          ? {
                              createLabel: 'Создать деталь и выбрать',
                              onCreate: async (label: string) => {
                                const trimmed = label.trim();
                                if (!trimmed) return null;
                                const r = await window.matrica.parts.create({
                                  attributes: {
                                    code: buildNomenclatureCode('DET'),
                                    name: trimmed,
                                  },
                                });
                                if (!r?.ok || !r.part?.id) {
                                  throw new Error(String((r as { error?: string })?.error ?? 'Не удалось создать деталь'));
                                }
                                await refreshRefs();
                                const partId = String(r.part.id);
                                const rowById = (nomenclature ?? []).find((row) => String(row.id) === partId);
                                if (rowById?.id) {
                                  return String(rowById.id);
                                }
                                const rowByMirror = (nomenclature ?? []).find((row) => {
                                  const parsed = tryParseWarehousePartNomenclatureMirror(row.specJson ?? null);
                                  return parsed?.partId === partId;
                                });
                                return rowByMirror?.id ? String(rowByMirror.id) : partId;
                              },
                            }
                          : {})}
                        onChange={(value) => {
                          pushRecent('nomenclatureId', value);
                          updateLine(idx, { nomenclatureId: value });
                        }}
                      />
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <SearchSelect
                        value={isTransfer ? line.fromWarehouseId || warehouseId : line.warehouseId || warehouseId}
                        disabled={!canEditDocument}
                        options={warehouseOptions}
                        placeholder="Склад"
                        showAllWhenEmpty
                        emptyQueryLimit={15}
                        onChange={(value) => {
                          pushRecent('warehouseId', value);
                          updateLine(idx, isTransfer ? { fromWarehouseId: value } : { warehouseId: value });
                        }}
                      />
                    </td>
                    {isTransfer ? (
                      <td style={{ minWidth: 220 }}>
                        <SearchSelect
                          value={line.toWarehouseId}
                          disabled={!canEditDocument}
                          options={warehouseOptions}
                          placeholder="Склад назначения"
                          showAllWhenEmpty
                          emptyQueryLimit={15}
                          onChange={(value) => {
                            pushRecent('warehouseId', value);
                            updateLine(idx, { toWarehouseId: value });
                          }}
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
                      <Input value={line.unit} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { unit: e.target.value })} placeholder="шт" />
                    </td>
                    <td>
                      <Input value={line.batch} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { batch: e.target.value })} placeholder="Партия" />
                    </td>
                    <td>
                      <Input value={line.reason} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { reason: e.target.value })} placeholder={isWriteoff ? 'Локальная причина / примечание' : 'Примечание'} />
                    </td>
                    <td>
                      <Input value={line.note} disabled={!canEditDocument} onChange={(e) => updateLine(idx, { note: e.target.value })} placeholder="Комментарий по строке" />
                    </td>
                    {canEditDocument ? (
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <RowReorderButtons
                            canMoveUp={idx > 0}
                            canMoveDown={idx < lines.length - 1}
                            onMoveUp={() => moveLine(idx, idx - 1)}
                            onMoveDown={() => moveLine(idx, idx + 1)}
                          />
                          <Button
                            variant="ghost"
                            onClick={() => setLines((prev) => normalizeLineOrder(prev.filter((_, lineIndex) => lineIndex !== idx)))}
                          >
                            Удалить
                          </Button>
                        </div>
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
