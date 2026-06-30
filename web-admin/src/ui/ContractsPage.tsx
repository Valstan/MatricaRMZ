import React, { useEffect, useMemo, useState } from 'react';

import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { ContractDetailsPage } from './ContractDetailsPage.js';
import { effectiveContractDueAt, parseContractSections } from '@matricarmz/shared';
import {
  listAttributeDefs,
  listEntities,
  listEntityTypes,
  upsertAttributeDef,
  upsertEntityType,
  createEntity,
  getEntity,
} from '../api/masterdata.js';
import { formatMoscowDate, formatMoscowDateTime, formatRuMoney } from './utils/dateUtils.js';
import { getLinkOpenLabel, openLinkedEntity } from './utils/linkNavigation.js';
import { matchesQueryInRecord } from './utils/search.js';

type Row = {
  id: string;
  number: string;
  internalNumber: string;
  counterparty: string;
  counterpartyId: string;
  dateMs: number | null;
  dueDateMs: number | null;
  daysLeft: number | null;
  amount: number;
  updatedAt: number;
};

function getContractUrgencyStyle(daysLeft: number | null) {
  if (daysLeft == null) return {};
  const MONTH_1_DAYS = 30;
  const MONTH_3_DAYS = 92;
  const MONTH_6_DAYS = 183;
  if (daysLeft < 0) return { backgroundColor: 'rgba(239, 68, 68, 0.8)', color: '#fff' };
  if (daysLeft < MONTH_1_DAYS) return { backgroundColor: 'rgba(253, 242, 248, 0.9)' };
  if (daysLeft < MONTH_3_DAYS) return { backgroundColor: 'rgba(254, 240, 138, 0.9)' };
  if (daysLeft > MONTH_6_DAYS) return { backgroundColor: 'rgba(220, 252, 231, 0.9)' };
  return {};
}

type ContractMoneyRow = {
  qty?: unknown;
  unitPrice?: unknown;
};

function sumMoneyItems(rows: ContractMoneyRow[]) {
  return rows.reduce<number>((acc, row) => {
    if (!row || typeof row !== 'object') return acc;
    const qty = Number(row.qty);
    const unitPrice = Number(row.unitPrice);
    if (!Number.isFinite(qty) || !Number.isFinite(unitPrice)) return acc;
    return acc + qty * unitPrice;
  }, 0);
}

function getContractAmount(sections: ReturnType<typeof parseContractSections>): number {
  let total = 0;
  total += sumMoneyItems(sections.primary.engineBrands);
  total += sumMoneyItems(sections.primary.parts);
  for (const addon of sections.addons) {
    total += sumMoneyItems(addon.engineBrands);
    total += sumMoneyItems(addon.parts);
  }
  return total;
}

const REQUIRED_DEFS = [
  { code: 'number', name: 'Номер контракта', dataType: 'text' },
  { code: 'date', name: 'Дата контракта', dataType: 'date' },
  { code: 'internal_number', name: 'Внутренний номер', dataType: 'text' },
  { code: 'engine_brand_id', name: 'Марка двигателя', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'engine_brand' }) },
  { code: 'engine_count_items', name: 'Количество двигателей (детализация)', dataType: 'json' },
  { code: 'engine_count_total', name: 'Количество двигателей, шт.', dataType: 'number' },
  { code: 'contract_amount_rub', name: 'Сумма, ₽', dataType: 'number' },
  { code: 'unit_price_rub', name: 'Цена за единицу, ₽', dataType: 'number' },
  { code: 'attachments', name: 'Вложения', dataType: 'json' },
];

