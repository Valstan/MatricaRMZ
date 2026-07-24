import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { RepairNormSetDetails, RepairNormSetInput, RepairNormSetStatus, RepairNormSetSummary } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { EntityReferenceField } from '../components/EntityReferenceField.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { formatListDateTime } from '../utils/dateUtils.js';

type EditableLine = RepairNormSetInput['lines'][number] & { clientKey: string };
type Draft = Omit<RepairNormSetInput, 'lines'> & { lines: EditableLine[] };

function emptyDraft(): Draft {
  return {
    name: '',
    version: 1,
    status: 'draft',
    notes: null,
    engineBrandIds: [],
    lines: [],
  };
}

function detailsToDraft(value: RepairNormSetDetails): Draft {
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    status: value.status,
    sourceKind: value.sourceKind,
    sourceKey: value.sourceKey,
    sourceImportedAt: value.sourceImportedAt,
    sourceContentHash: value.sourceContentHash,
    notes: value.notes,
    engineBrandIds: [...value.engineBrandIds],
    lines: value.lines.map((line) => ({
      id: line.id,
      clientKey: line.id,
      nomenclatureId: line.nomenclatureId,
      qtyPerEngine: line.qtyPerEngine,
      replacementPercent: line.replacementPercent,
      groupName: line.groupName,
      sourceRowKey: line.sourceRowKey,
      sourceMeta: line.sourceMeta,
      position: line.position,
    })),
  };
}

