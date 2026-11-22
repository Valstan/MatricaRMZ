import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  PRODUCTION_PROGRAM_NO_CONTRACT_NUMBER_NOTE,
  PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
  looksLikeIdentifier,
  parseContractSections,
  parseEngineBulkIntake,
  productionProgramContractLabel,
  productionProgramEngineHint,
  productionProgramEngineIndex,
  productionProgramEngineMatch,
  productionProgramEngineProblem,
  productionProgramRowFromEngine,
  type EngineListItem,
  type ProductionProgramLineDraftDto,
  type ProductionProgramLineDto,
} from '@matricarmz/shared';

import { Button } from './Button.js';

/**
 * Модалка «Добавить двигатели списком» в производственную программу
 * (промты КАРМАНА #64 + #65, ответы владельца #66 → D-246).
 *
 * Оператор вставляет номера списком, программа показывает по каждому номеру,
 * что с ним («нашёлся», «нет карточки», «нет договора», «нет контрагента», «нет
 * истории ремонта»), оператор ставит галочки и одной кнопкой внизу добавляет
 * выбранное.
 *
 * Куда попадает строка:
 *  · годный двигатель — в группу своего договора (общее доменное правило
 *    `productionProgramRowFromEngine`);
 *  · проблемный — в блок «Требует данных» ВНУТРИ программы: `contractId` пуст,
 *    причина в примечании. Когда карточку починят, строка сама уедет в группу
 *    своего договора (см. `productionProgramResolvePendingRows`).
 *
 * Запись идёт через страницу программы (одна дверь — `applyRows`): модалка
 * только считает и отдаёт строки, а страница мержит их с серверными строками
 * плана, чтобы не снести строку, добавленную другим оператором.
 */

/** Вид договора — по разделам договора (то же, что на странице программы). */
type ContractKind = 'military' | 'civil';

type ContractInfo = { kind: ContractKind | null; number: string };

/** Что будет с номером — три состояния. */
type RowKind = 'normal' | 'pending' | 'forbidden';

type ReportRow = {
  /** Номер как ввёл оператор (ключ строки отчёта). */
  number: string;
  /** Карточка, если нашлась. */
  engine: EngineListItem | null;
  kind: RowKind;
  /** Причина словами: почему такой исход. */
  reason: string;
  /** Подсказка домена о состоянии двигателя (если отличается от причины). */
  hint: string;
  /** Подпись группы (организация и номер договора) — для отчёта. */
  groupLabel: string;
  contractKind: ContractKind | null;
  /** Номер повторился в этом же списке. */
  repeated: boolean;
};

export type ProductionProgramAddByNumbersResult = {
  /** Строки, которые надо добавить в план. */
  rows: Array<ProductionProgramLineDraftDto & { id: string }>;
  /** Сколько строк добавлено. */
  added: number;
  /** Отказы: номер и причина. */
  skipped: Array<{ label: string; reason: string }>;
  /** Строки программы с сервера на момент чтения — страница мержит с ними правку. */
  serverRows: ProductionProgramLineDto[];
};

function engineLabel(engine: EngineListItem | null, number: string): string {
  if (!engine) return number;
  return [engine.engineBrand, engine.engineNumber].filter(Boolean).join(' ').trim() || number;
}

