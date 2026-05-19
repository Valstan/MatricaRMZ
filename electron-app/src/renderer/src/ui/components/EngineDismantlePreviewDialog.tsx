import React, { useEffect, useMemo, useState } from 'react';

import { WAREHOUSE_LOCATION_REPAIR_FUND, WAREHOUSE_LOCATION_SCRAP } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';

type NomenclatureNameMap = Map<string, { name: string; code: string }>;

type BomLine = {
  componentNomenclatureId: string;
  componentType?: string | null;
  qtyPerUnit: number;
  variantGroup?: string | null;
  isRequired?: boolean | null;
};

type DismantleLineDraft = {
  key: string;
  nomenclatureId: string;
  componentType: string;
  totalQty: number;
  toRepairFund: number;
  toScrap: number;
};

function asLines(raw: unknown): BomLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map((row) => ({
      componentNomenclatureId: String(row.componentNomenclatureId ?? ''),
      componentType: row.componentType ? String(row.componentType) : null,
      qtyPerUnit: Number(row.qtyPerUnit ?? 0) || 0,
      variantGroup: row.variantGroup ? String(row.variantGroup) : null,
      isRequired: row.isRequired === undefined ? null : Boolean(row.isRequired),
    }))
    .filter((l) => l.componentNomenclatureId && l.qtyPerUnit > 0);
}

