import React, { useEffect, useMemo, useState } from 'react';

import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { ContractDetailsPage } from './ContractDetailsPage.js';
import {
  listAttributeDefs,
  listEntities,
  listEntityTypes,
  upsertAttributeDef,
  upsertEntityType,
  createEntity,
  getEntity,
  softDeleteEntity,
} from '../api/masterdata.js';

type Row = {
  id: string;
  number: string;
  internalNumber: string;
  dateMs: number | null;
  updatedAt: number;
};

function normalize(s: string) {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

const REQUIRED_DEFS = [
  { code: 'number', name: 'Номер контракта', dataType: 'text' },
  { code: 'date', name: 'Дата контракта', dataType: 'date' },
  { code: 'internal_number', name: 'Внутренний номер', dataType: 'text' },
  { code: 'engine_brand_id', name: 'Марка двигателя', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'engine_brand' }) },
  { code: 'engine_count_items', name: 'Количество двигателей (детализация)', dataType: 'json' },
  { code: 'engine_count_total', name: 'Количество двигателей (итого)', dataType: 'number' },
  { code: 'contract_amount_rub', name: 'Сумма контракта (₽)', dataType: 'number' },
  { code: 'unit_price_rub', name: 'Цена за единицу (₽)', dataType: 'number' },
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
            return {
              id: String(row.id),
              number: attrs.number == null ? '' : String(attrs.number),
              internalNumber: attrs.internal_number == null ? '' : String(attrs.internal_number),
              dateMs: typeof attrs.date === 'number' ? Number(attrs.date) : null,
              updatedAt: Number(row.updatedAt ?? 0),
            };
          } catch {
            return {
              id: String(row.id),
              number: row.displayName ? String(row.displayName) : String(row.id).slice(0, 8),
              internalNumber: '',
              dateMs: null,
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

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return rows;
    return rows.filter((r) => normalize(r.number).includes(q) || normalize(r.internalNumber).includes(q));
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
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по номеру/внутреннему номеру…" />
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
                <th style={{ textAlign: 'left', padding: 8 }}>Номер</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Внутр. номер</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Дата</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Обновлено</th>
                {props.canEditMasterData && <th style={{ textAlign: 'left', padding: 8, width: 120 }}>Действия</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.id}
                  style={{ borderTop: '1px solid #f3f4f6', cursor: 'pointer', background: row.id === selectedId ? '#eff6ff' : 'transparent' }}
                  onClick={() => setSelectedId(row.id)}
                >
                  <td style={{ padding: 8 }}>{row.number || '(без номера)'}</td>
                  <td style={{ padding: 8, color: '#6b7280' }}>{row.internalNumber || '—'}</td>
                  <td style={{ padding: 8, color: '#6b7280' }}>{row.dateMs ? new Date(row.dateMs).toLocaleDateString('ru-RU') : '—'}</td>
                  <td style={{ padding: 8, color: '#6b7280' }}>{row.updatedAt ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}</td>
                  {props.canEditMasterData && (
                    <td style={{ padding: 8 }} onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          if (!confirm('Удалить контракт?')) return;
                          try {
                            setStatus('Удаление…');
                            const r = await softDeleteEntity(row.id);
                            if (!r?.ok) {
                              setStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
                              return;
                            }
                            setStatus('Удалено');
                            setTimeout(() => setStatus(''), 900);
                            await loadContracts();
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
                  <td colSpan={props.canEditMasterData ? 5 : 4} style={{ padding: 10, color: '#6b7280' }}>
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
