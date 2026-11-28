import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
  parseContractSections,
  productionProgramAddByNumbersEngineLabel,
  productionProgramAddByNumbersReport,
  productionProgramAddByNumbersRows,
  productionProgramEngineIndex,
  type EngineListItem,
  type ProductionProgramAddByNumbersContractInfo,
  type ProductionProgramAddByNumbersReportRow,
  type ProductionProgramAddByNumbersResult,
  type ProductionProgramLineDto,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { takePreparedAdd, watchPreparedAdd } from '../services/agentPreparedAddService.js';

/**
 * Модалка «Добавить двигатели списком» в производственную программу
 * (промты КАРМАНА #64 + #65, ответы владельца #66 → D-246).
 *
 * Оператор вставляет номера списком, программа показывает по каждому номеру,
 * что с ним («нашёлся», «нет карточки», «нет договора», «нет контрагента», «нет
 * истории ремонта»), оператор ставит галочки и одной кнопкой внизу добавляет
 * выбранное.
 *
 * ПРАВИЛА ЖИВУТ В ДОМЕНЕ (`shared/src/domain/productionProgramAddByNumbers.ts`): разбор
 * номера, поиск карточки, отказ по неоднозначности, проверка дублей и сборка строк.
 * Модалка — экран: показывает отчёт и зовёт домен. Второй вызывающий (действие агента
 * по промту КАРМАНА #176) зовёт тот же домен, поэтому правило дублей не расходится
 * между «человеком» и «нейросетью».
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

/** Вид и номер договора — по одному запросу на договор (кэш на одну загрузку). */
type ContractInfo = ProductionProgramAddByNumbersContractInfo;

/** Что будет с номером — три состояния. */
type ReportRow = ProductionProgramAddByNumbersReportRow;

/** Итог модалки живёт в домене — оттуда его и берёт страница плана. */
export type { ProductionProgramAddByNumbersResult };

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
    let kind: ContractInfo['kind'] = null;
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
      // Готовый список от нейросети (промт КАРМАНА #176): номера подставляются в
      // поле, дальше оператор видит отчёт и добавляет — как сегодня.
      watchPreparedAdd();
      const prepared = await takePreparedAdd(props.programId);
      if (alive && prepared) {
        setText(prepared.text);
        setStatus('Список подготовила нейросеть — проверьте номера и добавьте.');
      }
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

  /** Отчёт по каждому номеру: нашёлся ли, что с ним и куда попадёт. Правило — в домене. */
  const report = useMemo<ReportRow[]>(
    () =>
      productionProgramAddByNumbersReport({
        text,
        index,
        contractInfos,
        ...(contractLabelOf ? { contractLabelOf } : {}),
      }),
    [text, index, contractInfos, contractLabelOf],
  );

  const isChecked = (row: ReportRow): boolean => {
    const override = checkedOverride[row.number];
    if (typeof override === 'boolean') return override;
    return row.kind === 'normal';
  };

  const checkedRows = report.filter((row) => isChecked(row));

  const submit = async () => {
    if (checkedRows.length === 0) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      // Сборка строк и проверка дублей — в домене: тот же путь, что у действия агента.
      const { rows, skipped } = productionProgramAddByNumbersRows({
        report: checkedRows,
        serverRows,
        makeId: () => crypto.randomUUID(),
      });
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
                  <span style={{ fontWeight: 600 }}>
                    {productionProgramAddByNumbersEngineLabel(row.engine, row.number)}
                  </span>
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
