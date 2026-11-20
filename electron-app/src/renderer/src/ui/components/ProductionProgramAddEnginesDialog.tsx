import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  buildProductionProgramPeriod,
  formatProductionProgramPeriod,
  parseContractSections,
  productionProgramContractLabel,
  productionProgramEngineHint,
  productionProgramRowFromEngine,
  looksLikeIdentifier,
  type EngineListItem,
  type ProductionProgramDto,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';

/**
 * Модалка «Добавить двигатели в производственную программу» (промты КАРМАНА #44 + #45).
 *
 * Открывается из списка двигателей по правой кнопке на пачке выделенных строк.
 * Показывает, в какую программу попадут двигатели, и КАКИЕ не попадут — отказ
 * виден оператору, а не теряется молча.
 *
 * Важно про запись: набор строк плана на сервере заменяется ЦЕЛИКОМ, а зеркало
 * программ публикуется раз в минуту. Поэтому строки перед добавлением читаются
 * С СЕРВЕРА (`productionProgram:get`) — по устаревшей реплике набор снял бы
 * строку, добавленную другим оператором.
 */

/** Вид договора — по разделам договора (то же, что на странице программы). */
type ContractKind = 'military' | 'civil';

type EngineRow = {
  engine: EngineListItem;
  label: string;
  /** Можно взять в план. */
  allowed: boolean;
  /** Почему нельзя (или чему подсказка домена). */
  reason: string;
  /** Подпись группы: организация и номер договора. */
  groupLabel: string;
  contractKind: ContractKind | null;
};

type ProgramChoice = {
  /** Пустая строка — новая программа (её надо создать). */
  id: string;
  title: string;
  shop: string;
  status: string;
  periodStart: number;
  periodEnd: number;
  isNew: boolean;
};

export type ProductionProgramAddEnginesResult = {
  added: number;
  skipped: Array<{ label: string; reason: string }>;
  programTitle: string;
};

function toInputDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromInputDate(value: string): number | null {
  const ms = value ? Date.parse(`${value}T12:00:00`) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

function engineLabel(engine: EngineListItem): string {
  return [engine.engineBrand, engine.engineNumber].filter(Boolean).join(' ').trim() || `Двигатель ${String(engine.id).slice(0, 8)}`;
}

export function ProductionProgramAddEnginesDialog(props: {
  open: boolean;
  /** Выбранные двигатели (из выделения в списке). */
  engines: EngineListItem[];
  onClose: () => void;
  onDone: (result: ProductionProgramAddEnginesResult) => void;
}) {
  const [programs, setPrograms] = useState<ProductionProgramDto[]>([]);
  const [choiceId, setChoiceId] = useState<string>('');
  const [periodStart, setPeriodStart] = useState<string>('');
  const [periodEnd, setPeriodEnd] = useState<string>('');
  const [rows, setRows] = useState<EngineRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  /**
   * Договор по id: вид (из его разделов) и номер (номер в карточке двигателя
   * может отсутствовать — тогда он берётся из строгой реплики, как на странице
   * программы). Кэш на одну загрузку: у пачки двигателей договоров несколько,
   * а запрос по каждому — дубль работы.
   */
  const contractInfoOf = useCallback(
    async (contractId: string, cache: Map<string, { kind: ContractKind | null; number: string }>) => {
      if (cache.has(contractId)) return cache.get(contractId)!;
      let kind: ContractKind | null = null;
      let number = '';
      try {
        const res = await window.matrica.contracts.contract.get(contractId);
        if (res.ok && res.row) {
          const parsed = parseContractSections({ contract_sections: res.row.sections_json });
          const k = parsed?.primary?.kind;
          kind = k === 'military' || k === 'civil' ? k : null;
          number = String(res.row.number ?? '').trim();
        }
      } catch {
        kind = null;
      }
      const info = { kind, number };
      cache.set(contractId, info);
      return info;
    },
    [],
  );

  // Загрузка: программы и разбор каждого двигателя (можно ли его взять).
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    setError('');
    setStatus('');
    void (async () => {
      const list = await window.matrica.productionProgram.list();
      if (!alive) return;
      const programRows: ProductionProgramDto[] = list.ok ? list.rows : [];
      setPrograms(programRows);

      // Карточки двигателей читаем ЗДЕСЬ, а не берём из списка на экране: список
      // может быть старее привязки к договору (зеркало едет до минуты), и тогда
      // двигатель был бы отказан напрасно — «нет договора» при договоре, который
      // в данных уже есть.
      let engines = props.engines;
      try {
        const fresh = await window.matrica.engines.list();
        if (fresh.length > 0) {
          const byId = new Map(fresh.map((e) => [String(e.id), e]));
          engines = props.engines.map((e) => byId.get(String(e.id)) ?? e);
        }
      } catch {
        // Реплика не прочиталась — берём те карточки, что пришли со списка.
      }
      if (!alive) return;

      // Вид и номер договора — по одному запросу на договор.
      const cache = new Map<string, { kind: ContractKind | null; number: string }>();
      const infos = new Map<string, { kind: ContractKind | null; number: string }>();
      for (const engine of engines) {
        const contractId = String(engine.contractId ?? '');
        if (!contractId || infos.has(contractId)) continue;
        infos.set(contractId, await contractInfoOf(contractId, cache));
      }

      const prepared: EngineRow[] = engines.map((engine) => {
        const hint = productionProgramEngineHint(engine);
        const contractId = String(engine.contractId ?? '');
        const info = infos.get(contractId);
        // Номер договора: из карточки двигателя, а если там пусто или служебный
        // идентификатор — из строгой реплики (как на странице программы).
        const rawNumber = String(engine.contractName ?? '').trim();
        const contractNumber =
          rawNumber && !looksLikeIdentifier(rawNumber) ? rawNumber : (info?.number ?? '');
        const groupLabel = productionProgramContractLabel({
          organization: engine.customerName ?? null,
          contractNumber,
        });
        const contractKind = info?.kind ?? null;
        if (!groupLabel) {
          return {
            engine,
            label: engineLabel(engine),
            allowed: false,
            reason: 'Нет договора — строка плана без него не имеет группы',
            groupLabel: '',
            contractKind,
          };
        }
        return {
          engine,
          label: engineLabel(engine),
          allowed: hint.tone !== 'block',
          reason: hint.text,
          groupLabel,
          contractKind,
        };
      });
      if (!alive) return;
      setRows(prepared);

      // Выбор по умолчанию: программа, в работе сейчас; иначе — самая свежая.
      const now = Date.now();
      const current =
        programRows.find((p) => Number(p.periodStart) <= now && Number(p.periodEnd) >= now) ??
        programRows[programRows.length - 1] ??
        null;
      if (current) {
        setChoiceId(current.id);
        setPeriodStart(toInputDate(Number(current.periodStart)));
        setPeriodEnd(toInputDate(Number(current.periodEnd)));
      } else {
        const period = buildProductionProgramPeriod('two_weeks', now);
        setChoiceId('');
        setPeriodStart(toInputDate(period.start));
        setPeriodEnd(toInputDate(period.end));
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.open, props.engines, contractInfoOf]);

  const choices = useMemo<ProgramChoice[]>(() => {
    const list: ProgramChoice[] = programs.map((p) => ({
      id: p.id,
      title: p.title,
      shop: p.shop,
      status: p.status,
      periodStart: Number(p.periodStart),
      periodEnd: Number(p.periodEnd),
      isNew: false,
    }));
    const now = Date.now();
    const period = buildProductionProgramPeriod('two_weeks', now);
    list.push({
      id: '',
      title: `Новая производственная программа (${formatProductionProgramPeriod({ start: period.start, end: period.end })})`,
      shop: 'Цех № 1',
      status: 'draft',
      periodStart: period.start,
      periodEnd: period.end,
      isNew: true,
    });
    return list;
  }, [programs]);

  const chosen = useMemo(() => choices.find((c) => c.id === choiceId) ?? choices[0] ?? null, [choices, choiceId]);

  const onChoice = (id: string) => {
    setChoiceId(id);
    const next = choices.find((c) => c.id === id);
    if (!next) return;
    setPeriodStart(toInputDate(next.periodStart));
    setPeriodEnd(toInputDate(next.periodEnd));
  };

  const allowedRows = rows.filter((r) => r.allowed);
  const skippedRows = rows.filter((r) => !r.allowed);

  /** Запись: строки плана читаются с сервера, дополняются и уходят одним набором. */
  const submit = async () => {
    if (!chosen) return;
    const start = fromInputDate(periodStart);
    const end = fromInputDate(periodEnd);
    if (start == null || end == null) {
      setError('Период программы задан неверно: нужны обе даты.');
      return;
    }
    if (allowedRows.length === 0) {
      setError('Ни один из выбранных двигателей нельзя взять в план — смотрите причины в списке.');
      return;
    }
    setBusy(true);
    setError('');
    setStatus('');
    try {
      let programId = chosen.id;
      let programTitle = chosen.title;
      if (chosen.isNew) {
        const created = await window.matrica.productionProgram.create({
          periodStart: start,
          periodEnd: end,
          shop: 'Цех № 1',
          title: `Производственная программа ${formatProductionProgramPeriod({ start, end })}`,
          status: 'draft',
          signatureSlots: null,
        });
        if (!created.ok) {
          setError(created.error);
          return;
        }
        programId = created.id;
        programTitle = `Производственная программа ${formatProductionProgramPeriod({ start, end })}`;
      } else if (start !== chosen.periodStart || end !== chosen.periodEnd) {
        // Период у оператора поменялся — сохраняем шапку программы.
        const updated = await window.matrica.productionProgram.update({
          id: programId,
          periodStart: start,
          periodEnd: end,
          shop: chosen.shop,
          title: chosen.title,
          status: chosen.status,
        });
        if (!updated.ok) {
          setError(updated.error);
          return;
        }
      }

      // Строки плана — С СЕРВЕРА: реплика отстаёт на минуту, а набор заменяется целиком.
      const fresh = await window.matrica.productionProgram.get(programId);
      if (!fresh.ok) {
        setError(fresh.error);
        return;
      }
      const existing = fresh.lines
        .slice()
        .sort((a, b) => Number(a.orderNo) - Number(b.orderNo));
      const already = new Set(existing.map((l) => String(l.engineId ?? '')).filter(Boolean));
      const added: typeof allowedRows = [];
      const skipped: Array<{ label: string; reason: string }> = [];
      for (const row of allowedRows) {
        if (already.has(String(row.engine.id))) {
          skipped.push({ label: row.label, reason: 'Уже есть в плане' });
          continue;
        }
        added.push(row);
      }
      const nextRows = [
        ...existing.map((l) => ({
          id: l.id,
          orderNo: 0,
          contractId: l.contractId,
          groupLabel: l.groupLabel,
          contractKind: l.contractKind,
          engineId: l.engineId,
          engineMark: l.engineMark,
          engineNumber: l.engineNumber,
          state: l.state,
          shippingPlanAt: l.shippingPlanAt,
          factors: l.factors,
          note: l.note,
        })),
        ...added.map((r) =>
          productionProgramRowFromEngine({
            id: crypto.randomUUID(),
            engine: r.engine,
            groupLabel: r.groupLabel,
            contractKind: r.contractKind,
          }),
        ),
      ].map((r, i) => ({ ...r, orderNo: i + 1 }));

      const saved = await window.matrica.productionProgram.saveRows({ id: programId, rows: nextRows });
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      props.onDone({
        added: added.length,
        skipped: [...skipped, ...skippedRows.map((r) => ({ label: r.label, reason: r.reason }))],
        programTitle,
      });
      props.onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!props.open) return null;

  return (
    <div
      role="dialog"
      aria-label="Добавить двигатели в производственную программу"
      data-production-program-add
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 10, padding: 16, width: 'min(760px, 96vw)', maxHeight: '90vh', overflow: 'auto', display: 'grid', gap: 12 }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>Добавить двигатели в производственную программу</div>

        <div style={{ display: 'grid', gap: 4 }}>
          <span className="ui-muted" style={{ fontSize: 12 }}>Программа</span>
          <div style={{ display: 'grid', gap: 6 }}>
            {choices.map((c) => (
              <label key={c.id || 'new'} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                <input
                  type="radio"
                  name="pp-program"
                  checked={choiceId === c.id}
                  disabled={busy}
                  data-pp-program-choice={c.id || 'new'}
                  onChange={() => onChoice(c.id)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  {c.title}
                  <span className="ui-muted"> · {formatProductionProgramPeriod({ start: c.periodStart, end: c.periodEnd })}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }}>Период с</span>
            <Input
              type="date"
              value={periodStart}
              disabled={busy}
              data-pp-period-start
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }}>Период по</span>
            <Input type="date" value={periodEnd} disabled={busy} data-pp-period-end onChange={(e) => setPeriodEnd(e.target.value)} />
          </label>
        </div>

        <div style={{ display: 'grid', gap: 4 }}>
          <span className="ui-muted" style={{ fontSize: 12 }}>
            Двигатели: {allowedRows.length} возьмём, {skippedRows.length} не берём
          </span>
          <div style={{ display: 'grid', gap: 4, maxHeight: 220, overflow: 'auto' }}>
            {rows.map((r) => (
              <div
                key={String(r.engine.id)}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'baseline',
                  fontSize: 13,
                  padding: '2px 4px',
                  borderRadius: 6,
                  background: r.allowed ? 'transparent' : 'rgba(220,38,38,0.08)',
                }}
              >
                <span style={{ fontWeight: 600 }}>{r.label}</span>
                <span className="ui-muted" style={{ fontSize: 12 }}>
                  {r.groupLabel || 'без договора'}
                </span>
                <span style={{ fontSize: 12, color: r.allowed ? 'var(--subtle)' : 'var(--danger)' }}>{r.reason}</span>
              </div>
            ))}
          </div>
        </div>

        {error ? <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div> : null}
        {status ? <div style={{ color: 'var(--subtle)', fontSize: 12 }}>{status}</div> : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => props.onClose()} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={busy || allowedRows.length === 0}>
            {busy ? 'Записываем…' : `Добавить в план (${allowedRows.length})`}
          </Button>
        </div>
      </div>
    </div>
  );
}
