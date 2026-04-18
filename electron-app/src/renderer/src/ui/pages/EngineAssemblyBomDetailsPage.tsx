import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';

type BomDetails = {
  header: {
    id: string;
    name: string;
    engineNomenclatureId: string;
    engineNomenclatureCode?: string | null;
    engineNomenclatureName?: string | null;
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
    lineKey?: string | null;
    parentLineKey?: string | null;
    isRequired: boolean;
    priority: number;
    notes?: string | null;
  }>;
};
type BomLine = BomDetails['lines'][number];
type ViewMode = 'table' | 'tree';
type PreparedLine = BomLine & {
  idx: number;
  normalizedVariantGroup: string | null;
  normalizedLineKey: string | null;
  normalizedParentLineKey: string | null;
  componentLabel: string;
};
type LineIssue = {
  errors: string[];
  warnings: string[];
};

const COMPONENT_TYPES = ['sleeve', 'piston', 'ring', 'jacket', 'head', 'other'] as const;

const COMPONENT_TYPE_LABELS: Record<string, string> = {
  sleeve: 'Гильза',
  piston: 'Поршень',
  ring: 'Кольцо',
  jacket: 'Рубашка',
  head: 'Головка',
  other: 'Прочее',
};

function normalizeNodeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
}

function normalizeVariantGroup(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  return value || null;
}

function getLineDisplayLabel(line: BomLine): string {
  return line.componentNomenclatureName || line.componentNomenclatureCode || line.componentNomenclatureId || '(не выбран компонент)';
}

function prepareLines(lines: BomLine[]): PreparedLine[] {
  return lines.map((line, idx) => ({
    ...line,
    idx,
    normalizedVariantGroup: normalizeVariantGroup(line.variantGroup),
    normalizedLineKey: normalizeNodeKey(String(line.lineKey ?? '')) || null,
    normalizedParentLineKey: normalizeNodeKey(String(line.parentLineKey ?? '')) || null,
    componentLabel: getLineDisplayLabel(line),
  }));
}

function validatePreparedLines(lines: PreparedLine[]): {
  errors: string[];
  warnings: string[];
  lineIssues: Map<number, LineIssue>;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lineIssues = new Map<number, LineIssue>();
  const pushLineIssue = (idx: number, kind: 'error' | 'warning', message: string) => {
    const current = lineIssues.get(idx) ?? { errors: [], warnings: [] };
    if (kind === 'error') current.errors.push(message);
    else current.warnings.push(message);
    lineIssues.set(idx, current);
  };
  const keyToIndexes = new Map<string, number[]>();
  for (const line of lines) {
    if (!line.normalizedLineKey) continue;
    const list = keyToIndexes.get(line.normalizedLineKey) ?? [];
    list.push(line.idx);
    keyToIndexes.set(line.normalizedLineKey, list);
  }
  for (const [key, indexes] of keyToIndexes) {
    if (indexes.length <= 1) continue;
    errors.push(`Дубли ключа узла "${key}" в строках: ${indexes.map((idx) => idx + 1).join(', ')}.`);
    for (const idx of indexes) {
      pushLineIssue(idx, 'error', `Дубликат ключа узла "${key}".`);
    }
  }
  for (const line of lines) {
    if (!line.componentNomenclatureId) {
      errors.push(`Строка ${line.idx + 1}: не выбран компонент.`);
      pushLineIssue(line.idx, 'error', 'Не выбран компонент.');
    }
    if (line.normalizedParentLineKey && !line.normalizedLineKey) {
      errors.push(`Строка ${line.idx + 1}: для родителя нужно указать ключ узла.`);
      pushLineIssue(line.idx, 'error', 'Для родителя нужно указать ключ узла.');
    }
    if (line.normalizedParentLineKey && !keyToIndexes.has(line.normalizedParentLineKey)) {
      errors.push(`Строка ${line.idx + 1}: родительский узел "${line.normalizedParentLineKey}" не найден.`);
      pushLineIssue(line.idx, 'error', `Родитель "${line.normalizedParentLineKey}" не найден.`);
    }
    if (line.normalizedLineKey && line.normalizedParentLineKey && line.normalizedLineKey === line.normalizedParentLineKey) {
      errors.push(`Строка ${line.idx + 1}: узел не может ссылаться сам на себя.`);
      pushLineIssue(line.idx, 'error', 'Узел не может ссылаться сам на себя.');
    }
    if (line.qtyPerUnit <= 0 && line.isRequired !== false) {
      warnings.push(`Строка ${line.idx + 1}: обязательный компонент с нулевым количеством.`);
      pushLineIssue(line.idx, 'warning', 'Обязательный компонент с нулевым количеством.');
    }
  }

  const keyToParent = new Map<string, string | null>();
  for (const line of lines) {
    if (!line.normalizedLineKey || !keyToIndexes.has(line.normalizedLineKey) || keyToIndexes.get(line.normalizedLineKey)!.length !== 1) continue;
    keyToParent.set(line.normalizedLineKey, line.normalizedParentLineKey ?? null);
  }
  for (const key of keyToParent.keys()) {
    const chain = new Set<string>();
    let current: string | null = key;
    while (current) {
      if (chain.has(current)) {
        errors.push(`Обнаружен цикл в связях BOM: ${Array.from(chain).join(' -> ')} -> ${current}.`);
        for (const chainKey of chain) {
          const related = keyToIndexes.get(chainKey) ?? [];
          for (const idx of related) {
            pushLineIssue(idx, 'error', 'Узел участвует в циклической зависимости.');
          }
        }
        break;
      }
      chain.add(current);
      current = keyToParent.get(current) ?? null;
    }
  }

  return {
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings)),
    lineIssues,
  };
}

