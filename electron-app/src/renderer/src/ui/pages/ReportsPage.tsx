import React, { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ReportBuilderColumnMeta,
  ReportBuilderFilter,
  ReportBuilderFilterCondition,
  ReportBuilderFilterGroup,
  ReportBuilderPreviewResult,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';

function toInputDate(ms: number) {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

type BuilderTableMeta = { name: string; label: string; columns: ReportBuilderColumnMeta[] };

const DEFAULT_GROUP: ReportBuilderFilterGroup = { kind: 'group', op: 'and', items: [] };

function cloneGroup(group: ReportBuilderFilterGroup): ReportBuilderFilterGroup {
  return {
    kind: 'group',
    op: group.op,
    items: group.items.map((item) => (item.kind === 'group' ? cloneGroup(item) : { ...item })),
  };
}

function updateGroupAtPath(
  group: ReportBuilderFilterGroup,
  path: number[],
  updater: (g: ReportBuilderFilterGroup) => ReportBuilderFilterGroup,
): ReportBuilderFilterGroup {
  if (path.length === 0) return updater(group);
  const [idx, ...rest] = path;
  const next = cloneGroup(group);
  const target = next.items[idx];
  if (!target || target.kind !== 'group') return next;
  next.items[idx] = updateGroupAtPath(target, rest, updater);
  return next;
}

function normalizeValueByType(type: ReportBuilderColumnMeta['type'], raw: any) {
  if (raw == null) return raw;
  if (type === 'number' || type === 'datetime') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return raw.toLowerCase() === 'true';
    return Boolean(raw);
  }
  return String(raw);
}

function normalizeFilterNode(node: ReportBuilderFilter, columns: ReportBuilderColumnMeta[]): ReportBuilderFilter | null {
  if (node.kind === 'group') {
    const items = node.items
      .map((child) => normalizeFilterNode(child, columns))
      .filter(Boolean) as ReportBuilderFilter[];
    return { ...node, items };
  }
  const col = columns.find((c) => c.id === node.column);
  if (!col) return null;
  if (node.operator === 'between' && node.value && typeof node.value === 'object' && !Array.isArray(node.value)) {
    const from = (node.value as any).from ?? '';
    const to = (node.value as any).to ?? '';
    return { ...node, value: [normalizeValueByType(col.type, from), normalizeValueByType(col.type, to)] };
  }
  if (node.operator === 'between' && typeof node.value === 'string') {
    const parts = node.value.split(',').map((v) => v.trim());
    return { ...node, value: [normalizeValueByType(col.type, parts[0] ?? ''), normalizeValueByType(col.type, parts[1] ?? '')] };
  }
  if (node.operator === 'in' && typeof node.value === 'string') {
    const list = node.value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => normalizeValueByType(col.type, v));
    return { ...node, value: list };
  }
  return { ...node, value: normalizeValueByType(col.type, node.value) };
}

