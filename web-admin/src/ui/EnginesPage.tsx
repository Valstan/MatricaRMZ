import React, { useEffect, useMemo, useState } from 'react';

import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { EngineDetailsPage } from './EngineDetailsPage.js';
import {
  createEntity,
  getEntity,
  listAttributeDefs,
  listEntities,
  listEntityTypes,
  upsertAttributeDef,
  upsertEntityType,
  softDeleteEntity,
} from '../api/masterdata.js';

type Row = {
  id: string;
  engineNumber: string;
  engineBrand: string;
  customerName: string;
  arrivalDate: number | null;
  shippingDate: number | null;
  isScrap: boolean;
  contractId: string;
  updatedAt: number;
  syncStatus: string;
};

const REQUIRED_DEFS = [
  { code: 'engine_number', name: 'Номер двигателя', dataType: 'text' },
  { code: 'engine_brand', name: 'Марка двигателя', dataType: 'text' },
  { code: 'engine_brand_id', name: 'Марка двигателя (ссылка)', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'engine_brand' }) },
  { code: 'arrival_date', name: 'Дата прихода', dataType: 'date' },
  { code: 'shipping_date', name: 'Дата отгрузки', dataType: 'date' },
  { code: 'is_scrap', name: 'Утиль (неремонтнопригоден)', dataType: 'boolean' },
  { code: 'customer_id', name: 'Заказчик', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'customer' }) },
  { code: 'contract_id', name: 'Контракт', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'contract' }) },
  { code: 'attachments', name: 'Вложения', dataType: 'json' },
];

function toDateLabel(ms: number | null) {
  if (!ms) return '';
  const dt = new Date(ms);
  return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('ru-RU');
}