export function RepairNormsPage(props: { canEdit: boolean }) {
  const { lookups, nomenclature, loading: refsLoading, error: refsError } = useWarehouseReferenceData({ loadNomenclature: true });
  const [rows, setRows] = useState<RepairNormSetSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setStatus('Загрузка норм ремонта...');
    const result = await window.matrica.warehouse.repairNormList();
    if (!result.ok) {
      setStatus(`Ошибка: ${result.error}`);
      return;
    }
    setRows(result.rows);
    setStatus('');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const brandOptions = useMemo(
    () =>
      lookups.engineBrands
        .map((row) => ({ id: String(row.id), label: String(row.label || row.id), ...(row.code ? { hintText: String(row.code) } : {}) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    [lookups.engineBrands],
  );
  const nomenclatureOptions = useMemo(
    () =>
      nomenclature
        .map((row) => ({
          id: row.id,
          label: row.name,
          ...(row.code ? { hintText: row.code } : {}),
          searchText: `${row.name} ${row.code} ${row.sku ?? ''}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    [nomenclature],
  );

  async function open(id: string) {
    setStatus('Загрузка набора...');
    const result = await window.matrica.warehouse.repairNormGet(id);
    if (!result.ok) {
      setStatus(`Ошибка: ${result.error}`);
      return;
    }
    setSelectedId(id);
    setDraft(detailsToDraft(result.normSet));
    setStatus('');
  }

  function patchLine(clientKey: string, change: Partial<EditableLine>) {
    setDraft((current) =>
      current
        ? { ...current, lines: current.lines.map((line) => (line.clientKey === clientKey ? { ...line, ...change } : line)) }
        : current,
    );
  }

  async function save() {
    if (!draft || saving) return;
    const name = draft.name.trim();
    if (!name) return void setStatus('Укажите наименование набора норм.');
    if (draft.engineBrandIds.length === 0) return void setStatus('Выберите хотя бы одну марку двигателя.');
    if (draft.lines.some((line) => !line.nomenclatureId)) return void setStatus('Во всех строках должна быть выбрана номенклатура.');
    setSaving(true);
    setStatus('Сохранение...');
    const input: RepairNormSetInput = {
      ...(draft.id ? { id: draft.id } : {}),
      name,
      version: Math.max(1, Math.trunc(Number(draft.version ?? 1))),
      status: draft.status ?? 'draft',
      ...(draft.sourceKind !== undefined ? { sourceKind: draft.sourceKind } : {}),
      ...(draft.sourceKey !== undefined ? { sourceKey: draft.sourceKey } : {}),
      ...(draft.sourceImportedAt !== undefined ? { sourceImportedAt: draft.sourceImportedAt } : {}),
      ...(draft.sourceContentHash !== undefined ? { sourceContentHash: draft.sourceContentHash } : {}),
      notes: draft.notes ?? null,
      engineBrandIds: draft.engineBrandIds,
      lines: draft.lines.map(({ clientKey: _clientKey, ...line }, position) => ({ ...line, position })),
    };
    const result = await window.matrica.warehouse.repairNormUpsert(input);
    setSaving(false);
    if (!result.ok) return void setStatus(`Ошибка: ${result.error}`);
    await refresh();
    await open(result.id);
    setStatus('Сохранено.');
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 0.7fr) minmax(620px, 1.5fr)', gap: 12, minHeight: 0 }}>
      <section className="card" style={{ minHeight: 0, overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Нормы ремонта</h3>
          <Button size="sm" disabled={!props.canEdit} onClick={() => { setSelectedId(null); setDraft(emptyDraft()); setStatus(''); }}>
            Новый набор
          </Button>
        </div>
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => void open(row.id)}
            style={{
              width: '100%', textAlign: 'left', padding: 10, marginBottom: 6, borderRadius: 8,
              border: selectedId === row.id ? '1px solid var(--accent)' : '1px solid var(--border)',
              background: selectedId === row.id ? 'var(--surface-selected, var(--surface-2))' : 'var(--surface-1)', color: 'inherit', cursor: 'pointer',
            }}
          >
            <div style={{ fontWeight: 700 }}>{row.name}</div>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginTop: 3 }}>
              версия {row.version} · {row.lineCount} строк · {formatListDateTime(row.updatedAt)}
            </div>
          </button>
        ))}
        {!rows.length && !status ? <div className="muted">Наборов норм пока нет.</div> : null}
      </section>

      <section className="card" style={{ minHeight: 0, overflow: 'auto' }}>
        {!draft ? <div className="muted">Выберите набор норм или создайте новый.</div> : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) 100px 140px', gap: 10 }}>
              <label>Наименование<input value={draft.name} disabled={!props.canEdit} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
              <label>Версия<input type="number" min={1} value={draft.version ?? 1} disabled={!props.canEdit} onChange={(e) => setDraft({ ...draft, version: Number(e.target.value) })} /></label>
              <label>Статус<select value={draft.status ?? 'draft'} disabled={!props.canEdit} onChange={(e) => setDraft({ ...draft, status: e.target.value as RepairNormSetStatus })}><option value="draft">Черновик</option><option value="active">Действует</option><option value="archived">Архив</option></select></label>
            </div>
            <label style={{ display: 'block', marginTop: 10 }}>Марки двигателей<MultiSearchSelect values={draft.engineBrandIds} options={brandOptions} disabled={!props.canEdit || refsLoading} onChange={(engineBrandIds) => setDraft({ ...draft, engineBrandIds })} /></label>
            <label style={{ display: 'block', marginTop: 10 }}>Примечание<textarea value={draft.notes ?? ''} disabled={!props.canEdit} onChange={(e) => setDraft({ ...draft, notes: e.target.value || null })} /></label>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
              <h4 style={{ margin: 0 }}>Нормативные позиции</h4>
              <Button size="sm" disabled={!props.canEdit} onClick={() => setDraft({ ...draft, lines: [...draft.lines, { clientKey: crypto.randomUUID(), nomenclatureId: '', qtyPerEngine: 1, replacementPercent: 100, groupName: null }] })}>Добавить строку</Button>
            </div>
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              {draft.lines.map((line, index) => (
                <div key={line.clientKey} style={{ display: 'grid', gridTemplateColumns: '32px minmax(260px, 1fr) 110px 110px minmax(130px, .5fr) 32px', gap: 7, alignItems: 'end' }}>
                  <span style={{ alignSelf: 'center', color: 'var(--subtle)', textAlign: 'right' }}>{index + 1}</span>
                  <label>Номенклатура<EntityReferenceField target="nomenclature" targetLabel="Номенклатура" value={line.nomenclatureId || null} options={nomenclatureOptions} optionsReady={!refsLoading} disabled={!props.canEdit} onChange={(value) => patchLine(line.clientKey, { nomenclatureId: value ?? '' })} /></label>
                  <label>На двигатель<input type="number" min={0} step="0.001" value={line.qtyPerEngine} disabled={!props.canEdit} onChange={(e) => patchLine(line.clientKey, { qtyPerEngine: Number(e.target.value) })} /></label>
                  <label>Замена, %<input type="number" min={0} max={100} step="0.01" value={line.replacementPercent} disabled={!props.canEdit} onChange={(e) => patchLine(line.clientKey, { replacementPercent: Number(e.target.value) })} /></label>
                  <label>Группа<input value={line.groupName ?? ''} disabled={!props.canEdit} onChange={(e) => patchLine(line.clientKey, { groupName: e.target.value || null })} /></label>
                  <Button size="sm" variant="ghost" disabled={!props.canEdit} title="Удалить строку" onClick={() => setDraft({ ...draft, lines: draft.lines.filter((candidate) => candidate.clientKey !== line.clientKey) })}>×</Button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
              <Button disabled={!props.canEdit || saving} onClick={() => void save()}>Сохранить</Button>
              <span style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status || refsError}</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