export function ContractsPage(props: {
  canViewMasterData: boolean;
  canEditMasterData: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contractTypeId, setContractTypeId] = useState<string>('');

  async function ensureContractSchema() {
    const typesRes = await listEntityTypes();
    if (!typesRes?.ok) throw new Error(typesRes?.error ?? 'types load failed');
    const types = typesRes.rows ?? [];
    let contractType = types.find((t: any) => String(t.code) === 'contract') ?? null;
    if (!contractType && props.canEditMasterData) {
      const created = await upsertEntityType({ code: 'contract', name: 'Контракты' });
      if (!created?.ok) throw new Error(created?.error ?? 'failed to create contract type');
      const reload = await listEntityTypes();
      contractType = reload?.rows?.find((t: any) => String(t.code) === 'contract') ?? null;
    }
    if (!contractType?.id) return null;
    const typeId = String(contractType.id);
    setContractTypeId(typeId);
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

  async function loadContracts() {
    try {
      setStatus('Загрузка…');
      const typeId = (await ensureContractSchema()) ?? '';
      if (!typeId) {
        setRows([]);
        setStatus('Справочник «Контракты» не найден (contract).');
        return;
      }
      const listRes = await listEntities(typeId);
      if (!listRes?.ok) {
        setStatus(`Ошибка: ${listRes?.error ?? 'list failed'}`);
        return;
      }
      const list = listRes.rows ?? [];
      const typesRes = await listEntityTypes();
      const allTypes = (typesRes?.rows ?? []) as Array<{ id: string; code?: string }>;
      const customerType = allTypes.find((t) => String(t.code) === 'customer') ?? null;
      const customerRowsRes = customerType?.id
        ? await listEntities(String(customerType.id)).catch(() => ({ ok: false, rows: [] as Array<{ id: string; displayName?: string }> }))
        : { ok: false, rows: [] as Array<{ id: string; displayName?: string }> };
      const customerById = new Map<string, string>();
      for (const row of customerRowsRes.rows ?? []) {
        if (!row?.id) continue;
        customerById.set(String(row.id), String(row.displayName ?? String(row.id).slice(0, 8)));
      }
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
            const sections = parseContractSections(attrs);
            const dueDateMs = effectiveContractDueAt(sections);
            const daysLeft = dueDateMs != null ? Math.ceil((dueDateMs - Date.now()) / (24 * 60 * 60 * 1000)) : null;
            const counterpartyId = sections.primary.customerId ? String(sections.primary.customerId) : '';
            return {
              id: String(row.id),
              number: sections.primary.number == null ? '' : String(sections.primary.number),
              internalNumber: sections.primary.internalNumber == null ? '' : String(sections.primary.internalNumber),
              counterparty: sections.primary.customerId ? customerById.get(sections.primary.customerId) ?? '—' : '—',
              counterpartyId,
              dateMs: typeof sections.primary.signedAt === 'number' ? sections.primary.signedAt : null,
              dueDateMs,
              daysLeft,
              amount: getContractAmount(sections),
              updatedAt: Number(row.updatedAt ?? 0),
            };
          } catch {
            return {
              id: String(row.id),
              number: row.displayName ? String(row.displayName) : String(row.id).slice(0, 8),
              internalNumber: '',
              counterpartyId: '',
              counterparty: '—',
              dateMs: null,
              dueDateMs: null,
              daysLeft: null,
              amount: 0,
              updatedAt: Number(row.updatedAt ?? 0),
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
    if (!props.canViewMasterData) return;
    void loadContracts();
  }, [props.canViewMasterData]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('diagnostics.openEntity');
      if (!raw) return;
      const parsed = JSON.parse(raw) as { typeCode?: string; entityId?: string };
      if (parsed?.typeCode !== 'contract' || !parsed.entityId) return;
      setSelectedId(String(parsed.entityId));
      localStorage.removeItem('diagnostics.openEntity');
    } catch {
      // ignore
    }
  }, []);

  const filtered = useMemo(() => {
    return rows.filter((row) => matchesQueryInRecord(query, row));
  }, [rows, query]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [filtered]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
        {props.canEditMasterData && (
          <Button
            onClick={async () => {
              if (!contractTypeId) return;
              setStatus('Создание контракта…');
              const r = await createEntity(contractTypeId);
              if (!r?.ok || !r?.id) {
                setStatus(`Ошибка: ${r?.error ?? 'create failed'}`);
                return;
              }
              setStatus('');
              await loadContracts();
              setSelectedId(String(r.id));
            }}
          >
            Создать контракт
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по всем данным контракта…" />
        </div>
        <Button variant="ghost" onClick={() => void loadContracts()}>
          Обновить
        </Button>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ marginTop: 10, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ textAlign: 'left', padding: 8 }}>Номер контракта</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Внутренний номер контракта</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Контрагент</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Дата заключения</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Дата исполнения</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Сумма контракта (контракт плюс ДС)</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Дата обновления карточки контракта</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const urgencyStyle = getContractUrgencyStyle(row.daysLeft);
                const textColor = typeof urgencyStyle.color === 'string' ? urgencyStyle.color : '#6b7280';
                const canHover = !('backgroundColor' in urgencyStyle);
                return (
                  <tr
                    key={row.id}
                    style={{
                      borderTop: '1px solid #f3f4f6',
                      cursor: 'pointer',
                      background: row.id === selectedId ? '#eff6ff' : 'transparent',
                      ...(urgencyStyle as Record<string, string>),
                    }}
                    onClick={() => setSelectedId(row.id)}
                    onMouseEnter={(e) => {
                      if (canHover) e.currentTarget.style.backgroundColor = '#f9fafb';
                    }}
                    onMouseLeave={(e) => {
                      if (canHover) e.currentTarget.style.backgroundColor = row.id === selectedId ? '#eff6ff' : 'transparent';
                    }}
                  >
                    <td style={{ padding: 8 }}>{row.number || '(без номера)'}</td>
                    <td style={{ padding: 8, color: textColor }}>{row.internalNumber || '—'}</td>
                    <td style={{ padding: 8, color: textColor }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ flex: 1 }}>{row.counterparty || '—'}</span>
                        <Button
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            openLinkedEntity('customer', row.counterpartyId);
                          }}
                          disabled={!row.counterpartyId}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {getLinkOpenLabel('customer')}
                        </Button>
                      </div>
                    </td>
                    <td style={{ padding: 8, color: textColor }}>{row.dateMs ? formatMoscowDate(row.dateMs) : '—'}</td>
                    <td style={{ padding: 8, color: textColor }}>{row.dueDateMs ? formatMoscowDate(row.dueDateMs) : '—'}</td>
                    <td style={{ padding: 8, color: textColor }}>{formatRuMoney(row.amount)}</td>
                    <td style={{ padding: 8, color: textColor }}>{row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—'}</td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 10, color: '#6b7280' }}>
                    Нет контрактов
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {selectedId && (
          <div style={{ marginTop: 12 }}>
            <ContractDetailsPage
              contractId={selectedId}
              canEditMasterData={props.canEditMasterData}
              canViewFiles={props.canViewFiles}
              canUploadFiles={props.canUploadFiles}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
