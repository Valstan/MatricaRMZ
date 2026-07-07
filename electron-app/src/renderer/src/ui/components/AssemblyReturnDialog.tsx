import React, { useEffect, useMemo, useState } from 'react';

import { AssemblyReturnMode, ASSEMBLY_RETURN_MODE_LABELS } from '@matricarmz/shared';

import { Button } from './Button.js';
import { useConfirm } from './ConfirmContext.js';
import { Input } from './Input.js';
import { SearchSelect, SearchSelectOption } from './SearchSelect.js';

type Line = {
  id: string;
  nomenclatureId: string;
  qty: number;
  mode: 'rework' | 'scrap';
};

function freshLine(): Line {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, nomenclatureId: '', qty: 1, mode: AssemblyReturnMode.Rework };
}

function toOption(id: string, name: string, code: string): SearchSelectOption {
  const label = name || code || id;
  const searchText = `${name} ${code}`.trim();
  return { id, label, ...(code ? { hintText: code } : {}), ...(searchText ? { searchText } : {}) };
}

export function AssemblyReturnDialog(props: {
  open: boolean;
  onClose: () => void;
  engineId: string;
  engineLabel: string;
  engineBrandId?: string | null;
  onComplete?: (result: { documentId: string }) => void;
}) {
  const [lines, setLines] = useState<Line[]>([freshLine()]);
  const [reason, setReason] = useState('');
  // Детали спецификации марки: приоритетный источник подсказок.
  const [brandOptions, setBrandOptions] = useState<SearchSelectOption[]>([]);
  const [brandQtyMap, setBrandQtyMap] = useState<Map<string, number>>(new Map());
  const [bomName, setBomName] = useState('');
  const [brandLoading, setBrandLoading] = useState(false);
  // Полная номенклатура — грузится лениво (тумблер «все детали» или когда у марки нет спеки).
  const [allOptions, setAllOptions] = useState<SearchSelectOption[] | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { confirm } = useConfirm();

  useEffect(() => {
    if (!props.open) return;
    setLines([freshLine()]);
    setReason('');
    setStatus('');
    setShowAll(false);
    setBrandOptions([]);
    setBrandQtyMap(new Map());
    setBomName('');
    if (props.engineBrandId) void loadBrandParts(props.engineBrandId);
  }, [props.open, props.engineId, props.engineBrandId]);

  async function loadBrandParts(engineBrandId: string) {
    setBrandLoading(true);
    try {
      const listRes = await window.matrica.warehouse.assemblyBomList({ engineBrandId, status: 'active' });
      if (!listRes?.ok) return;
      const rows = (listRes.rows ?? []) as Array<Record<string, unknown>>;
      const primary = rows.find((r) => Boolean(r.isDefault)) ?? rows[0];
      if (!primary) return;
      const detailsRes = await window.matrica.warehouse.assemblyBomGet(String(primary.id));
      if (!detailsRes?.ok) return;
      const bomLines = Array.isArray((detailsRes as any).bom?.lines) ? ((detailsRes as any).bom.lines as Array<Record<string, unknown>>) : [];
      const seen = new Map<string, { name: string; code: string; qty: number }>();
      for (const l of bomLines) {
        const id = String(l.componentNomenclatureId ?? '').trim();
        if (!id) continue;
        if (!seen.has(id)) {
          seen.set(id, {
            name: String(l.componentNomenclatureName ?? '').trim(),
            code: String(l.componentNomenclatureCode ?? '').trim(),
            qty: Number(l.qtyPerUnit ?? 0) || 0,
          });
        }
      }
      const opts: SearchSelectOption[] = [];
      const qtyMap = new Map<string, number>();
      for (const [id, v] of seen) {
        opts.push(toOption(id, v.name, v.code));
        if (v.qty > 0) qtyMap.set(id, v.qty);
      }
      setBrandOptions(opts);
      setBrandQtyMap(qtyMap);
      setBomName(String(primary.name ?? ''));
    } finally {
      setBrandLoading(false);
    }
  }

  async function ensureAllOptions() {
    if (allOptions !== null || allLoading) return;
    setAllLoading(true);
    try {
      const r = await window.matrica.warehouse.nomenclatureList({ limit: 5000 });
      if (r?.ok && Array.isArray(r.rows)) {
        const opts = (r.rows as Array<Record<string, unknown>>)
          .filter((row) => row.id)
          .map((row) => toOption(String(row.id), String(row.name ?? ''), String(row.code ?? '')));
        setAllOptions(opts);
      } else {
        setAllOptions([]);
      }
    } finally {
      setAllLoading(false);
    }
  }

  // Нет марки/спеки → сразу показываем всю номенклатуру.
  const noBrandParts = brandOptions.length === 0 && !brandLoading;
  const usingAll = showAll || noBrandParts;

  useEffect(() => {
    if (props.open && usingAll) void ensureAllOptions();
  }, [props.open, usingAll]);

  const optionById = useMemo(() => {
    const m = new Map<string, SearchSelectOption>();
    for (const o of allOptions ?? []) m.set(o.id, o);
    for (const o of brandOptions) m.set(o.id, o);
    return m;
  }, [allOptions, brandOptions]);

  const effectiveOptions = useMemo(() => {
    const base = usingAll ? allOptions ?? brandOptions : brandOptions;
    const present = new Set(base.map((o) => o.id));
    const extras: SearchSelectOption[] = [];
    for (const l of lines) {
      if (l.nomenclatureId && !present.has(l.nomenclatureId)) {
        const o = optionById.get(l.nomenclatureId);
        if (o) {
          extras.push(o);
          present.add(o.id);
        }
      }
    }
    return extras.length ? [...base, ...extras] : base;
  }, [usingAll, allOptions, brandOptions, lines, optionById]);

  const sums = useMemo(() => {
    let rework = 0;
    let scrap = 0;
    for (const l of lines) {
      if (!l.nomenclatureId || l.qty <= 0) continue;
      if (l.mode === AssemblyReturnMode.Rework) rework += Math.trunc(l.qty);
      else scrap += Math.trunc(l.qty);
    }
    return { rework, scrap, total: rework + scrap };
  }, [lines]);

  if (!props.open) return null;

  function addLine() {
    setLines((prev) => [...prev, freshLine()]);
  }
  function patchLine(id: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function removeLine(id: string) {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.id !== id)));
  }

  async function submit() {
    setStatus('');
    const ready = lines
      .filter((l) => l.nomenclatureId && l.qty > 0)
      .map((l) => ({ nomenclatureId: l.nomenclatureId, qty: Math.trunc(l.qty), mode: l.mode }));
    if (ready.length === 0) {
      setStatus('Заполните хотя бы одну строку (деталь + кол-во > 0)');
      return;
    }
    const ok = await confirm({
      title: 'Провести возврат из сборки?',
      detail:
        `Двигатель: «${props.engineLabel}».\n` +
        `Позиций: ${ready.length}. В ремфонд: ${sums.rework} шт, в утиль: ${sums.scrap} шт (всего ${sums.total}).\n\n` +
        'Будут созданы складские движения (ремфонд/утиль) с привязкой к двигателю — это изменит остатки. Отменять придётся вручную.',
      confirmLabel: 'Провести возврат',
      confirmTone: 'warn',
    });
    if (!ok) return;
    setSubmitting(true);
    try {
      const r = await window.matrica.workOrders.assemblyReturn({
        engineId: props.engineId,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        lines: ready,
      });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      props.onComplete?.({ documentId: r.documentId });
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={props.onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)',
          padding: 16,
          borderRadius: 8,
          maxWidth: 'min(96vw, 960px)',
          width: '96vw',
          maxHeight: '88vh',
          overflow: 'auto',
          border: '1px solid var(--border)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Возврат деталей из сборки</h3>
          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>двигатель: {props.engineLabel}</span>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginBottom: 10,
            fontSize: 12,
            color: 'var(--subtle)',
          }}
        >
          {brandLoading ? (
            <span>Загрузка деталей марки…</span>
          ) : bomName ? (
            <span>
              Детали из спецификации марки: <strong>{bomName}</strong>
            </span>
          ) : noBrandParts ? (
            <span>У марки нет активной спецификации — показаны все детали.</span>
          ) : null}
          {!noBrandParts && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Показывать все детали (не только марки)
            </label>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)', flexShrink: 0 }}>Причина:</span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Например: обнаружен брак при контрольной сборке"
            data-autogrow="off"
            style={{ flex: 1 }}
          />
        </div>

        <table className="list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Деталь</th>
              <th style={{ width: 90, textAlign: 'right' }} title="Норма расхода на один двигатель по спецификации">Норма/двиг.</th>
              <th style={{ width: 90 }}>Кол-во</th>
              <th style={{ width: 170 }}>Куда</th>
              <th style={{ width: 48 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const norm = brandQtyMap.get(line.nomenclatureId);
              return (
                <tr key={line.id}>
                  <td style={{ minWidth: 260 }}>
                    <SearchSelect
                      value={line.nomenclatureId || null}
                      options={effectiveOptions}
                      placeholder={
                        brandLoading || allLoading ? 'Загрузка…' : usingAll ? 'начните вводить деталь…' : 'деталь марки…'
                      }
                      emptyQueryLimit={200}
                      onChange={(next) => patchLine(line.id, { nomenclatureId: next ?? '' })}
                    />
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--subtle)' }}>{norm ? norm : '—'}</td>
                  <td>
                    <Input
                      type="number"
                      value={String(line.qty)}
                      onChange={(e) => patchLine(line.id, { qty: Math.max(0, Number(e.target.value) || 0) })}
                      data-autogrow="off"
                      style={{ width: 80, textAlign: 'right' }}
                    />
                  </td>
                  <td>
                    <select
                      value={line.mode}
                      onChange={(e) =>
                        patchLine(line.id, {
                          mode: e.target.value === AssemblyReturnMode.Scrap ? AssemblyReturnMode.Scrap : AssemblyReturnMode.Rework,
                        })
                      }
                      style={{ width: '100%', padding: '4px 6px' }}
                    >
                      <option value={AssemblyReturnMode.Rework}>{ASSEMBLY_RETURN_MODE_LABELS[AssemblyReturnMode.Rework]} (в ремфонд)</option>
                      <option value={AssemblyReturnMode.Scrap}>{ASSEMBLY_RETURN_MODE_LABELS[AssemblyReturnMode.Scrap]} (в утиль)</option>
                    </select>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <Button variant="ghost" onClick={() => removeLine(line.id)} disabled={lines.length <= 1} title="Удалить строку">
                      ✕
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} style={{ textAlign: 'right', padding: '8px', color: 'var(--subtle)' }}>
                В ремфонд: <strong style={{ color: 'var(--text)' }}>{sums.rework}</strong> · в утиль:{' '}
                <strong style={{ color: 'var(--text)' }}>{sums.scrap}</strong>
              </td>
              <td style={{ textAlign: 'right' }} title="Всего к возврату">
                <strong>{sums.total}</strong>
              </td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>

        <div style={{ marginTop: 8 }}>
          <Button variant="ghost" onClick={addLine}>
            + строка
          </Button>
        </div>

        {status ? (
          <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 13 }}>{status}</div>
        ) : null}

        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Движения создаются с привязкой к двигателю, видны в отчёте «Журнал движений деталей».
          </span>
          <Button variant="ghost" onClick={props.onClose}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || sums.total === 0}>
            {submitting ? 'Отправляю…' : 'Провести возврат'}
          </Button>
        </div>
      </div>
    </div>
  );
}