export function ProductionProgramAddEnginesByNumbersDialog(props: {
  open: boolean;
  /** Каталог двигателей — источник карточек по номеру. */
  engines: EngineListItem[];
  /**
   * Подпись группы (организация и номер договора) по карточке — ОДИН источник
   * правды со страницей программы.
   *
   * Свой снимок договора в модалке отставал от страницы (номер договора приходит
   * зеркалом позже карточки), и строка уходила на сервер с ПУСТОЙ шапкой группы —
   * сервер отвергал весь набор, а оператор видел «правка не сохранена». Отдельный
   * резолвер страницы снимает этот класс расхождения.
   */
  contractLabelOf?: (engine: EngineListItem) => string;
  /** Программа, в которую идёт добавление. */
  programId: string;
  programTitle: string;
  onClose: () => void;
  onDone: (result: ProductionProgramAddByNumbersResult) => void;
}) {
  const [text, setText] = useState('');
  /** Отметки оператора: null — «как предлагаем» (годные отмечены). */
  const [checkedOverride, setCheckedOverride] = useState<Record<string, boolean>>({});
  /** Резолвер подписи группы от страницы (см. пропс). */
  const contractLabelOf = props.contractLabelOf;
  const [engines, setEngines] = useState<EngineListItem[]>(props.engines);
  const [contractInfos, setContractInfos] = useState<Map<string, ContractInfo>>(new Map());
  const [serverRows, setServerRows] = useState<ProductionProgramLineDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  /** Вид и номер договора — по одному запросу на договор (кэш на одну загрузку). */
  const contractInfoOf = useCallback(async (contractId: string, cache: Map<string, ContractInfo>) => {
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
  }, []);

  // Загрузка: карточки двигателей почаще (реплика отстаёт), договоры и строки плана.
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    setError('');
    setStatus('');
    setCheckedOverride({});
    void (async () => {
      let list = props.engines;
      try {
        const fresh = await window.matrica.engines.list();
        if (alive && fresh.length > 0) {
          const byId = new Map(fresh.map((e) => [String(e.id), e]));
          list = props.engines.map((e) => byId.get(String(e.id)) ?? e);
        }
      } catch {
        // Реплика не прочиталась — берём те карточки, что пришли со страницы.
      }
      if (!alive) return;
      setEngines(list);

      const cache = new Map<string, ContractInfo>();
      const infos = new Map<string, ContractInfo>();
      for (const engine of list) {
        const contractId = String(engine.contractId ?? '');
        if (!contractId || infos.has(contractId)) continue;
        infos.set(contractId, await contractInfoOf(contractId, cache));
      }
      if (!alive) return;
      setContractInfos(infos);

      // Строки плана — с СЕРВЕРА: реплика отстаёт на минуту, а набор заменяется целиком.
      try {
        const program = await window.matrica.productionProgram.get(props.programId);
        if (alive && program.ok) setServerRows(program.lines ?? []);
      } catch {
        if (alive) setServerRows([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.open, props.engines, props.programId, contractInfoOf]);

  const index = useMemo(() => productionProgramEngineIndex(engines), [engines]);

  /** Отчёт по каждому номеру: нашёлся ли, что с ним и куда попадёт. */
  const report = useMemo<ReportRow[]>(() => {
    const parsed = parseEngineBulkIntake(text);
    const repeated = new Set(parsed.repeated.map((n) => n.toLowerCase()));
    const out: ReportRow[] = [];
    for (const number of parsed.numbers) {
      const match = productionProgramEngineMatch(index, number);
      const engine = match.engine;
      const hint = engine ? productionProgramEngineHint(engine) : null;
      if (match.ambiguous) {
        out.push({
          number,
          engine: null,
          kind: 'forbidden',
          reason: `Номер совпал с ${match.matches} карточками — выберите двигатель вручную`,
          hint: '',
          groupLabel: '',
          contractKind: null,
          repeated: repeated.has(number.toLowerCase()),
        });
        continue;
      }
      const problem = productionProgramEngineProblem(engine);
      const contractId = String(engine?.contractId ?? '');
      const info = contractInfos.get(contractId);
      const rawNumber = String(engine?.contractName ?? '').trim();
      const contractNumber = rawNumber && !looksLikeIdentifier(rawNumber) ? rawNumber : (info?.number ?? '');
      const ownLabel = engine
        ? productionProgramContractLabel({
            organization: engine.customerName ?? null,
            contractNumber,
          })
        : '';
      // Подпись группы — от страницы (она знает номер договора и по строгой
      // реплике, и по карточке); свой снимок модалки отставал.
      const groupLabel = engine ? (contractLabelOf?.(engine) ?? ownLabel) : '';
      const contractKind = info?.kind ?? null;
      let kind: RowKind = 'normal';
      let reason = problem.text;
      if (problem.forbidden) {
        kind = 'forbidden';
      } else if (problem.blocking) {
        kind = 'pending';
      } else if (!groupLabel) {
        // Договор есть, а шапку группы не из чего собрать (номер договора ещё не
        // доехал зеркалом) — строка ждёт в блоке и уедет сама, когда номер появится.
        kind = 'pending';
        reason = PRODUCTION_PROGRAM_NO_CONTRACT_NUMBER_NOTE;
      }
      out.push({
        number,
        engine,
        kind,
        reason,
        hint: hint && hint.text !== reason ? hint.text : '',
        groupLabel,
        contractKind,
        repeated: repeated.has(number.toLowerCase()),
      });
    }
    return out;
  }, [text, index, contractInfos, contractLabelOf]);

  const isChecked = (row: ReportRow): boolean => {
    const override = checkedOverride[row.number];
    if (typeof override === 'boolean') return override;
    return row.kind === 'normal';
  };

  const checkedRows = report.filter((row) => isChecked(row));

  /** Двигатель уже есть в плане? (по карточке и по номеру — номер может быть без карточки) */
  const alreadyInProgram = (row: ReportRow): boolean => {
    const engineId = String(row.engine?.id ?? '');
    if (engineId && serverRows.some((l) => String(l.engineId ?? '') === engineId)) return true;
    const number = String(row.engine?.engineNumber ?? row.number).trim().toLowerCase();
    return serverRows.some((l) => String(l.engineNumber ?? '').trim().toLowerCase() === number);
  };

  const submit = async () => {
    if (checkedRows.length === 0) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const rows: Array<ProductionProgramLineDraftDto & { id: string }> = [];
      const skipped: Array<{ label: string; reason: string }> = [];
      for (const row of checkedRows) {
        const label = engineLabel(row.engine, row.number);
        if (alreadyInProgram(row)) {
          skipped.push({ label, reason: 'Уже есть в плане' });
          continue;
        }
        if (row.kind === 'forbidden') {
          skipped.push({ label, reason: row.reason });
          continue;
        }
        if (row.kind === 'pending') {
          // Проблемная строка: живёт в блоке «Требует данных» и сама уедет в свой
          // договор, когда карточку починят. Причина едет в примечание — и в печать.
          rows.push({
            id: crypto.randomUUID(),
            orderNo: 0,
            contractId: null,
            groupLabel: PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
            contractKind: null,
            engineId: row.engine ? String(row.engine.id) : null,
            engineMark: String(row.engine?.engineBrand ?? ''),
            engineNumber: String(row.engine?.engineNumber ?? row.number),
            state: null,
            shippingPlanAt: null,
            factors: '',
            note: row.reason,
          });
          continue;
        }
        if (!row.engine) {
          skipped.push({ label, reason: row.reason });
          continue;
        }
        rows.push(
          productionProgramRowFromEngine({
            id: crypto.randomUUID(),
            engine: row.engine,
            groupLabel: row.groupLabel,
            contractKind: row.contractKind,
          }),
        );
      }
      if (rows.length === 0) {
        setError('Ни одну из отмеченных строк добавить нельзя — смотрите причины в списке.');
        return;
      }
      props.onDone({ rows, added: rows.length, skipped, serverRows });
      props.onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  if (!props.open) return null;

  const pendingCount = report.filter((r) => r.kind === 'pending').length;
  const normalCount = report.filter((r) => r.kind === 'normal').length;

  return (
    <div
      role="dialog"
      aria-label="Добавить двигатели списком в производственную программу"
      data-production-program-add-by-numbers
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          borderRadius: 10,
          padding: 16,
          width: 'min(860px, 96vw)',
          maxHeight: '90vh',
          overflow: 'auto',
          display: 'grid',
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>
          Добавить двигатели списком — {props.programTitle}
        </div>

        <label style={{ display: 'grid', gap: 4 }}>
          <span className="ui-muted" style={{ fontSize: 12 }}>
            Номера двигателей — вставьте список (пробел, запятая или с новой строки)
          </span>
          <textarea
            data-pp-add-by-numbers="true"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            rows={5}
            placeholder={'Например:\n41/26\n77, 88\n99'}
            style={{
              width: '100%',
              resize: 'vertical',
              padding: 8,
              borderRadius: 8,
              border: '1px solid var(--input-border, #cbd5e1)',
              background: 'var(--input-bg, #fff)',
              color: 'var(--text)',
            }}
          />
        </label>

        {report.length > 0 ? (
          <div style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }}>
              Найдено: {normalCount} · требуют данных: {pendingCount} · отмечено: {checkedRows.length}
            </span>
            <div
              data-pp-add-by-numbers-report
              style={{ display: 'grid', gap: 4, maxHeight: 260, overflow: 'auto' }}
            >
              {report.map((row) => (
                <div
                  key={row.number}
                  data-pp-add-by-numbers-row={row.number}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                    fontSize: 13,
                    padding: '2px 4px',
                    borderRadius: 6,
                    background:
                      row.kind === 'forbidden'
                        ? 'rgba(220,38,38,0.08)'
                        : row.kind === 'pending'
                          ? 'rgba(217,119,6,0.08)'
                          : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isChecked(row)}
                    disabled={busy || row.kind === 'forbidden'}
                    onChange={(e) =>
                      setCheckedOverride((prev) => ({ ...prev, [row.number]: e.target.checked }))
                    }
                    aria-label={`Добавить двигатель ${row.number}`}
                    style={{ cursor: row.kind === 'forbidden' ? 'not-allowed' : 'pointer' }}
                  />
                  <span style={{ fontWeight: 600 }}>{engineLabel(row.engine, row.number)}</span>
                  <span className="ui-muted" style={{ fontSize: 12 }}>
                    {row.groupLabel || 'без договора'}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: row.kind === 'forbidden' ? 'var(--danger)' : 'var(--subtle)',
                    }}
                  >
                    {row.reason}
                    {row.hint ? ` · ${row.hint}` : ''}
                    {row.repeated ? ' · номер повторился в списке' : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {pendingCount > 0 ? (
          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Двигатели без данных попадут в блок «{PRODUCTION_PROGRAM_PENDING_GROUP_LABEL}» — они сами уедут в свой
            договор, когда карточку починят (проверка при открытии программы и кнопкой «Перепроверить»).
          </div>
        ) : null}

        {error ? <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div> : null}
        {status ? <div style={{ color: 'var(--subtle)', fontSize: 12 }}>{status}</div> : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => props.onClose()} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={busy || checkedRows.length === 0}>
            {busy ? 'Добавляем…' : `Добавить в производственную программу (${checkedRows.length})`}
          </Button>
        </div>
      </div>
    </div>
  );
}