function normalize(s: string) {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function EnginesPage(props: {
  canViewEngines: boolean;
  canEditEngines: boolean;
  canEditMasterData: boolean;
  canViewOperations: boolean;
  canEditOperations: boolean;
  canExportReports?: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [engineTypeId, setEngineTypeId] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function ensureEngineSchema() {
    const typesRes = await listEntityTypes();
    if (!typesRes?.ok) throw new Error(typesRes?.error ?? 'types load failed');
    const types = typesRes.rows ?? [];
    let engineType = types.find((t: any) => String(t.code) === 'engine') ?? null;
    if (!engineType && props.canEditMasterData) {
      const created = await upsertEntityType({ code: 'engine', name: 'Двигатели' });
      if (!created?.ok) throw new Error(created?.error ?? 'failed to create engine type');
      const reload = await listEntityTypes();
      engineType = reload?.rows?.find((t: any) => String(t.code) === 'engine') ?? null;
    }
    if (!engineType?.id) return null;
    const typeId = String(engineType.id);
    setEngineTypeId(typeId);
    const defsRes = await listAttributeDefs(typeId);
    if (!defsRes?.ok) return typeId;
    const defs = defsRes.rows ?? [];
    const byCode = new Set(defs.map((d: any) => String(d.code)));
    if (props.canEditMasterData) {
      for (const def of REQUIRED_DEFS) {
        if (byCode.has(def.code)) continue;
        await upsertAttributeDef({
          entityTypeId: typeId,
          code: def.code,
          name: def.name,
          dataType: def.dataType,
          sortOrder: 100,
          ...(def.metaJson ? { metaJson: def.metaJson } : {}),
        });
      }
    }
    return typeId;
  }

  async function loadEngines() {
    try {
      setStatus('Загрузка…');
      const typeId = (await ensureEngineSchema()) ?? '';
      if (!typeId) {
        setRows([]);
        setStatus('Справочник «Двигатели» не найден (engine).');
        return;
      }
      const listRes = await listEntities(typeId);
      if (!listRes?.ok) {
        setStatus(`Ошибка: ${listRes?.error ?? 'list failed'}`);
        return;
      }
      const typesRes = await listEntityTypes();
      const types = typesRes?.ok ? (typesRes.rows ?? []) : [];
      const customerTypeId = types.find((t: any) => String(t.code) === 'customer')?.id ?? null;
      const contractTypeId = types.find((t: any) => String(t.code) === 'contract')?.id ?? null;
      const customerMap = new Map<string, string>();
      const contractMap = new Map<string, string>();
      if (customerTypeId) {
        const c = await listEntities(String(customerTypeId));
        if (c?.ok) {
          (c.rows ?? []).forEach((row: any) => {
            const label = row.displayName ? String(row.displayName) : String(row.id);
            customerMap.set(String(row.id), label);
          });
        }
      }
      if (contractTypeId) {
        const c = await listEntities(String(contractTypeId));
        if (c?.ok) {
          (c.rows ?? []).forEach((row: any) => {
            const label = row.displayName ? String(row.displayName) : String(row.id);
            contractMap.set(String(row.id), label);
          });
        }
      }
      const list = listRes.rows ?? [];
      if (!list.length) {
        setRows([]);
        setStatus('');
        return;
      }
      const details = await Promise.all(
        list.map(async (row: any) => {
          try {
            const d = await getEntity(String(row.id));
            const attrs = (d as any)?.entity?.attributes ?? {};
            const customerId = attrs.customer_id == null ? '' : String(attrs.customer_id);
            const contractId = attrs.contract_id == null ? '' : String(attrs.contract_id);
            return {
              id: String(row.id),
              engineNumber: attrs.engine_number == null ? '' : String(attrs.engine_number),
              engineBrand: attrs.engine_brand == null ? '' : String(attrs.engine_brand),
              customerName: customerId ? customerMap.get(customerId) ?? customerId : '',
              arrivalDate: typeof attrs.arrival_date === 'number' ? Number(attrs.arrival_date) : null,
              shippingDate: typeof attrs.shipping_date === 'number' ? Number(attrs.shipping_date) : null,
              isScrap: Boolean(attrs.is_scrap),
              contractId,
              updatedAt: Number(row.updatedAt ?? 0),
              syncStatus: String(row.syncStatus ?? ''),
            };
          } catch {
            return {
              id: String(row.id),
              engineNumber: row.displayName ? String(row.displayName) : String(row.id).slice(0, 8),
              engineBrand: '',
              customerName: '',
              arrivalDate: null,
              shippingDate: null,
              isScrap: false,
              contractId: '',
              updatedAt: Number(row.updatedAt ?? 0),
              syncStatus: String(row.syncStatus ?? ''),
            };
          }
        }),
      );
      setRows(details);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    if (!props.canViewEngines) return;
    void loadEngines();
  }, [props.canViewEngines]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('diagnostics.openEntity');
      if (!raw) return;
      const parsed = JSON.parse(raw) as { typeCode?: string; entityId?: string };
      if (parsed?.typeCode !== 'engine' || !parsed.entityId) return;
      setSelectedId(String(parsed.entityId));
      localStorage.removeItem('diagnostics.openEntity');
    } catch {
      // ignore
    }
  }, []);

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return rows;
    return rows.filter(
      (r) =>
        normalize(r.engineNumber).includes(q) ||
        normalize(r.engineBrand).includes(q) ||
        normalize(r.customerName).includes(q),
    );
  }, [rows, query]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [filtered]);

  if (selectedId) {
    return (
      <EngineDetailsPage
        engineId={selectedId}
        onClose={() => setSelectedId(null)}
        onUpdated={loadEngines}
        canEditEngines={props.canEditEngines}
        canEditMasterData={props.canEditMasterData}
        canViewOperations={props.canViewOperations}
        canEditOperations={props.canEditOperations}
        canExportReports={props.canExportReports}
        canViewFiles={props.canViewFiles}
        canUploadFiles={props.canUploadFiles}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
        {props.canEditEngines && (
          <Button
            onClick={async () => {
              if (!engineTypeId) return;
              setStatus('Создание двигателя…');
              const r = await createEntity(engineTypeId);
              if (!r?.ok || !r?.id) {
                setStatus(`Ошибка: ${r?.error ?? 'create failed'}`);
                return;
              }
              setStatus('');
              await loadEngines();
              setSelectedId(String(r.id));
            }}
          >
            Добавить двигатель
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по номеру или марке…" />
        </div>
        <Button variant="ghost" onClick={() => void loadEngines()}>
          Обновить
        </Button>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 10, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ textAlign: 'left', padding: 8 }}>Номер</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Марка</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Контрагент</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Дата прихода</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Дата отгрузки</th>
              {props.canEditMasterData && <th style={{ textAlign: 'left', padding: 8, width: 120 }}>Действия</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.id}
                onClick={() => setSelectedId(row.id)}
                style={{ cursor: 'pointer', background: row.isScrap ? 'rgba(239, 68, 68, 0.18)' : undefined }}
              >
                <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }}>{row.engineNumber || '-'}</td>
                <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }}>{row.engineBrand || '-'}</td>
                <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }}>{row.customerName || '-'}</td>
                <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }}>{toDateLabel(row.arrivalDate) || '-'}</td>
                <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }}>{toDateLabel(row.shippingDate) || '-'}</td>
                {props.canEditMasterData && (
                  <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }} onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm('Удалить двигатель?')) return;
                        try {
                          setStatus('Удаление…');
                          const r = await softDeleteEntity(row.id);
                          if (!r?.ok) {
                            setStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
                            return;
                          }
                          setStatus('Удалено');
                          setTimeout(() => setStatus(''), 900);
                          await loadEngines();
                          if (selectedId === row.id) setSelectedId(null);
                        } catch (err) {
                          setStatus(`Ошибка: ${String(err)}`);
                        }
                      }}
                      style={{ color: '#b91c1c' }}
                    >
                      Удалить
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={props.canEditMasterData ? 6 : 5} style={{ padding: 10, color: '#6b7280' }}>
                  Ничего не найдено
                </td>
              </tr>
            )}
          </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