export function EngineAssemblyBomDetailsPage(props: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState('');
  const [data, setData] = useState<BomDetails | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [componentOptions, setComponentOptions] = useState<SearchSelectOption[]>([]);

  const preparedLines = useMemo(() => prepareLines(data?.lines ?? []), [data?.lines]);
  const lineValidation = useMemo(() => validatePreparedLines(preparedLines), [preparedLines]);
  const parentOptionsByLineIdx = useMemo(() => {
    const map = new Map<number, SearchSelectOption[]>();
    for (const line of preparedLines) {
      const options = preparedLines
        .filter((candidate) => candidate.idx !== line.idx && candidate.normalizedLineKey)
        .map((candidate) => ({
          id: String(candidate.normalizedLineKey),
          label: `${candidate.normalizedLineKey} - ${candidate.componentLabel}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      map.set(line.idx, options);
    }
    return map;
  }, [preparedLines]);

  const treeScopes = useMemo(() => {
    const baseLines = preparedLines.filter((line) => !line.normalizedVariantGroup);
    const groupNames = Array.from(new Set(preparedLines.map((line) => line.normalizedVariantGroup).filter((value): value is string => Boolean(value))));
    if (groupNames.length === 0) {
      return [{ id: 'base-only', title: 'Общая спецификация', lines: preparedLines }];
    }
    return groupNames.map((groupName) => ({
      id: groupName,
      title: `Вариант: ${groupName}`,
      lines: [...baseLines, ...preparedLines.filter((line) => line.normalizedVariantGroup === groupName)],
    }));
  }, [preparedLines]);

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
        lineKey: current.lineKey ?? null,
        parentLineKey: current.parentLineKey ?? null,
        isRequired: current.isRequired !== false,
        priority: Number(current.priority ?? 100),
        notes: current.notes ?? null,
        ...patch,
      };
      return { ...prev, lines };
    });
  }, []);

  const removeLine = useCallback((idx: number) => {
    setData((prev) => {
      if (!prev) return prev;
      const lines = prev.lines.filter((_, i) => i !== idx);
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

  const renderScopeTree = useCallback(
    (scope: { id: string; title: string; lines: PreparedLine[] }) => {
      const lineByKey = new Map<string, PreparedLine>();
      const childrenByParent = new Map<string | null, PreparedLine[]>();
      for (const line of scope.lines) {
        if (line.normalizedLineKey && !lineByKey.has(line.normalizedLineKey)) {
          lineByKey.set(line.normalizedLineKey, line);
        }
      }
      for (const line of scope.lines) {
        const parentKey = line.normalizedParentLineKey && lineByKey.has(line.normalizedParentLineKey) ? line.normalizedParentLineKey : null;
        const list = childrenByParent.get(parentKey) ?? [];
        list.push(line);
        childrenByParent.set(parentKey, list);
      }
      for (const list of childrenByParent.values()) {
        list.sort((a, b) => {
          const byPriority = Number(a.priority ?? 100) - Number(b.priority ?? 100);
          if (byPriority !== 0) return byPriority;
          return a.componentLabel.localeCompare(b.componentLabel, 'ru');
        });
      }
      const roots = childrenByParent.get(null) ?? [];
      const visited = new Set<number>();
      const renderNode = (line: PreparedLine, depth: number): React.ReactNode => {
        if (visited.has(line.idx)) return null;
        visited.add(line.idx);
        const key = line.normalizedLineKey ?? `line-${line.idx}`;
        const children = line.normalizedLineKey ? childrenByParent.get(line.normalizedLineKey) ?? [] : [];
        const issue = lineValidation.lineIssues.get(line.idx);
        const hasError = Boolean(issue?.errors?.length);
        const hasWarning = !hasError && Boolean(issue?.warnings?.length);
        return (
          <React.Fragment key={`${scope.id}-${key}-${line.idx}`}>
            <div
              style={{
                marginLeft: depth * 18,
                padding: '6px 8px',
                borderLeft: depth > 0 ? `2px solid ${hasError ? 'var(--danger)' : hasWarning ? 'var(--warning, #b45309)' : 'var(--border)'}` : 'none',
                display: 'grid',
                gridTemplateColumns: 'minmax(260px, 1fr) auto auto auto',
                gap: 8,
                alignItems: 'center',
                borderRadius: 6,
                background: hasError ? 'rgba(239, 68, 68, 0.08)' : hasWarning ? 'rgba(245, 158, 11, 0.08)' : 'transparent',
              }}
            >
              <span>{line.componentLabel}</span>
              <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{COMPONENT_TYPE_LABELS[line.componentType] ?? line.componentType}</span>
              <span style={{ color: 'var(--subtle)', fontSize: 12 }}>x{Number(line.qtyPerUnit ?? 0)}</span>
              <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{line.normalizedLineKey ? `узел: ${line.normalizedLineKey}` : 'без узла'}</span>
            </div>
            {issue && (issue.errors.length > 0 || issue.warnings.length > 0) ? (
              <div style={{ marginLeft: depth * 18 + 8, marginTop: 2, marginBottom: 4 }}>
                {issue.errors.map((message, messageIdx) => (
                  <div key={`e-${line.idx}-${messageIdx}`} style={{ color: 'var(--danger)', fontSize: 12 }}>
                    - {message}
                  </div>
                ))}
                {issue.warnings.map((message, messageIdx) => (
                  <div key={`w-${line.idx}-${messageIdx}`} style={{ color: 'var(--warning, #b45309)', fontSize: 12 }}>
                    - {message}
                  </div>
                ))}
              </div>
            ) : null}
            {children.map((child) => renderNode(child, depth + 1))}
          </React.Fragment>
        );
      };
      return (
        <div key={scope.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--surface2)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{scope.title}</div>
          {roots.length === 0 ? (
            <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Нет корневых узлов в этом варианте.</div>
          ) : (
            roots.map((root) => renderNode(root, 0))
          )}
        </div>
      );
    },
    [lineValidation.lineIssues],
  );

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
        <Button variant={viewMode === 'table' ? 'primary' : 'ghost'} onClick={() => setViewMode('table')}>
          Таблица
        </Button>
        <Button variant={viewMode === 'tree' ? 'primary' : 'ghost'} onClick={() => setViewMode('tree')}>
          Дерево
        </Button>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
      {lineValidation.errors.length > 0 ? (
        <div style={{ border: '1px solid var(--danger)', background: 'rgba(239, 68, 68, 0.08)', borderRadius: 8, padding: 8 }}>
          <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: 4 }}>Ошибки спецификации</div>
          {lineValidation.errors.map((message) => (
            <div key={message} style={{ color: 'var(--danger)', fontSize: 12 }}>
              - {message}
            </div>
          ))}
        </div>
      ) : null}
      {lineValidation.warnings.length > 0 ? (
        <div style={{ border: '1px solid var(--warning, #b45309)', background: 'rgba(245, 158, 11, 0.08)', borderRadius: 8, padding: 8 }}>
          <div style={{ fontWeight: 600, color: 'var(--warning, #b45309)', marginBottom: 4 }}>Предупреждения</div>
          {lineValidation.warnings.map((message) => (
            <div key={message} style={{ color: 'var(--warning, #b45309)', fontSize: 12 }}>
              - {message}
            </div>
          ))}
        </div>
      ) : null}
      {!data ? null : (
        <>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Двигатель, для которого собрана спецификация</span>
            <Input
              value={data.header.engineNomenclatureName || data.header.engineNomenclatureCode || data.header.engineNomenclatureId}
              disabled
            />
          </div>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Название BOM</span>
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
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Версия</span>
              <Input value={String(data.header.version ?? 1)} disabled />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Статус</span>
              <Input value={data.header.status} disabled />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Default</span>
              <Input value={data.header.isDefault ? 'default' : 'not default'} disabled />
            </label>
          </div>

          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Кол-во/двиг. = сколько штук компонента нужно на 1 двигатель. Группа связки = код совместимого набора (например, set-a). Узел = ключ текущего
            звена цепочки. Родительский узел = к какому узлу крепится текущий компонент.
          </div>

          {viewMode === 'table' ? (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
              <table className="list-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Компонент</th>
                    <th style={{ textAlign: 'left' }}>Тип</th>
                    <th style={{ textAlign: 'left' }}>Кол-во/двиг.</th>
                    <th style={{ textAlign: 'left' }}>Группа связки</th>
                    <th style={{ textAlign: 'left' }}>Узел</th>
                    <th style={{ textAlign: 'left' }}>Родительский узел</th>
                    <th style={{ textAlign: 'left' }}>Обяз.</th>
                    <th style={{ textAlign: 'left' }}>Приоритет</th>
                    {props.canEdit ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line, idx) => (
                    <tr
                      key={line.id || `new-${idx}`}
                      style={
                        lineValidation.lineIssues.get(idx)?.errors.length
                          ? { background: 'rgba(239, 68, 68, 0.08)' }
                          : lineValidation.lineIssues.get(idx)?.warnings.length
                            ? { background: 'rgba(245, 158, 11, 0.08)' }
                            : undefined
                      }
                    >
                      <td style={{ minWidth: 260 }}>
                        <SearchSelect
                          value={line.componentNomenclatureId}
                          options={componentOptions}
                          showAllWhenEmpty
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
                              {COMPONENT_TYPE_LABELS[option] ?? option}
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
                          placeholder="Например: set-a"
                          disabled={!props.canEdit}
                        />
                      </td>
                      <td>
                        <Input
                          value={line.lineKey ?? ''}
                          onChange={(e) => patchLine(idx, { lineKey: normalizeNodeKey(e.target.value) || null })}
                          placeholder="Например: sleeve-a"
                          disabled={!props.canEdit}
                        />
                      </td>
                      <td style={{ minWidth: 220 }}>
                        <SearchSelect
                          value={line.parentLineKey ?? null}
                          options={parentOptionsByLineIdx.get(idx) ?? []}
                          placeholder="Без родителя"
                          showAllWhenEmpty
                          onChange={(next) => patchLine(idx, { parentLineKey: next ?? null })}
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
                      {props.canEdit ? (
                        <td>
                          <Button
                            variant="ghost"
                            onClick={() => removeLine(idx)}
                            style={{ color: 'var(--danger)', padding: '2px 8px', minHeight: 0 }}
                          >
                            Удалить
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8, flex: 1, minHeight: 0, overflow: 'auto' }}>
              {treeScopes.map((scope) => renderScopeTree(scope))}
            </div>
          )}

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
                              lineKey: null,
                              parentLineKey: null,
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
                  if (lineValidation.errors.length > 0) {
                    setStatus(`Ошибка: исправьте ошибки спецификации (${lineValidation.errors.length}) перед сохранением.`);
                    return;
                  }
                  const result = await window.matrica.warehouse.assemblyBomUpsert({
                    id: data.header.id,
                    name: data.header.name,
                    engineNomenclatureId: data.header.engineNomenclatureId,
                    version: data.header.version,
                    status: data.header.status,
                    isDefault: data.header.isDefault,
                    notes: data.header.notes ?? null,
                    lines: data.lines.map((line) => ({
                      componentNomenclatureId: line.componentNomenclatureId,
                      componentType: line.componentType,
                      qtyPerUnit: Number(line.qtyPerUnit ?? 0),
                      variantGroup: line.variantGroup ?? null,
                      lineKey: normalizeNodeKey(String(line.lineKey ?? '')) || null,
                      parentLineKey: normalizeNodeKey(String(line.parentLineKey ?? '')) || null,
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
