import React, { useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

export function StockInventoryPage(props: {
  canEdit: boolean;
  onOpenDocument: (id: string) => void;
}) {
  const [status, setStatus] = useState('');
  const [warehouseId, setWarehouseId] = useState('default');
  const [reason, setReason] = useState('Плановая инвентаризация');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Акт инвентаризации (каркас)</div>
        <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
          Раздел предназначен для сверки учетных и фактических остатков. На этом этапе доступен базовый каркас создания документа инвентаризации.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center' }}>
          <div>Склад</div>
          <Input value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} />
          <div>Основание</div>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {props.canEdit ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              onClick={async () => {
                const now = Date.now();
                const result = await window.matrica.warehouse.documentCreate({
                  docType: 'stock_inventory',
                  docNo: `INV-${String(now).slice(-8)}`,
                  docDate: now,
                  payloadJson: JSON.stringify({
                    warehouseId: warehouseId.trim() || 'default',
                    reason: reason.trim() || null,
                  }),
                  lines: [],
                });
                if (!result?.ok || !result.id) {
                  setStatus(`Ошибка: ${String(result?.error ?? 'не удалось создать документ')}`);
                  return;
                }
                setStatus('Документ инвентаризации создан');
                props.onOpenDocument(String(result.id));
              }}
            >
              Создать документ инвентаризации
            </Button>
          </div>
        ) : null}
      </div>

      <div style={{ border: '1px dashed var(--border)', padding: 12, color: 'var(--subtle)' }}>
        Следующий шаг развития: загрузка текущих остатков по складу, ввод факта и автоматическое формирование корректировочных строк.
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
    </div>
  );
}
