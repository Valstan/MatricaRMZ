import React, { useEffect, useMemo, useState } from 'react';

import { AssemblyReturnMode, ASSEMBLY_RETURN_MODE_LABELS } from '@matricarmz/shared';

import { Button } from './Button.js';
import { useConfirm } from './ConfirmContext.js';
import { Input } from './Input.js';
import { SearchSelect, SearchSelectOption } from './SearchSelect.js';
import { openPrintPreview, escapeHtml } from '../utils/printPreview.js';

type Line = {
  id: string;
  nomenclatureId: string;
  qty: number;
  mode: 'rework' | 'scrap';
};

type AssemblyRow = { nomenclatureId: string; name: string | null; code: string | null; qty: number };

function freshLine(): Line {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, nomenclatureId: '', qty: 1, mode: AssemblyReturnMode.Rework };
}

function toOption(id: string, name: string, code: string): SearchSelectOption {
  const label = name || code || id;
  const searchText = `${name} ${code}`.trim();
  return { id, label, ...(code ? { hintText: code } : {}), ...(searchText ? { searchText } : {}) };
}

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inputToMs(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const ms = new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function fmtRuDate(v: string): string {
  const ms = inputToMs(v);
  return ms ? new Date(ms).toLocaleDateString('ru-RU') : v;
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
  const [docDate, setDocDate] = useState<string>(todayInput());
  // Детали спецификации марки: приоритетный источник подсказок.
  const [brandOptions, setBrandOptions] = useState<SearchSelectOption[]>([]);
  const [brandQtyMap, setBrandQtyMap] = useState<Map<string, number>>(new Map());
  const [bomName, setBomName] = useState('');
  const [brandLoading, setBrandLoading] = useState(false);
  // Что сейчас числится «в сборке» по этому двигателю (нетто по номенклатуре).
  const [assemblyRows, setAssemblyRows] = useState<AssemblyRow[]>([]);
  const [assemblyLoading, setAssemblyLoading] = useState(false);
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
    setDocDate(todayInput());
    setStatus('');
    setShowAll(false);
    setBrandOptions([]);
    setBrandQtyMap(new Map());
    setBomName('');
    setAssemblyRows([]);
    if (props.engineBrandId) void loadBrandParts(props.engineBrandId);
    void loadAssemblyInProgress(props.engineId);
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

  async function loadAssemblyInProgress(engineId: string) {
    if (!engineId) return;
    setAssemblyLoading(true);
    try {
      const r = await window.matrica.workOrders.assemblyInProgress(engineId);
      if (r?.ok && Array.isArray(r.rows)) setAssemblyRows(r.rows as AssemblyRow[]);
      else setAssemblyRows([]);
    } finally {
      setAssemblyLoading(false);
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

  // Что сейчас в сборке по двигателю (нетто) — и как опции, и как карта остатков для проверки.
  const assemblyStock = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of assemblyRows) if (r.qty > 0) m.set(r.nomenclatureId, r.qty);
    return m;
  }, [assemblyRows]);

  const assemblyOptions = useMemo(
    () => assemblyRows.map((r) => toOption(r.nomenclatureId, r.name ?? '', r.code ?? '')),
    [assemblyRows],
  );

  const noBrandParts = brandOptions.length === 0 && !brandLoading;
  const usingAll = showAll || (noBrandParts && assemblyOptions.length === 0);

  useEffect(() => {
    if (props.open && usingAll) void ensureAllOptions();
  }, [props.open, usingAll]);

  const optionById = useMemo(() => {
    const m = new Map<string, SearchSelectOption>();
    for (const o of allOptions ?? []) m.set(o.id, o);
    for (const o of assemblyOptions) m.set(o.id, o);
    for (const o of brandOptions) m.set(o.id, o);
    return m;
  }, [allOptions, assemblyOptions, brandOptions]);

  const effectiveOptions = useMemo(() => {
    // База: либо вся номенклатура, либо детали марки + то, что реально в сборке по двигателю.
    let base: SearchSelectOption[];
    if (usingAll) {
      base = allOptions ?? [];
    } else {
      const byId = new Map<string, SearchSelectOption>();
      for (const o of brandOptions) byId.set(o.id, o);
      for (const o of assemblyOptions) byId.set(o.id, o);
      base = Array.from(byId.values());
    }
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
  }, [usingAll, allOptions, brandOptions, assemblyOptions, lines, optionById]);

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

  // Проверка A: нельзя вернуть больше, чем реально числится в сборке (когда остаток известен).
  const overLines = useMemo(() => {
    const bad = new Set<string>();
    for (const l of lines) {
      if (!l.nomenclatureId || l.qty <= 0) continue;
      const avail = assemblyStock.get(l.nomenclatureId);
      if (avail !== undefined && l.qty > avail) bad.add(l.id);
    }
    return bad;
  }, [lines, assemblyStock]);

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

  function fillFromAssembly() {
    if (assemblyRows.length === 0) {
      setStatus('В сборке по этому двигателю сейчас ничего не числится.');
      return;
    }
    setStatus('');
    setLines(
      assemblyRows.map((r) => ({
        id: `${r.nomenclatureId}-${Math.random().toString(36).slice(2, 8)}`,
        nomenclatureId: r.nomenclatureId,
        qty: r.qty,
        mode: AssemblyReturnMode.Rework,
      })),
    );
  }

  function printAct() {
    const ready = lines.filter((l) => l.nomenclatureId && l.qty > 0);
    if (ready.length === 0) {
      setStatus('Нечего печатать: заполните строки.');
      return;
    }
    const headRows: Array<[string, string]> = [
      ['Двигатель', props.engineLabel],
      ['Дата возврата', fmtRuDate(docDate)],
      ...(bomName ? ([['Спецификация марки', bomName]] as Array<[string, string]>) : []),
      ...(reason.trim() ? ([['Причина', reason.trim()]] as Array<[string, string]>) : []),
    ];
    const headHtml = `<table><tbody>${headRows
      .map(([k, v]) => `<tr><th style="width:220px">${escapeHtml(k)}</th><td>${escapeHtml(v || '—')}</td></tr>`)
      .join('')}</tbody></table>`;
    const bodyHtml = `<table><thead><tr><th>№</th><th>Деталь</th><th>Код</th><th>Кол-во</th><th>Назначение</th></tr></thead><tbody>${ready
      .map((l, i) => {
        const opt = optionById.get(l.nomenclatureId);
        const dest = l.mode === AssemblyReturnMode.Rework ? 'В ремонтный фонд (доработка)' : 'В утиль';
        return `<tr><td>${i + 1}</td><td>${escapeHtml(opt?.label ?? l.nomenclatureId)}</td><td>${escapeHtml(
          opt?.hintText ?? '',
        )}</td><td>${Math.trunc(l.qty)}</td><td>${escapeHtml(dest)}</td></tr>`;
      })
      .join('')}</tbody><tfoot><tr><td colspan="3" style="text-align:right"><b>Итого</b></td><td><b>${sums.total}</b></td><td>в ремфонд ${sums.rework} · в утиль ${sums.scrap}</td></tr></tfoot></table>`;
    const signHtml =
      '<table style="margin-top:24px;border:none"><tbody>' +
      '<tr><td style="border:none;padding-top:28px">Сдал (сборка): _______________ / _______________</td>' +
      '<td style="border:none;padding-top:28px">Принял (склад): _______________ / _______________</td></tr>' +
      '</tbody></table>';
    openPrintPreview({
      title: 'Акт возврата деталей из сборки',
      subtitle: `Двигатель: ${props.engineLabel} · ${fmtRuDate(docDate)}`,
      sections: [
        { id: 'head', title: 'Общие сведения', html: headHtml, hideTitle: true },
        { id: 'lines', title: 'Возвращаемые детали', html: bodyHtml },
        { id: 'sign', title: 'Подписи', html: signHtml, hideTitle: true },
      ],
    });
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
    if (overLines.size > 0) {
      setStatus('Есть строки, где кол-во больше, чем числится в сборке по этому двигателю. Исправьте количества.');
      return;
    }
    const docDateMs = inputToMs(docDate);
    const ok = await confirm({
      title: 'Провести возврат из сборки?',
      detail:
        `Двигатель: «${props.engineLabel}».\n` +
        `Дата: ${fmtRuDate(docDate)}. Позиций: ${ready.length}. В ремфонд: ${sums.rework} шт, в утиль: ${sums.scrap} шт (всего ${sums.total}).\n\n` +
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
        ...(docDateMs ? { docDate: docDateMs } : {}),
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

  const inputStyle: React.CSSProperties = {
    padding: '4px 6px',
    border: '1px solid var(--input-border)',
    borderRadius: 'var(--ui-radius-sm)',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    minHeight: 'var(--ui-input-height, 28px)',
    fontSize: 'var(--ui-input-font-size, 13px)',
  };

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
          maxWidth: 'min(96vw, 980px)',
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
            <span>У марки нет активной спецификации — предлагаются детали из сборки / все.</span>
          ) : null}
          {!usingAll && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Показывать все детали (не только марки)
            </label>
          )}
        </div>

        <div style={{ display: 'flex', gap: 14, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--subtle)' }}>
            Дата возврата:
            <input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 280 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)', flexShrink: 0 }}>Причина:</span>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: обнаружен брак при контрольной сборке"
              data-autogrow="off"
              style={{ flex: 1 }}
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <Button
            variant="ghost"
            onClick={fillFromAssembly}
            disabled={assemblyLoading || assemblyRows.length === 0}
            title="Подставить строки из того, что реально числится в сборке по этому двигателю"
          >
            {assemblyLoading ? 'Загрузка сборки…' : 'Заполнить из сборки'}
          </Button>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>
            {assemblyLoading
              ? ''
              : assemblyRows.length > 0
                ? `В сборке по двигателю: ${assemblyRows.length} поз. (${assemblyRows.reduce((a, r) => a + r.qty, 0)} шт)`
                : 'В сборке по этому двигателю ничего не числится.'}
          </span>
        </div>

        <table className="list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Деталь</th>
              <th style={{ width: 88, textAlign: 'right' }} title="Норма расхода на один двигатель по спецификации">Норма/двиг.</th>
              <th style={{ width: 92, textAlign: 'right' }} title="Сколько сейчас числится в сборке по этому двигателю">В сборке</th>
              <th style={{ width: 88 }}>Кол-во</th>
              <th style={{ width: 160 }}>Куда</th>
              <th style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const norm = brandQtyMap.get(line.nomenclatureId);
              const avail = assemblyStock.get(line.nomenclatureId);
              const isOver = overLines.has(line.id);
              return (
                <tr key={line.id}>
                  <td style={{ minWidth: 250 }}>
                    <SearchSelect
                      value={line.nomenclatureId || null}
                      options={effectiveOptions}
                      placeholder={
                        brandLoading || allLoading ? 'Загрузка…' : usingAll ? 'начните вводить деталь…' : 'деталь марки / из сборки…'
                      }
                      emptyQueryLimit={200}
                      onChange={(next) => patchLine(line.id, { nomenclatureId: next ?? '' })}
                    />
                    {isOver ? (
                      <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 2 }}>
                        в сборке числится только {avail} шт
                      </div>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--subtle)' }}>{norm ? norm : '—'}</td>
                  <td style={{ textAlign: 'right', color: avail !== undefined ? 'var(--text)' : 'var(--subtle)' }}>
                    {avail !== undefined ? avail : '—'}
                  </td>
                  <td>
                    <Input
                      type="number"
                      value={String(line.qty)}
                      onChange={(e) => patchLine(line.id, { qty: Math.max(0, Number(e.target.value) || 0) })}
                      data-autogrow="off"
                      style={{ width: 78, textAlign: 'right', ...(isOver ? { borderColor: 'var(--danger)' } : {}) }}
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
              <td colSpan={3} style={{ textAlign: 'right', padding: '8px', color: 'var(--subtle)' }}>
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

        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)', marginRight: 'auto' }}>
            Движения создаются с привязкой к двигателю, видны в отчёте «Журнал движений деталей».
          </span>
          <Button variant="ghost" onClick={printAct} title="Распечатать акт возврата для подписи">
            Печать акта
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || sums.total === 0 || overLines.size > 0}>
            {submitting ? 'Отправляю…' : 'Провести возврат'}
          </Button>
        </div>
      </div>
    </div>
  );
}