export function EngineDismantlePreviewDialog(props: {
  open: boolean;
  onClose: () => void;
  engineId: string;
  engineLabel: string;
  engineBrandId: string | null;
  onComplete?: (result: { documentId: string }) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [bomLines, setBomLines] = useState<DismantleLineDraft[]>([]);
  const [bomName, setBomName] = useState<string>('');
  const [nomenMap, setNomenMap] = useState<NomenclatureNameMap>(new Map());
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState<string>('');

  useEffect(() => {
    if (!props.open) return;
    setStatus('');
    setWarning('');
    setBomLines([]);
    setBomName('');
    if (!props.engineBrandId) {
      setWarning('У двигателя не задана марка (engine_brand_id) — невозможно автоматически подобрать BOM. Можно создать строки вручную или сначала проставить марку.');
      return;
    }
    void loadBom(props.engineBrandId);
  }, [props.open, props.engineBrandId]);

  async function loadBom(engineBrandId: string) {
    setLoading(true);
    try {
      const listRes = await window.matrica.warehouse.assemblyBomList({ engineBrandId, status: 'active' });
      if (!listRes?.ok) {
        setStatus(`Ошибка загрузки BOM: ${String(listRes?.error ?? 'unknown')}`);
        return;
      }
      const list = (listRes.rows ?? []) as Array<Record<string, unknown>>;
      const primary = list.find((row) => Boolean(row.isDefault)) ?? list[0];
      if (!primary) {
        setWarning('Активная default BOM для марки не найдена. Можно создать строки вручную.');
        return;
      }
      const detailsRes = await window.matrica.warehouse.assemblyBomGet(String(primary.id));
      if (!detailsRes?.ok) {
        setStatus(`Ошибка загрузки BOM: ${String(detailsRes?.error ?? 'unknown')}`);
        return;
      }
      const lines = asLines((detailsRes as Record<string, unknown>).lines);
      const drafts: DismantleLineDraft[] = lines.map((l, idx) => ({
        key: `${l.componentNomenclatureId}-${idx}`,
        nomenclatureId: l.componentNomenclatureId,
        componentType: l.componentType ?? '',
        totalQty: Math.max(1, Math.trunc(l.qtyPerUnit)),
        toRepairFund: Math.max(1, Math.trunc(l.qtyPerUnit)),
        toScrap: 0,
      }));
      setBomLines(drafts);
      setBomName(String(primary.name ?? ''));

      // Lookup nomenclature names for display
      const ids = Array.from(new Set(lines.map((l) => l.componentNomenclatureId)));
      if (ids.length > 0) {
        const nRes = await window.matrica.warehouse.nomenclatureList({ limit: 5000 });
        if (nRes?.ok && Array.isArray(nRes.rows)) {
          const map: NomenclatureNameMap = new Map();
          for (const row of nRes.rows as Array<Record<string, unknown>>) {
            if (!row.id) continue;
            map.set(String(row.id), { name: String(row.name ?? ''), code: String(row.code ?? '') });
          }
          setNomenMap(map);
        }
      }
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  const sums = useMemo(() => {
    let toFund = 0;
    let toScrap = 0;
    for (const l of bomLines) {
      toFund += Math.max(0, Math.trunc(l.toRepairFund));
      toScrap += Math.max(0, Math.trunc(l.toScrap));
    }
    return { toFund, toScrap, total: toFund + toScrap };
  }, [bomLines]);

  function setLineFund(key: string, value: number) {
    setBomLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, toRepairFund: Math.max(0, Math.trunc(value || 0)) } : l)),
    );
  }
  function setLineScrap(key: string, value: number) {
    setBomLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, toScrap: Math.max(0, Math.trunc(value || 0)) } : l)),
    );
  }
  function removeLine(key: string) {
    setBomLines((prev) => prev.filter((l) => l.key !== key));
  }
  function addLine() {
    setBomLines((prev) => [
      ...prev,
      {
        key: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        nomenclatureId: '',
        componentType: '',
        totalQty: 1,
        toRepairFund: 1,
        toScrap: 0,
      },
    ]);
  }

  if (!props.open) return null;

  async function submit() {
    setStatus('');
    const cleanLines: Array<{ nomenclatureId: string; qty: number; payloadJson: string }> = [];
    for (const line of bomLines) {
      if (!line.nomenclatureId) continue;
      if (line.toRepairFund > 0) {
        cleanLines.push({
          nomenclatureId: line.nomenclatureId,
          qty: line.toRepairFund,
          payloadJson: JSON.stringify({
            nomenclatureId: line.nomenclatureId,
            targetLocation: WAREHOUSE_LOCATION_REPAIR_FUND,
            engineId: props.engineId,
          }),
        });
      }
      if (line.toScrap > 0) {
        cleanLines.push({
          nomenclatureId: line.nomenclatureId,
          qty: line.toScrap,
          payloadJson: JSON.stringify({
            nomenclatureId: line.nomenclatureId,
            targetLocation: WAREHOUSE_LOCATION_SCRAP,
            engineId: props.engineId,
          }),
        });
      }
    }
    if (cleanLines.length === 0) {
      setStatus('Заполните хотя бы одну строку (qty в ремфонд или в утиль > 0)');
      return;
    }
    const docNo = `DISM-${String(props.engineId).replaceAll('-', '').slice(0, 8)}-${Date.now().toString(36)}`;
    setSubmitting(true);
    try {
      const headerPayloadJson = JSON.stringify({
        module: 'parts_movement_v1',
        engineId: props.engineId,
        sourceType: 'engine_dismantling',
      });
      const createRes = await window.matrica.warehouse.documentCreate({
        docType: 'engine_dismantling',
        status: 'planned',
        docNo,
        docDate: Date.now(),
        payloadJson: headerPayloadJson,
        lines: cleanLines,
      });
      if (!createRes?.ok) {
        setStatus(`Не удалось создать документ: ${String((createRes as Record<string, unknown> | null)?.error ?? 'unknown')}`);
        return;
      }
      const documentId = String((createRes as Record<string, unknown>).id);
      const postRes = await window.matrica.warehouse.documentPost(documentId);
      if (!postRes?.ok) {
        setStatus(`Документ создан (${documentId.slice(0, 8)}…), но не проведён: ${String((postRes as Record<string, unknown> | null)?.error ?? 'unknown')}`);
        return;
      }
      props.onComplete?.({ documentId });
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={props.onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)',
          padding: 16,
          borderRadius: 8,
          maxWidth: 'min(96vw, 1000px)',
          width: '96vw',
          maxHeight: '88vh',
          overflow: 'auto',
          border: '1px solid var(--border)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Разборка двигателя</h3>
          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>двигатель: {props.engineLabel}</span>
        </div>

        {bomName ? (
          <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--subtle)' }}>
            BOM: <strong>{bomName}</strong>
          </div>
        ) : null}

        {loading ? <div>Загрузка BOM…</div> : null}
        {warning ? (
          <div style={{ marginBottom: 10, padding: 8, background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 4, fontSize: 13 }}>
            {warning}
          </div>
        ) : null}

        <table className="list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Деталь</th>
              <th style={{ width: 110, textAlign: 'left' }}>Тип</th>
              <th style={{ width: 80, textAlign: 'right' }}>Всего</th>
              <th style={{ width: 130, textAlign: 'right' }}>→ Ремфонд</th>
              <th style={{ width: 130, textAlign: 'right' }}>→ Утиль</th>
              <th style={{ width: 50 }}></th>
            </tr>
          </thead>
          <tbody>
            {bomLines.length === 0 && !loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  Нет строк. Добавьте вручную.
                </td>
              </tr>
            ) : null}
            {bomLines.map((line) => {
              const nm = nomenMap.get(line.nomenclatureId);
              return (
                <tr key={line.key}>
                  <td>
                    {nm ? (
                      <span>
                        {nm.name} {nm.code ? <code style={{ fontSize: 11, color: 'var(--subtle)' }}>{nm.code}</code> : null}
                      </span>
                    ) : (
                      <code style={{ fontSize: 11 }}>{line.nomenclatureId.slice(0, 8)}…</code>
                    )}
                  </td>
                  <td>{line.componentType || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{line.totalQty}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Input
                      type="number"
                      value={String(line.toRepairFund)}
                      onChange={(e) => setLineFund(line.key, Number(e.target.value))}
                      style={{ width: 110, textAlign: 'right' }}
                    />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Input
                      type="number"
                      value={String(line.toScrap)}
                      onChange={(e) => setLineScrap(line.key, Number(e.target.value))}
                      style={{ width: 110, textAlign: 'right' }}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <Button variant="ghost" onClick={() => removeLine(line.key)}>✕</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ textAlign: 'right', padding: '8px' }}><strong>Σ</strong></td>
              <td style={{ textAlign: 'right' }}><strong>{sums.toFund}</strong></td>
              <td style={{ textAlign: 'right' }}><strong>{sums.toScrap}</strong></td>
              <td></td>
            </tr>
          </tfoot>
        </table>

        <div style={{ marginTop: 8 }}>
          <Button variant="ghost" onClick={addLine}>+ строка</Button>
        </div>

        {status ? (
          <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 13 }}>{status}</div>
        ) : null}

        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>
            После «Провести разборку» создаётся документ engine_dismantling с module=parts_movement_v1 и проводится.
          </span>
          <Button variant="ghost" onClick={props.onClose}>Отмена</Button>
          <Button onClick={() => void submit()} disabled={submitting || sums.total === 0}>
            {submitting ? 'Провожу…' : 'Провести разборку'}
          </Button>
        </div>
      </div>
    </div>
  );
}
