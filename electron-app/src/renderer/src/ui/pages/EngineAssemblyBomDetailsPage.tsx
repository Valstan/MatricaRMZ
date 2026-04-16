import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';

type BomDetails = {
  header: {
    id: string;
    name: string;
    engineNomenclatureId: string;
    status: string;
    isDefault: boolean;
    version: number;
    notes?: string | null;
  };
  lines: Array<{
    id?: string;
    componentNomenclatureId: string;
    componentNomenclatureCode?: string | null;
    componentNomenclatureName?: string | null;
    componentType: string;
    qtyPerUnit: number;
    variantGroup?: string | null;
    isRequired: boolean;
    priority: number;
    notes?: string | null;
  }>;
};
type BomLine = BomDetails['lines'][number];

const COMPONENT_TYPES = ['sleeve', 'piston', 'ring', 'jacket', 'head', 'other'] as const;

export function EngineAssemblyBomDetailsPage(props: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState('');
  const [data, setData] = useState<BomDetails | null>(null);
  const [componentOptions, setComponentOptions] = useState<SearchSelectOption[]>([]);

  const patchLine = useCallback((idx: number, patch: Partial<BomLine>) => {
    setData((prev) => {
      if (!prev) return prev;
      const current = prev.lines[idx];
      if (!current) return prev;
      const lines = [...prev.lines];
      lines[idx] = {
        id: current.id ?? '',
        componentNomenclatureId: current.componentNomenclatureId ?? '',
        componentNomenclatureCode: current.componentNomenclatureCode ?? null,
        componentNomenclatureName: current.componentNomenclatureName ?? null,
        componentType: current.componentType ?? 'other',
        qtyPerUnit: Number(current.qtyPerUnit ?? 0),
        variantGroup: current.variantGroup ?? null,
        isRequired: current.isRequired !== false,
        priority: Number(current.priority ?? 100),
        notes: current.notes ?? null,
        ...patch,
      };
      return { ...prev, lines };
    });
  }, []);

  const refresh = useCallback(async () => {
    setStatus('Загрузка BOM...');
    const result = await window.matrica.warehouse.assemblyBomGet(props.id);
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
      return;
    }
    setData((result.bom ?? null) as BomDetails | null);
    setStatus('');
  }, [props.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    const loadComponents = async () => {
      const result = await window.matrica.warehouse.nomenclatureList({
        isActive: true,
        limit: 5000,
      });
      if (!alive || !result?.ok) return;
      setComponentOptions(
        (result.rows ?? []).map((row) => ({
          id: String((row as any).id ?? ''),
          label: String((row as any).name ?? (row as any).code ?? ''),
          hintText: String((row as any).code ?? ''),
        })),
      );
    };
    void loadComponents();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="ghost" onClick={props.onClose}>
          Назад
        </Button>
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
        {props.canEdit && data ? (
          <>
            <Button
              onClick={async () => {
                const result = await window.matrica.warehouse.assemblyBomActivateDefault(data.header.id);
                if (!result?.ok) {
                  setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
                  return;
                }
                await refresh();
              }}
            >
              Сделать default/active
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                const result = await window.matrica.warehouse.assemblyBomArchive(data.header.id);
                if (!result?.ok) {
                  setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
                  return;
                }
                await refresh();
              }}
            >
              Архивировать
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                const printed = await window.matrica.warehouse.assemblyBomPrint(data.header.id);
                if (!printed?.ok) {
                  setStatus(`Ошибка печати: ${String(printed?.error ?? 'unknown')}`);
                  return;
                }
                setStatus('Печатная форма подготовлена (payload получен).');
              }}
            >
              Печать
            </Button>
          </>
        ) : null}
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
      {!data ? null : (
        <>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
            <Input
              value={data.header.name}
              onChange={(e) =>
                setData((prev) =>
                  prev
                    ? {
                        ...prev,
                        header: { ...prev.header, name: e.target.value },
                      }
                    : prev,
                )
              }
              disabled={!props.canEdit}
            />
            <Input value={String(data.header.version ?? 1)} disabled />
            <Input value={data.header.status} disabled />
            <Input value={data.header.isDefault ? 'default' : 'not default'} disabled />
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
            <table className="list-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Компонент</th>
                  <th style={{ textAlign: 'left' }}>Тип</th>
                  <th style={{ textAlign: 'left' }}>Qty/двиг.</th>
                  <th style={{ textAlign: 'left' }}>Группа</th>
                  <th style={{ textAlign: 'left' }}>Обяз.</th>
                  <th style={{ textAlign: 'left' }}>Приоритет</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line, idx) => (
                  <tr key={line.id || idx}>
                    <td style={{ minWidth: 260 }}>
                      <SearchSelect
                        value={line.componentNomenclatureId}
                        options={componentOptions}
                        onChange={(next) => patchLine(idx, { componentNomenclatureId: next ?? '' })}
                        disabled={!props.canEdit}
                      />
                    </td>
                    <td>
                      <select
                        value={line.componentType}
                        onChange={(e) => patchLine(idx, { componentType: e.target.value })}
                        disabled={!props.canEdit}
                      >
                        {COMPONENT_TYPES.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Input
                        value={String(line.qtyPerUnit ?? 0)}
                        onChange={(e) => patchLine(idx, { qtyPerUnit: Number(e.target.value || 0) })}
                        disabled={!props.canEdit}
                      />
                    </td>
                    <td>
                      <Input
                        value={line.variantGroup ?? ''}
                        onChange={(e) => patchLine(idx, { variantGroup: e.target.value || null })}
                        disabled={!props.canEdit}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={line.isRequired !== false}
                        onChange={(e) => patchLine(idx, { isRequired: e.target.checked })}
                        disabled={!props.canEdit}
                      />
                    </td>
                    <td>
                      <Input
                        value={String(line.priority ?? 100)}
                        onChange={(e) => patchLine(idx, { priority: Number(e.target.value || 0) })}
                        disabled={!props.canEdit}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {props.canEdit ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                variant="ghost"
                onClick={() =>
                  setData((prev) =>
                    prev
                      ? {
                          ...prev,
                          lines: [
                            ...prev.lines,
                            {
                              id: '',
                              componentNomenclatureId: '',
                              componentType: 'other',
                              qtyPerUnit: 1,
                              variantGroup: null,
                              isRequired: true,
                              priority: 100,
                            },
                          ],
                        }
                      : prev,
                  )
                }
              >
                Добавить строку
              </Button>
              <Button
                onClick={async () => {
                  if (!data) return;
                  const result = await window.matrica.warehouse.assemblyBomUpsert({
                    id: data.header.id,
                    name: data.header.name,
                    engineNomenclatureId: data.header.engineNomenclatureId,
                    version: data.header.version,
                    status: data.header.status,
                    isDefault: data.header.isDefault,
                    notes: data.header.notes ?? null,
                    lines: data.lines.map((line) => ({
                      ...(line.id ? { id: line.id } : {}),
                      componentNomenclatureId: line.componentNomenclatureId,
                      componentType: line.componentType,
                      qtyPerUnit: Number(line.qtyPerUnit ?? 0),
                      variantGroup: line.variantGroup ?? null,
                      isRequired: line.isRequired !== false,
                      priority: Number(line.priority ?? 100),
                      notes: line.notes ?? null,
                    })),
                  });
                  if (!result?.ok) {
                    setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
                    return;
                  }
                  await refresh();
                }}
              >
                Сохранить
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
