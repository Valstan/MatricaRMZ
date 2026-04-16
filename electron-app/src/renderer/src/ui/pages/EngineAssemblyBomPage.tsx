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

export function EngineAssemblyBomPage(props: {
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const { error: refsError } = useWarehouseReferenceData();
  const [status, setStatus] = useState('');
  const [engineNomenclatureId, setEngineNomenclatureId] = useState<string | null>(null);
  const [engineOptions, setEngineOptions] = useState<SearchSelectOption[]>([]);
  const [rows, setRows] = useState<BomListRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка BOM...');
      const result = await window.matrica.warehouse.assemblyBomList({
        ...(engineNomenclatureId ? { engineNomenclatureId } : {}),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows((result.rows ?? []) as BomListRow[]);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [engineNomenclatureId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    const loadEngineOptions = async () => {
      const result = await window.matrica.warehouse.nomenclatureList({
        itemType: 'engine',
        isActive: true,
        limit: 1000,
      });
      if (!alive || !result?.ok) return;
      setEngineOptions(
        (result.rows ?? []).map((row) => ({
          id: String((row as any).id ?? ''),
          label: String((row as any).name ?? (row as any).code ?? ''),
          hintText: String((row as any).code ?? ''),
        })),
      );
    };
    void loadEngineOptions();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(320px, 1fr) auto auto' }}>
        <SearchSelect
          value={engineNomenclatureId}
          options={engineOptions}
          placeholder="Фильтр по двигателю (номенклатура)"
          onChange={setEngineNomenclatureId}
        />
        {props.canEdit ? (
          <Button
            onClick={async () => {
              const created = await window.matrica.warehouse.assemblyBomUpsert({
                name: 'Новая BOM',
                engineNomenclatureId: engineNomenclatureId ?? '',
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
            disabled={!engineNomenclatureId}
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