export function ReportsPage(props: { canExport: boolean }) {
  const today = useMemo(() => new Date(), []);
  const [startDate, setStartDate] = useState<string>(() => toInputDate(new Date(today.getFullYear(), today.getMonth(), 1).getTime()));
  const [endDate, setEndDate] = useState<string>(() => toInputDate(Date.now()));
  const [status, setStatus] = useState<string>('');
  const [groupBy, setGroupBy] = useState<'none' | 'customer' | 'contract' | 'work_order'>('none');
  const [builderMeta, setBuilderMeta] = useState<BuilderTableMeta[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [filtersByTable, setFiltersByTable] = useState<Record<string, ReportBuilderFilterGroup>>({});
  const [preview, setPreview] = useState<ReportBuilderPreviewResult | null>(null);
  const [builderStatus, setBuilderStatus] = useState<string>('');
  const [builderWarning, setBuilderWarning] = useState<string>('');
  const previewTimer = useRef<number | null>(null);
  const [entityTypeOptions, setEntityTypeOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [attributeNameOptions, setAttributeNameOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [defectStartDate, setDefectStartDate] = useState<string>(() =>
    toInputDate(new Date(today.getFullYear(), today.getMonth(), 1).getTime()),
  );
  const [defectEndDate, setDefectEndDate] = useState<string>(() => toInputDate(Date.now()));
  const [contractOptions, setContractOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedContracts, setSelectedContracts] = useState<string[]>([]);
  const [defectStatus, setDefectStatus] = useState<string>('');
  const [defectPreview, setDefectPreview] = useState<{
    rows: any[];
    totals: { scrapQty: number; missingQty: number };
    totalsByContract: Array<{ contractLabel: string; scrapQty: number; missingQty: number }>;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await window.matrica.reportsBuilder.meta().catch(() => null);
      if (!alive) return;
      if (r && (r as any).ok) setBuilderMeta((r as any).tables ?? []);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const types = await window.matrica.admin.entityTypes.list();
        if (!alive) return;
        const typeRows = Array.isArray(types) ? (types as any[]) : [];
        const typeOptions = typeRows
          .map((t) => ({ id: String(t.name ?? t.code ?? t.id), label: String(t.name ?? t.code ?? t.id) }))
          .filter((o) => o.label.trim() !== '');
        typeOptions.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setEntityTypeOptions(typeOptions);

        const attrOptions: Array<{ id: string; label: string }> = [];
        for (const t of typeRows) {
          const typeId = String(t.id ?? '');
          if (!typeId) continue;
          const defs = await window.matrica.admin.attributeDefs.listByEntityType(typeId).catch(() => []);
          if (!alive) return;
          for (const d of defs as any[]) {
            const name = String(d.name ?? '').trim();
            if (!name) continue;
            attrOptions.push({ id: name, label: name });
          }
        }
        const unique = Array.from(new Map(attrOptions.map((o) => [o.id, o])).values());
        unique.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setAttributeNameOptions(unique);
      } catch {
        if (!alive) return;
        setEntityTypeOptions([]);
        setAttributeNameOptions([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const types = await window.matrica.admin.entityTypes.list();
        if (!alive) return;
        const contractType = (types as any[]).find((t) => String(t.code) === 'contract') ?? null;
        if (!contractType?.id) {
          setContractOptions([]);
          return;
        }
        const rows = await window.matrica.admin.entities.listByEntityType(String(contractType.id));
        if (!alive) return;
        const opts = (rows as any[]).map((r) => ({
          id: String(r.id),
          label: String(r.displayName ?? r.id),
        }));
        opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setContractOptions(opts);
      } catch {
        if (!alive) return;
        setContractOptions([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function downloadCsv() {
    const startMs = fromInputDate(startDate);
    const endMsRaw = fromInputDate(endDate);
    const endMs = endMsRaw ? endMsRaw + 24 * 60 * 60 * 1000 - 1 : null;
    if (!endMs) {
      setStatus('Некорректная дата окончания.');
      return;
    }
    setStatus('Формирование отчёта...');
    const r =
      groupBy === 'none'
        ? await window.matrica.reports.periodStagesCsv({ startMs: startMs ?? undefined, endMs })
        : await window.matrica.reports.periodStagesByLinkCsv({
            startMs: startMs ?? undefined,
            endMs,
            linkAttrCode: groupBy === 'customer' ? 'customer_id' : groupBy === 'contract' ? 'contract_id' : 'work_order_id',
          });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = groupBy === 'none' ? `stages_${startDate}_${endDate}.csv` : `stages_${groupBy}_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Готово: CSV скачан.');
  }

  function ensureFilter(table: string) {
    setFiltersByTable((prev) => {
      if (prev[table]) return prev;
      return { ...prev, [table]: cloneGroup(DEFAULT_GROUP) };
    });
  }

  function toggleTable(name: string, enabled: boolean) {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (enabled) next.add(name);
      else next.delete(name);
      return Array.from(next);
    });
    if (enabled) ensureFilter(name);
  }

  function updateFilterGroup(table: string, path: number[], updater: (g: ReportBuilderFilterGroup) => ReportBuilderFilterGroup) {
    setFiltersByTable((prev) => {
      const cur = prev[table] ?? cloneGroup(DEFAULT_GROUP);
      return { ...prev, [table]: updateGroupAtPath(cur, path, updater) };
    });
  }

  function addCondition(table: string, path: number[], columnId?: string) {
    const meta = builderMeta.find((t) => t.name === table);
    const firstColumn = columnId ?? meta?.columns[0]?.id ?? '';
    updateFilterGroup(table, path, (g) => ({
      ...g,
      items: [...g.items, { kind: 'condition', column: firstColumn, operator: 'eq', value: '' }],
    }));
  }

  function addGroup(table: string, path: number[]) {
    updateFilterGroup(table, path, (g) => ({
      ...g,
      items: [...g.items, { kind: 'group', op: 'and', items: [] }],
    }));
  }

  function removeItem(table: string, path: number[], index: number) {
    updateFilterGroup(table, path, (g) => ({
      ...g,
      items: g.items.filter((_it, idx) => idx !== index),
    }));
  }

  function buildRequest() {
    return {
      tables: selectedTables.map((name) => {
        const meta = builderMeta.find((t) => t.name === name);
        const filters = filtersByTable[name] ?? cloneGroup(DEFAULT_GROUP);
        const normalized = meta ? normalizeFilterNode(filters, meta.columns) : filters;
        return { name, filters: normalized as ReportBuilderFilterGroup };
      }),
      limit: 50,
    };
  }

  async function runPreview() {
    setBuilderStatus('Формирование предпросмотра...');
    setBuilderWarning('');
    const req = buildRequest();
    const r = await window.matrica.reportsBuilder.preview(req).catch(() => null);
    if (!r || !(r as any).ok) {
      setPreview(null);
      setBuilderStatus(`Ошибка: ${(r as any)?.error ?? 'не удалось сформировать'}`);
      return;
    }
    setPreview(r as ReportBuilderPreviewResult);
    setBuilderWarning((r as any).warning ?? '');
    setBuilderStatus('Готово.');
  }

  useEffect(() => {
    if (!selectedTables.length) {
      setPreview(null);
      setBuilderStatus('');
      setBuilderWarning('');
      return;
    }
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      void runPreview();
    }, 350);
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
    };
  }, [selectedTables, filtersByTable]);

  function downloadBase64(contentBase64: string, fileName: string, mime: string) {
    const bytes = Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function runDefectPreview() {
    const startMs = fromInputDate(defectStartDate);
    const endMsRaw = fromInputDate(defectEndDate);
    const endMs = endMsRaw ? endMsRaw + 24 * 60 * 60 * 1000 - 1 : null;
    if (!endMs) {
      setDefectStatus('Некорректная дата окончания.');
      return;
    }
    setDefectStatus('Формирование отчёта...');
    const r = await window.matrica.reports
      .defectSupplyPreview({ startMs: startMs ?? undefined, endMs, contractIds: selectedContracts })
      .catch(() => null);
    if (!r || !(r as any).ok) {
      setDefectPreview(null);
      setDefectStatus(`Ошибка: ${(r as any)?.error ?? 'не удалось сформировать'}`);
      return;
    }
    setDefectPreview({
      rows: (r as any).rows ?? [],
      totals: (r as any).totals ?? { scrapQty: 0, missingQty: 0 },
      totalsByContract: (r as any).totalsByContract ?? [],
    });
    setDefectStatus('Готово.');
  }

  async function exportDefectPdf() {
    const startMs = fromInputDate(defectStartDate);
    const endMsRaw = fromInputDate(defectEndDate);
    const endMs = endMsRaw ? endMsRaw + 24 * 60 * 60 * 1000 - 1 : null;
    if (!endMs) {
      setDefectStatus('Некорректная дата окончания.');
      return;
    }
    setDefectStatus('Генерация PDF...');
    const labels = contractOptions.filter((o) => selectedContracts.includes(o.id)).map((o) => o.label);
    const r = await window.matrica.reports
      .defectSupplyPdf({ startMs: startMs ?? undefined, endMs, contractIds: selectedContracts, contractLabels: labels })
      .catch(() => null);
    if (!r || !(r as any).ok) {
      setDefectStatus(`Ошибка: ${(r as any)?.error ?? 'не удалось создать PDF'}`);
      return;
    }
    downloadBase64((r as any).contentBase64, (r as any).fileName, (r as any).mime);
    setDefectStatus('Готово.');
  }

  async function printDefectReport() {
    const startMs = fromInputDate(defectStartDate);
    const endMsRaw = fromInputDate(defectEndDate);
    const endMs = endMsRaw ? endMsRaw + 24 * 60 * 60 * 1000 - 1 : null;
    if (!endMs) {
      setDefectStatus('Некорректная дата окончания.');
      return;
    }
    setDefectStatus('Отправка на печать...');
    const labels = contractOptions.filter((o) => selectedContracts.includes(o.id)).map((o) => o.label);
    const r = await window.matrica.reports
      .defectSupplyPrint({ startMs: startMs ?? undefined, endMs, contractIds: selectedContracts, contractLabels: labels })
      .catch(() => null);
    if (!r || !(r as any).ok) {
      setDefectStatus(`Ошибка: ${(r as any)?.error ?? 'не удалось печатать'}`);
      return;
    }
    setDefectStatus('Готово.');
  }

  async function exportBuilder(format: 'html' | 'xlsx') {
    setBuilderStatus('Формирование выгрузки...');
    setBuilderWarning('');
    const req = buildRequest();
    const r = await window.matrica.reportsBuilder.export({ ...req, format }).catch(() => null);
    if (!r || !(r as any).ok) {
      setBuilderStatus(`Ошибка: ${(r as any)?.error ?? 'не удалось выгрузить'}`);
      return;
    }
    if ((r as any).warning) setBuilderWarning((r as any).warning);
    downloadBase64((r as any).contentBase64, (r as any).fileName, (r as any).mime);
    setBuilderStatus('Готово.');
  }

  async function exportPdf() {
    setBuilderStatus('Генерация PDF...');
    setBuilderWarning('');
    const req = buildRequest();
    const r = await window.matrica.reportsBuilder.exportPdf(req).catch(() => null);
    if (!r || !(r as any).ok) {
      setBuilderStatus(`Ошибка: ${(r as any)?.error ?? 'не удалось создать PDF'}`);
      return;
    }
    if ((r as any).warning) setBuilderWarning((r as any).warning);
    downloadBase64((r as any).contentBase64, (r as any).fileName, (r as any).mime);
    setBuilderStatus('Готово.');
  }

  async function printBuilder() {
    setBuilderStatus('Отправка на печать...');
    setBuilderWarning('');
    const req = buildRequest();
    const r = await window.matrica.reportsBuilder.print(req).catch(() => null);
    if (!r || !(r as any).ok) {
      setBuilderStatus(`Ошибка: ${(r as any)?.error ?? 'не удалось печатать'}`);
      return;
    }
    setBuilderStatus('Готово.');
  }

  function updateCondition(table: string, path: number[], index: number, next: Partial<ReportBuilderFilterCondition>) {
    updateFilterGroup(table, path, (g) => {
      const items = [...g.items];
      const cur = items[index];
      if (!cur || cur.kind !== 'condition') return g;
      items[index] = { ...cur, ...next };
      return { ...g, items };
    });
  }

  function updateGroupOp(table: string, path: number[], op: 'and' | 'or') {
    updateFilterGroup(table, path, (g) => ({ ...g, op }));
  }

  function renderCondition(table: string, cond: ReportBuilderFilterCondition, path: number[], index: number, columns: ReportBuilderColumnMeta[]) {
    const column = columns.find((c) => c.id === cond.column) ?? columns[0];
    const type = column?.type ?? 'string';
    const ops =
      type === 'boolean'
        ? ['eq', 'neq', 'is_null', 'not_null']
        : type === 'number' || type === 'datetime'
          ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'is_null', 'not_null']
          : ['eq', 'neq', 'contains', 'starts_with', 'ends_with', 'between', 'in', 'is_null', 'not_null'];
    const opLabels: Record<ReportBuilderFilterCondition['operator'], string> = {
      eq: 'равно',
      neq: 'не равно',
      contains: 'содержит',
      starts_with: 'начинается с',
      ends_with: 'заканчивается на',
      gt: 'больше',
      gte: 'больше или равно',
      lt: 'меньше',
      lte: 'меньше или равно',
      between: 'диапазон',
      in: 'в списке',
      is_null: 'пусто',
      not_null: 'не пусто',
    };
    const lookupOptions =
      column?.id === 'entityTypeName' ? entityTypeOptions : column?.id === 'attributeName' ? attributeNameOptions : null;
    const listValues =
      typeof cond.value === 'string'
        ? cond.value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : [];
    return (
      <div key={`cond-${index}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={cond.column}
          onChange={(e) => updateCondition(table, path, index, { column: e.target.value })}
          style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          value={cond.operator}
          onChange={(e) => updateCondition(table, path, index, { operator: e.target.value as any })}
          style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
        >
          {ops.map((op) => (
            <option key={op} value={op}>
              {opLabels[op as ReportBuilderFilterCondition['operator']] ?? op}
            </option>
          ))}
        </select>
        {cond.operator === 'between' ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>с</div>
            <Input
              type={type === 'datetime' ? 'datetime-local' : type === 'number' ? 'number' : 'text'}
              value={typeof cond.value === 'object' && cond.value && !Array.isArray(cond.value) ? String((cond.value as any).from ?? '') : ''}
              onChange={(e) =>
                updateCondition(table, path, index, {
                  value: { ...(typeof cond.value === 'object' && cond.value && !Array.isArray(cond.value) ? cond.value : {}), from: e.target.value },
                })
              }
              placeholder={type === 'datetime' ? 'дата и время' : 'значение'}
            />
            <div style={{ fontSize: 12, color: '#6b7280' }}>по</div>
            <Input
              type={type === 'datetime' ? 'datetime-local' : type === 'number' ? 'number' : 'text'}
              value={typeof cond.value === 'object' && cond.value && !Array.isArray(cond.value) ? String((cond.value as any).to ?? '') : ''}
              onChange={(e) =>
                updateCondition(table, path, index, {
                  value: { ...(typeof cond.value === 'object' && cond.value && !Array.isArray(cond.value) ? cond.value : {}), to: e.target.value },
                })
              }
              placeholder={type === 'datetime' ? 'дата и время' : 'значение'}
            />
          </div>
        ) : cond.operator === 'in' && lookupOptions && lookupOptions.length > 0 ? (
          <MultiSearchSelect
            values={listValues}
            options={lookupOptions}
            onChange={(next) => updateCondition(table, path, index, { value: next.join(', ') })}
            placeholder="Выберите значения"
          />
        ) : cond.operator === 'in' ? (
          <Input
            value={typeof cond.value === 'string' ? cond.value : ''}
            onChange={(e) => updateCondition(table, path, index, { value: e.target.value })}
            placeholder="значения через запятую"
          />
        ) : cond.operator === 'is_null' || cond.operator === 'not_null' ? null : type === 'boolean' ? (
          <select
            value={String(cond.value ?? 'true')}
            onChange={(e) => updateCondition(table, path, index, { value: e.target.value })}
            style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
          >
            <option value="true">да</option>
            <option value="false">нет</option>
          </select>
        ) : lookupOptions && lookupOptions.length > 0 && (cond.operator === 'eq' || cond.operator === 'neq') ? (
          <SearchSelect
            value={typeof cond.value === 'string' && cond.value ? cond.value : null}
            options={lookupOptions}
            placeholder="Выберите значение"
            onChange={(next) => updateCondition(table, path, index, { value: next ?? '' })}
          />
        ) : (
          <Input
            type={type === 'datetime' ? 'datetime-local' : type === 'number' ? 'number' : 'text'}
            value={cond.value == null ? '' : String(cond.value)}
            onChange={(e) => updateCondition(table, path, index, { value: e.target.value })}
            placeholder="значение"
          />
        )}
        <Button variant="ghost" onClick={() => removeItem(table, path, index)}>
          Удалить
        </Button>
      </div>
    );
  }

  function renderGroup(table: string, group: ReportBuilderFilterGroup, path: number[], columns: ReportBuilderColumnMeta[]) {
    return (
      <div style={{ border: '1px dashed #e5e7eb', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ fontWeight: 700 }}>Группа условий</div>
          <select
            value={group.op}
            onChange={(e) => updateGroupOp(table, path, e.target.value as any)}
            style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
          >
            <option value="and">И</option>
            <option value="or">ИЛИ</option>
          </select>
          <Button variant="ghost" onClick={() => addCondition(table, path)}>
            + Условие
          </Button>
          <Button variant="ghost" onClick={() => addGroup(table, path)}>
            + Группа
          </Button>
        </div>
        {group.items.length === 0 && <div style={{ color: '#6b7280' }}>Нет условий</div>}
        {group.items.map((item, idx) =>
          item.kind === 'group'
            ? renderGroup(table, item, [...path, idx], columns)
            : renderCondition(table, item, path, idx, columns),
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Отчёты</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Отчёт: сколько двигателей на какой стадии (по последней операции на дату окончания), опционально с группировкой по заказчику/контракту/наряду.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 200 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Начало (включительно)</div>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div style={{ width: 200 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Конец (включительно)</div>
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div style={{ width: 220 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Группировка</div>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as any)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
          >
            <option value="none">без группировки</option>
            <option value="customer">по заказчику</option>
            <option value="contract">по контракту</option>
            <option value="work_order">по наряду</option>
          </select>
        </div>
        <div style={{ flex: 1 }} />
        {props.canExport && <Button onClick={() => void downloadCsv()}>Скачать CSV</Button>}
      </div>

      {status && <div style={{ marginTop: 10, color: '#6b7280' }}>{status}</div>}

      <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #e5e7eb' }} />

      <h3 style={{ margin: '8px 0' }}>Дефектовка и комплектность</h3>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Сводный отчет для снабжения: утиль по дефектовке и недокомплект по акту комплектности.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ width: 200 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Начало (включительно)</div>
          <Input type="date" value={defectStartDate} onChange={(e) => setDefectStartDate(e.target.value)} />
        </div>
        <div style={{ width: 200 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Конец (включительно)</div>
          <Input type="date" value={defectEndDate} onChange={(e) => setDefectEndDate(e.target.value)} />
        </div>
        <div style={{ minWidth: 260, flex: 1 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Контракты</div>
          <MultiSearchSelect
            values={selectedContracts}
            options={contractOptions}
            onChange={setSelectedContracts}
            placeholder="Все контракты"
          />
        </div>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => void runDefectPreview()}>
          Предпросмотр
        </Button>
        <Button variant="ghost" onClick={() => void printDefectReport()}>
          Печать
        </Button>
        <Button variant="ghost" onClick={() => void exportDefectPdf()}>
          PDF
        </Button>
      </div>

      {defectStatus && <div style={{ marginTop: 10, color: '#6b7280' }}>{defectStatus}</div>}

      {defectPreview ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Результаты</div>
          <div style={{ marginBottom: 10, color: '#334155' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Итого по контрактам</div>
            {defectPreview.totalsByContract.length === 0 ? (
              <div style={{ color: '#6b7280' }}>Нет данных</div>
            ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                {defectPreview.totalsByContract.map((t) => (
                  <div key={t.contractLabel}>
                    {t.contractLabel}: утиль {t.scrapQty}, недокомплект {t.missingQty}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>Контракт</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>Деталь</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>№ детали</th>
                  <th style={{ textAlign: 'right', padding: 8, borderBottom: '1px solid #e5e7eb' }}>Утиль</th>
                  <th style={{ textAlign: 'right', padding: 8, borderBottom: '1px solid #e5e7eb' }}>Недокомплект</th>
                </tr>
              </thead>
              <tbody>
                {defectPreview.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 10, color: '#6b7280' }}>
                      Нет данных
                    </td>
                  </tr>
                )}
                {(() => {
                  const subtotalByContract = new Map(
                    defectPreview.totalsByContract.map((t) => [t.contractLabel, t] as const),
                  );
                  let current = '';
                  const out: React.ReactNode[] = [];
                  defectPreview.rows.forEach((r: any, idx: number) => {
                    if (current && current !== r.contractLabel) {
                      const subtotal = subtotalByContract.get(current);
                      if (subtotal) {
                        out.push(
                          <tr key={`subtotal-${current}`} style={{ background: '#f8fafc', fontWeight: 700 }}>
                            <td colSpan={3} style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>
                              Итого по контракту: {current}
                            </td>
                            <td style={{ padding: 8, textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>
                              {subtotal.scrapQty}
                            </td>
                            <td style={{ padding: 8, textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>
                              {subtotal.missingQty}
                            </td>
                          </tr>,
                        );
                      }
                    }
                    current = r.contractLabel;
                    out.push(
                      <tr key={`${r.contractLabel}-${r.partName}-${r.partNumber}-${idx}`}>
                        <td style={{ padding: 8, borderBottom: '1px solid #f1f5f9' }}>{r.contractLabel}</td>
                        <td style={{ padding: 8, borderBottom: '1px solid #f1f5f9' }}>{r.partName}</td>
                        <td style={{ padding: 8, borderBottom: '1px solid #f1f5f9' }}>{r.partNumber}</td>
                        <td style={{ padding: 8, textAlign: 'right', borderBottom: '1px solid #f1f5f9' }}>{r.scrapQty}</td>
                        <td style={{ padding: 8, textAlign: 'right', borderBottom: '1px solid #f1f5f9' }}>
                          {r.missingQty}
                        </td>
                      </tr>,
                    );
                  });
                  if (current) {
                    const subtotal = subtotalByContract.get(current);
                    if (subtotal) {
                      out.push(
                        <tr key={`subtotal-${current}`} style={{ background: '#f8fafc', fontWeight: 700 }}>
                          <td colSpan={3} style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>
                            Итого по контракту: {current}
                          </td>
                          <td style={{ padding: 8, textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>
                            {subtotal.scrapQty}
                          </td>
                          <td style={{ padding: 8, textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>
                            {subtotal.missingQty}
                          </td>
                        </tr>,
                      );
                    }
                  }
                  return out;
                })()}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, fontWeight: 700 }}>
            Итого: утиль {defectPreview.totals.scrapQty}, недокомплект {defectPreview.totals.missingQty}
          </div>
        </div>
      ) : null}

      <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #e5e7eb' }} />

      <h3 style={{ margin: '8px 0' }}>Конструктор выгрузок</h3>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Выберите таблицы и настройте фильтры. Предпросмотр обновляется автоматически. При отсутствии доступа к части таблиц выгрузка будет неполной.
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        {builderMeta.map((t) => (
          <label key={t.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={selectedTables.includes(t.name)}
              onChange={(e) => toggleTable(t.name, e.target.checked)}
            />
            <span>{t.label}</span>
          </label>
        ))}
      </div>

      {selectedTables.map((name) => {
        const meta = builderMeta.find((t) => t.name === name);
        if (!meta) return null;
        const group = filtersByTable[name] ?? cloneGroup(DEFAULT_GROUP);
        return (
          <div key={name} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{meta.label}</div>
            {renderGroup(name, group, [], meta.columns)}
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Button variant="ghost" onClick={() => void runPreview()} disabled={!selectedTables.length}>
          Обновить предпросмотр
        </Button>
        <Button variant="ghost" onClick={() => void exportBuilder('html')} disabled={!selectedTables.length}>
          HTML
        </Button>
        <Button variant="ghost" onClick={() => void exportPdf()} disabled={!selectedTables.length}>
          PDF
        </Button>
        <Button variant="ghost" onClick={() => void exportBuilder('xlsx')} disabled={!selectedTables.length}>
          Excel
        </Button>
        <Button variant="ghost" onClick={() => void printBuilder()} disabled={!selectedTables.length}>
          Печать
        </Button>
      </div>

      {builderWarning && <div style={{ color: '#b45309', marginBottom: 8 }}>{builderWarning}</div>}
      {builderStatus && <div style={{ color: '#6b7280', marginBottom: 10 }}>{builderStatus}</div>}

      {preview && preview.ok && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Предпросмотр (первые строки)</div>
          {preview.tables.map((t) => (
            <div key={t.name} style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{t.label}</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {t.columns.map((c) => (
                        <th key={c.id} style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left', padding: 6 }}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((row, idx) => (
                      <tr key={idx}>
                        {t.columns.map((c) => (
                          <td key={c.id} style={{ borderBottom: '1px solid #f3f4f6', padding: 6 }}>
                            {row[c.id] == null ? '' : typeof row[c.id] === 'string' ? row[c.id] : JSON.stringify(row[c.id])}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {t.rows.length === 0 && (
                      <tr>
                        <td colSpan={t.columns.length} style={{ color: '#6b7280', padding: 6 }}>
                          Нет данных
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


