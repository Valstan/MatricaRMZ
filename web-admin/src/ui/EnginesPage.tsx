import React, { useEffect, useMemo, useState } from 'react';

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
} from '../api/masterdata.js';
import { formatMoscowDate } from './utils/dateUtils.js';
import { matchesQueryInRecord } from './utils/search.js';

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
  return Number.isNaN(dt.getTime()) ? '' : formatMoscowDate(dt);
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
  const [sortKey, setSortKey] = useState<'engineNumber' | 'engineBrand' | 'customerName' | 'arrivalDate' | 'shippingDate'>('arrivalDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

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
              shippingDate:
                typeof attrs.shipping_date === 'number'
                  ? Number(attrs.shipping_date)
                  : typeof attrs.status_customer_sent_date === 'number'
                    ? Number(attrs.status_customer_sent_date)
                    : null,
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
    return rows.filter((row) => matchesQueryInRecord(query, row));
  }, [rows, query]);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir('asc');
  }

  function sortArrow(key: typeof sortKey) {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? '▲' : '▼';
  }

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const byText = (a: string, b: string) => a.localeCompare(b, 'ru') * dir;
    const byDate = (a?: number | null, b?: number | null) => {
      const av = a ?? -1;
      const bv = b ?? -1;
      return (av - bv) * dir;
    };
    const items = [...filtered];
    items.sort((a, b) => {
      switch (sortKey) {
        case 'engineNumber':
          return byText(String(a.engineNumber ?? ''), String(b.engineNumber ?? ''));
        case 'engineBrand':
          return byText(String(a.engineBrand ?? ''), String(b.engineBrand ?? ''));
        case 'customerName':
          return byText(String(a.customerName ?? ''), String(b.customerName ?? ''));
        case 'arrivalDate':
          return byDate(a.arrivalDate ?? null, b.arrivalDate ?? null);
        case 'shippingDate':
          return byDate(a.shippingDate ?? null, b.shippingDate ?? null);
        default:
          return 0;
      }
    });
    return items;
  }, [filtered, sortDir, sortKey]);

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
          <button
            type="button"
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
            style={{
              padding: '7px 10px',
              borderRadius: 10,
              border: '1px solid var(--button-border)',
              background: 'var(--button-bg)',
              color: 'var(--button-text)',
              cursor: 'pointer',
            }}
          >
            Добавить двигатель
          </button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по всем данным двигателя…" />
        </div>
        <button
          type="button"
          onClick={() => void loadEngines()}
          style={{
            padding: '7px 10px',
            borderRadius: 10,
            border: '1px solid var(--button-ghost-border)',
            background: 'var(--button-ghost-bg)',
            color: 'var(--button-ghost-text)',
            cursor: 'pointer',
          }}
        >
          Обновить
        </button>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 10, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th
                style={{ textAlign: 'left', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
                onClick={() => toggleSort('engineNumber')}
              >
                Номер {sortArrow('engineNumber')}
              </th>
              <th
                style={{ textAlign: 'left', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
                onClick={() => toggleSort('engineBrand')}
              >
                Марка {sortArrow('engineBrand')}
              </th>
              <th
                style={{ textAlign: 'left', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
                onClick={() => toggleSort('customerName')}
              >
                Контрагент {sortArrow('customerName')}
              </th>
              <th
                style={{ textAlign: 'left', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
                onClick={() => toggleSort('arrivalDate')}
              >
                Дата прихода {sortArrow('arrivalDate')}
              </th>
              <th
                style={{ textAlign: 'left', padding: 8, position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer' }}
                onClick={() => toggleSort('shippingDate')}
              >
                Дата отгрузки {sortArrow('shippingDate')}
              </th>
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
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 10, color: '#6b7280' }}>
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
