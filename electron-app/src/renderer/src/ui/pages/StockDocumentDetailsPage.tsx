import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type HeaderRow = {
  id: string;
  docType?: string;
  docNo?: string;
  docDate?: number;
  status?: string;
  payloadJson?: string | null;
};

type LineRow = {
  id?: string;
  lineNo?: number;
  qty?: number;
  price?: number | null;
  payloadJson?: string | null;
};

type NomenclatureOption = { id: string; code?: string | null; name?: string | null };

function parsePayload(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export function StockDocumentDetailsPage(props: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState('');
  const [header, setHeader] = useState<HeaderRow | null>(null);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [docNo, setDocNo] = useState('');
  const [docDate, setDocDate] = useState('');
  const [docType, setDocType] = useState('stock_receipt');
  const [warehouseId, setWarehouseId] = useState('default');
  const [reason, setReason] = useState('');
  const [nomenclature, setNomenclature] = useState<NomenclatureOption[]>([]);

  const load = useCallback(async () => {
    try {
      setStatus('Загрузка...');
      const [docRes, nRes] = await Promise.all([window.matrica.warehouse.documentGet(props.id), window.matrica.warehouse.nomenclatureList()]);
      if (!docRes?.ok) {
        setStatus(`Ошибка: ${String(docRes?.error ?? 'не удалось загрузить документ')}`);
        return;
      }
      const headerRow = docRes.header as HeaderRow;
      const lineRows = (docRes.lines ?? []) as LineRow[];
      const payload = parsePayload(headerRow.payloadJson);
      setHeader(headerRow);
      setLines(lineRows);
      setDocNo(String(headerRow.docNo ?? ''));
      setDocType(String(headerRow.docType ?? 'stock_receipt'));
      setDocDate(headerRow.docDate ? new Date(Number(headerRow.docDate)).toISOString().slice(0, 10) : '');
      setWarehouseId(String(payload.warehouseId ?? 'default'));
      setReason(String(payload.reason ?? ''));
      if (nRes?.ok) setNomenclature((nRes.rows ?? []) as NomenclatureOption[]);
      else setNomenclature([]);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const lineModels = useMemo(
    () =>
      lines.map((line) => {
        const payload = parsePayload(line.payloadJson);
        return {
          id: String(line.id ?? ''),
          qty: Number(line.qty ?? 0),
          price: line.price == null ? '' : String(line.price),
          nomenclatureId: String(payload.nomenclatureId ?? ''),
          fromWarehouseId: String(payload.fromWarehouseId ?? ''),
          toWarehouseId: String(payload.toWarehouseId ?? ''),
          adjustmentQty: payload.adjustmentQty == null ? '' : String(payload.adjustmentQty),
        };
      }),
    [lines],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {props.canEdit && header?.status !== 'posted' ? (
          <Button
            onClick={async () => {
              const result = await window.matrica.warehouse.documentCreate({
                id: props.id,
                docType,
                docNo: docNo.trim() || `WH-${String(Date.now()).slice(-8)}`,
                docDate: docDate ? new Date(`${docDate}T00:00:00`).getTime() : Date.now(),
                payloadJson: JSON.stringify({
                  warehouseId: warehouseId.trim() || 'default',
                  reason: reason.trim() || null,
                }),
                lines: lineModels.map((line) => ({
                  qty: Number(line.qty || 0),
                  ...(line.price.trim() ? { price: Number(line.price) } : {}),
                  payloadJson: JSON.stringify({
                    nomenclatureId: line.nomenclatureId || null,
                    fromWarehouseId: line.fromWarehouseId || null,
                    toWarehouseId: line.toWarehouseId || null,
                    adjustmentQty: line.adjustmentQty.trim() ? Number(line.adjustmentQty) : null,
                  }),
                })),
              });
              if (!result?.ok) {
                setStatus(`Ошибка: ${String(result?.error ?? 'не удалось сохранить документ')}`);
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
        {props.canEdit && header?.status !== 'posted' ? (
          <Button
            onClick={async () => {
              const result = await window.matrica.warehouse.documentPost(props.id);
              if (!result?.ok) {
                setStatus(`Ошибка: ${String(result?.error ?? 'не удалось провести документ')}`);
                return;
              }
              setStatus('Документ проведен');
              await load();
            }}
          >
            Провести
          </Button>
        ) : null}
        <Button variant="ghost" onClick={props.onClose}>
          Назад
        </Button>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center' }}>
          <div>Номер документа</div>
          <Input value={docNo} disabled={!props.canEdit || header?.status === 'posted'} onChange={(e) => setDocNo(e.target.value)} />
          <div>Тип документа</div>
          <select value={docType} disabled={!props.canEdit || header?.status === 'posted'} onChange={(e) => setDocType(e.target.value)} style={{ padding: '8px 10px' }}>
            <option value="stock_receipt">Приход</option>
            <option value="stock_issue">Расход</option>
            <option value="stock_transfer">Перемещение</option>
            <option value="stock_writeoff">Списание</option>
            <option value="stock_inventory">Инвентаризация</option>
          </select>
          <div>Дата</div>
          <Input type="date" value={docDate} disabled={!props.canEdit || header?.status === 'posted'} onChange={(e) => setDocDate(e.target.value)} />
          <div>Склад (по умолчанию)</div>
          <Input value={warehouseId} disabled={!props.canEdit || header?.status === 'posted'} onChange={(e) => setWarehouseId(e.target.value)} />
          <div>Основание</div>
          <Input value={reason} disabled={!props.canEdit || header?.status === 'posted'} onChange={(e) => setReason(e.target.value)} />
          <div>Статус</div>
          <div>{header?.status || 'draft'}</div>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', padding: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Строки документа</div>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>№</th>
              <th style={{ textAlign: 'left' }}>Номенклатура</th>
              <th style={{ textAlign: 'left' }}>Кол-во</th>
              <th style={{ textAlign: 'left' }}>Цена</th>
            </tr>
          </thead>
          <tbody>
            {lineModels.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 10 }}>
                  Нет строк
                </td>
              </tr>
            ) : (
              lineModels.map((line, idx) => (
                <tr key={line.id || idx}>
                  <td>{idx + 1}</td>
                  <td>
                    <select
                      value={line.nomenclatureId}
                      disabled={!props.canEdit || header?.status === 'posted'}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((item, i) =>
                            i === idx ? { ...item, payloadJson: JSON.stringify({ ...parsePayload(item.payloadJson), nomenclatureId: e.target.value || null }) } : item,
                          ),
                        )
                      }
                      style={{ minWidth: 220, padding: '6px 8px' }}
                    >
                      <option value="">Выберите...</option>
                      {nomenclature.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.code || '—'} | {item.name || '—'}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <Input
                      type="number"
                      value={String(line.qty)}
                      disabled={!props.canEdit || header?.status === 'posted'}
                      onChange={(e) => setLines((prev) => prev.map((item, i) => (i === idx ? { ...item, qty: Number(e.target.value || 0) } : item)))}
                    />
                  </td>
                  <td>
                    <Input
                      type="number"
                      value={line.price}
                      disabled={!props.canEdit || header?.status === 'posted'}
                      onChange={(e) => setLines((prev) => prev.map((item, i) => (i === idx ? { ...item, price: e.target.value ? Number(e.target.value) : null } : item)))}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
