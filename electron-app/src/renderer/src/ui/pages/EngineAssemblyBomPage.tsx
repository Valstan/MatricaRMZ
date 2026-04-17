import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import type { SearchSelectOption } from '../components/SearchSelect.js';

type BomListRow = {
  id: string;
  name: string;
  engineNomenclatureId: string;
  engineNomenclatureCode?: string | null;
  engineNomenclatureName?: string | null;
  version: number;
  status: string;
  isDefault: boolean;
  linesCount: number;
  updatedAt: number;
};

type EngineNomenclatureRow = {
  id: string;
  code: string;
  name: string;
  itemType: string;
  category: string;
  defaultBrandId: string;
  defaultBrandName: string;
  isSerialTracked: boolean;
};

function toEngineNomenclatureRow(input: unknown): EngineNomenclatureRow {
  const row = (input ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? '').trim(),
    code: String(row.code ?? '').trim(),
    name: String(row.name ?? '').trim(),
    itemType: String(row.itemType ?? '').trim().toLowerCase(),
    category: String(row.category ?? '').trim().toLowerCase(),
    defaultBrandId: String(row.defaultBrandId ?? '').trim(),
    defaultBrandName: String(row.defaultBrandName ?? '').trim(),
    isSerialTracked: Boolean(row.isSerialTracked),
  };
}

function isEngineLikeNomenclatureRow(row: EngineNomenclatureRow): boolean {
  if (!row.id) return false;
  if (row.itemType === 'engine') return true;
  if (row.category === 'engine') return true;
  if (row.isSerialTracked) return true;
  // Legacy imports can miss itemType but keep an engine brand link.
  if (row.defaultBrandId) return true;
  return false;
}

function toEngineOption(row: EngineNomenclatureRow): SearchSelectOption {
  return {
    id: row.id,
    label: row.name || row.code || row.id,
    ...(row.code ? { hintText: row.code } : {}),
  };
}

export function EngineAssemblyBomPage(props: {
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const { error: refsError } = useWarehouseReferenceData();
  const [status, setStatus] = useState('');
  const [engineBrandIdFilter, setEngineBrandIdFilter] = useState<string | null>(null);
  const [engineNomenclatureIdToCreate, setEngineNomenclatureIdToCreate] = useState<string | null>(null);
  const [engineRows, setEngineRows] = useState<EngineNomenclatureRow[]>([]);
  const [engineBrandOptions, setEngineBrandOptions] = useState<SearchSelectOption[]>([]);
  const [engineOptions, setEngineOptions] = useState<SearchSelectOption[]>([]);
  const [rows, setRows] = useState<BomListRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка BOM...');
      const result = await window.matrica.warehouse.assemblyBomList();
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      let nextRows = (result.rows ?? []) as BomListRow[];
      if (engineBrandIdFilter) {
        const allowedEngineIds = new Set(
          engineRows
            .filter((row) => row.defaultBrandId === engineBrandIdFilter)
            .map((row) => row.id),
        );
        nextRows = nextRows.filter((row) => allowedEngineIds.has(String(row.engineNomenclatureId)));
      }
      setRows(nextRows);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [engineBrandIdFilter, engineRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    const loadEngineOptions = async () => {
      const list = await window.matrica.warehouse.nomenclatureList({
        isActive: true,
        limit: 5000,
      });
      if (!alive || !list?.ok) return;
      const parsed = (list.rows ?? []).map(toEngineNomenclatureRow);
      const nextEngineRows = parsed.filter(isEngineLikeNomenclatureRow);
      setEngineRows(nextEngineRows);

      const brandById = new Map<string, SearchSelectOption>();
      for (const row of nextEngineRows) {
        if (!row.defaultBrandId) continue;
        if (!brandById.has(row.defaultBrandId)) {
          brandById.set(row.defaultBrandId, {
            id: row.defaultBrandId,
            label: row.defaultBrandName || row.defaultBrandId,
          });
        }
      }
      const sortedBrandOptions = Array.from(brandById.values()).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setEngineBrandOptions(sortedBrandOptions);
    };
    void loadEngineOptions();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!engineBrandIdFilter) {
      setEngineNomenclatureIdToCreate(null);
      setEngineOptions([]);
      return;
    }
    const nextEngineRows = engineRows.filter((row) => row.defaultBrandId === engineBrandIdFilter);
    const nextOptions = nextEngineRows.map(toEngineOption);
    setEngineOptions(nextOptions);
    setEngineNomenclatureIdToCreate((prev) => {
      if (prev && nextOptions.some((option) => option.id === prev)) return prev;
      return nextOptions[0]?.id ?? null;
    });
  }, [engineBrandIdFilter, engineRows]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(260px, 1fr) minmax(320px, 1fr) auto auto' }}>
        <SearchSelect
          value={engineBrandIdFilter}
          options={engineBrandOptions}
          placeholder="Фильтр по марке двигателя"
          onChange={setEngineBrandIdFilter}
        />
        <SearchSelect
          value={engineNomenclatureIdToCreate}
          options={engineOptions}
          placeholder="Двигатель для создания BOM"
          onChange={setEngineNomenclatureIdToCreate}
          disabled={!engineBrandIdFilter}
        />
        {props.canEdit ? (
          <Button
            onClick={async () => {
              const created = await window.matrica.warehouse.assemblyBomUpsert({
                name: 'Новая BOM',
                engineNomenclatureId: engineNomenclatureIdToCreate ?? '',
                status: 'draft',
                isDefault: false,
                lines: [],
              });
              if (!created?.ok || !created.id) {
                setStatus(`Ошибка: ${String(!created?.ok && created ? created.error : 'не удалось создать BOM')}`);
                return;
              }
              await refresh();
              props.onOpen(String(created.id));
            }}
            disabled={!engineNomenclatureIdToCreate}
          >
            Создать BOM
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>
      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Название</th>
              <th style={{ textAlign: 'left' }}>Двигатель</th>
              <th style={{ textAlign: 'left' }}>Версия</th>
              <th style={{ textAlign: 'left' }}>Статус</th>
              <th style={{ textAlign: 'left' }}>Default</th>
              <th style={{ textAlign: 'left' }}>Строк</th>
              <th style={{ textAlign: 'left' }}>Обновлено</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 12 }}>
                  Нет BOM-спецификаций
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                  <td>{row.name || '—'}</td>
                  <td>{row.engineNomenclatureName || row.engineNomenclatureCode || row.engineNomenclatureId}</td>
                  <td>{Number(row.version ?? 1)}</td>
                  <td>{row.status || 'draft'}</td>
                  <td>{row.isDefault ? 'Да' : 'Нет'}</td>
                  <td>{Number(row.linesCount ?? 0)}</td>
                  <td>{row.updatedAt ? new Date(Number(row.updatedAt)).toLocaleString('ru-RU') : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
