import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  PRODUCTION_PROGRAM_PERIOD_LABELS,
  PRODUCTION_PROGRAM_STATES,
  PRODUCTION_PROGRAM_STATE_LABELS,
  buildProductionProgramPeriod,
  formatProductionProgramPeriod,
  looksLikeIdentifier,
  parseContractSections,
  productionProgramContractLabel,
  productionProgramEngineHint,
  productionProgramExecutionSummary,
  productionProgramOrganizationLabel,
  productionProgramPeriodKind,
  productionProgramRowExecution,
  suggestedProductionProgramStates,
  type EngineListItem,
  type ProductionProgramDto,
  type ProductionProgramExecutionSummary,
  type ProductionProgramLineDraftDto,
  type ProductionProgramLineDto,
  type ProductionProgramPeriodKind,
  type WorkOrderSignatureEmployee,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { SectionCard } from '../components/SectionCard.js';
import { UnifiedDateInput } from '../components/UnifiedDateInput.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { openProductionProgramPrint } from '../utils/productionProgramPrintHtml.js';

/**
 * Производственная программа (ПП) — страница модуля.
 *
 * План читается из локальной реплики (сервер ведёт, клиент только читает — план
 * доступен и без сети), а ведётся серверной дверью: кнопки «Сохранить» и «Новый
 * план» бьют в REST `/production-program`, а изменения приезжают обратно pull'ом.
 *
 * Экран — две части (владелец 10.11.2026):
 *  · слева — плашки производственных программ (название, период, цех, статус);
 *  · справа — настройка открытой программы: шапка (название → цех → период →
 *    статус), добор двигателей по договору и строки плана, сгруппированные по
 *    договорам.
 *
 * Что показывает экран:
 *  · шапку: название, цех, период (вид + две даты), статус (черновик/утверждён);
 *  · строки плана: организация и договор, двигатель, состояние, плановая
 *    отгрузка, факторы, примечание;
 *  · добор двигателей по договору с подсказкой по состоянию («на заводе — можно
 *    брать», «ещё не приехал», «уже отгружен», «утиль»).
 *
 * Данные двигателя (заказчик, договор, номер) берутся из карточки ЖИВЫМИ: план
 * не живёт отдельной жизнью — правка карточки видна в плане сразу.
 */

type Props = {
  /** Каталог двигателей — источник подсказок и данных для печати. */
  engines: EngineListItem[];
  /** Право вести план (`production_program.edit`). */
  canEdit: boolean;
};

type DraftRow = ProductionProgramLineDraftDto & { id: string };

/** Строка плана на экране: снимок строки + живые данные карточки двигателя. */
type ScreenRow = {
  row: DraftRow;
  engine: EngineListItem | null;
  /** Живая подпись «Организация»: заказчик + три цифры номера договора. */
  organization: string;
};

/** Статус программы: подпись и цвет плашки. */
const PROGRAM_STATUS_LABELS: Record<string, string> = {
  draft: 'Черновик',
  approved: 'Утверждён',
};

/**
 * Цвета статуса (владелец 10.11.2026: «подбери сам»).
 * Черновик — бледный серый (не спорит с зелёным утверждения), утверждён — зелёный.
 */
const PROGRAM_STATUS_TONES: Record<string, { bg: string; border: string; text: string }> = {
  draft: { bg: '#f1f5f9', border: '#cbd5e1', text: '#475569' },
  approved: { bg: '#dcfce7', border: '#86efac', text: '#166534' },
};

function isoDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIsoDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const ts = new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : null;
}

export function ProductionProgramPage(props: Props) {
  const [programs, setPrograms] = useState<ProductionProgramDto[]>([]);
  const [lines, setLines] = useState<ProductionProgramLineDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [pickerContract, setPickerContract] = useState<string>('');
  const [pickerEngine, setPickerEngine] = useState<string>('');
  // Вид периода: null — показываем вид, выведенный из самих дат.
  const [periodKindOverride, setPeriodKindOverride] = useState<ProductionProgramPeriodKind | null>(null);
  // Номер договора, подтянутый из строгой реплики: в строке двигателя его может не
  // быть (контракт создан мимо EAV), а подпись должна оставаться человеческой.
  const [resolvedContractNumbers, setResolvedContractNumbers] = useState<Record<string, string>>({});
  // Сотрудники — для подписей ПП: если по должности нашёлся сотрудник, печатаем ФИО из
  // его карточки; если нет — ФИО из документа-образца (вносить подписантов в кадровый
  // реестр нельзя: это засоряет реестр и попадает под гейт дублей).
  const [employees, setEmployees] = useState<WorkOrderSignatureEmployee[]>([]);

  const reload = useCallback(async () => {
    const res = await window.matrica.productionProgram.list();
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError('');
    setPrograms(res.rows);
    setLines(res.lines);
    setSelectedId((prev) => prev ?? (res.rows[0]?.id ?? null));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // План ведёт сервер, клиент читает реплику: только что созданный план приедет
  // публикацией зеркала и pull'ом — страница перечитывает список по этому событию.
  useLiveDataRefresh(
    async () => {
      await reload();
    },
    { domains: ['productionProgram'] },
  );

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.matrica.employees.list();
        setEmployees(Array.isArray(list) ? (list as WorkOrderSignatureEmployee[]) : []);
      } catch {
        setEmployees([]);
      }
    })();
  }, []);

  // Номер договора подтягиваем из строгой реплики там, где в строке двигателя его нет
  // (контракт создан мимо EAV). Без этого подпись группы стала бы пустой или технической.
  useEffect(() => {
    const missing = new Set<string>();
    for (const e of props.engines) {
      const id = String(e.contractId ?? '');
      if (!id) continue;
      const number = String(e.contractName ?? '').trim();
      if (!number || looksLikeIdentifier(number)) missing.add(id);
    }
    if (missing.size === 0) return;
    let alive = true;
    void (async () => {
      for (const id of missing) {
        try {
          const res = await window.matrica.contracts.contract.get(id);
          const number = res.ok && res.row ? String(res.row.number ?? '').trim() : '';
          if (!alive) return;
          if (number && !looksLikeIdentifier(number)) {
            setResolvedContractNumbers((prev) => (prev[id] === number ? prev : { ...prev, [id]: number }));
          }
        } catch {
          // Договора нет в реплике — подпись останется без номера, но без идентификатора.
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.engines]);

  const selected = useMemo(() => programs.find((p) => p.id === selectedId) ?? null, [programs, selectedId]);

  // Строки выбранного плана — локальная копия для правки; сохранение уходит на сервер.
  useEffect(() => {
    if (!selectedId) {
      setRows([]);
      return;
    }
    setRows(
      lines
        .filter((l) => l.programId === selectedId)
        .map((l) => ({
          id: l.id,
          orderNo: l.orderNo,
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
    );
  }, [lines, selectedId]);

  const engineById = useMemo(() => new Map(props.engines.map((e) => [String(e.id), e])), [props.engines]);

  /** Номер договора по его id: из карточки двигателя, иначе — из строгой реплики. */
  const contractNumberById = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of props.engines) {
      const id = String(e.contractId ?? '');
      if (!id) continue;
      const number = String(e.contractName ?? '').trim();
      if (number && !looksLikeIdentifier(number) && !map.has(id)) map.set(id, number);
    }
    for (const [id, number] of Object.entries(resolvedContractNumbers)) map.set(id, number);
    return map;
  }, [props.engines, resolvedContractNumbers]);

  /** Живой номер договора для конкретного двигателя (с подстановкой из реплики). */
  const contractNumberOf = useCallback(
    (engine: EngineListItem | null | undefined): string => {
      if (!engine) return '';
      const raw = String(engine.contractName ?? '').trim();
      if (raw && !looksLikeIdentifier(raw)) return raw;
      const id = String(engine.contractId ?? '').trim();
      return id ? String(contractNumberById.get(id) ?? '') : '';
    },
    [contractNumberById],
  );

  /** Договоры для выпадашки: подпись — заказчик и номер (поиск идёт по обоим). */
  const contracts = useMemo(() => {
    const organizationById = new Map<string, string>();
    for (const e of props.engines) {
      const id = String(e.contractId ?? '');
      if (!id) continue;
      if (!organizationById.has(id)) organizationById.set(id, String(e.customerName ?? '').trim());
    }
    return [...organizationById.keys()].map((id) => ({
      id,
      label:
        productionProgramContractLabel({
          organization: organizationById.get(id),
          contractNumber: contractNumberById.get(id),
        }) || 'Договор без номера',
    }));
  }, [props.engines, contractNumberById]);

  const contractOptions = useMemo(() => contracts.map((c) => ({ id: c.id, label: c.label })), [contracts]);

  /**
   * Двигатели для выпадашки: все, если договор не выбран, иначе — его двигатели.
   * Выбор двигателя подтягивает договор из карточки (поиски взаимозаменяемы).
   */
  const engineOptions = useMemo(() => {
    const list = pickerContract ? props.engines.filter((e) => String(e.contractId ?? '') === pickerContract) : props.engines;
    return list.map((e) => ({
      id: String(e.id),
      label: [e.engineBrand, e.engineNumber].filter(Boolean).join(' ') || String(e.id),
    }));
  }, [props.engines, pickerContract]);

  /** Живая подпись договора (шапка группы): заказчик и полный номер. */
  const contractLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contracts) map.set(c.id, c.label);
    return map;
  }, [contracts]);

  /** Строки плана, сгруппированные по договору (владелец 10.11.2026). */
  const groups = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; items: ScreenRow[] }>();
    for (const row of rows) {
      const engine = engineById.get(String(row.engineId ?? '')) ?? null;
      const contractId = String(row.contractId ?? '');
      const organization =
        productionProgramOrganizationLabel({
          customerName: engine?.customerName ?? null,
          contractNumber: contractNumberOf(engine),
        }) || String(row.groupLabel ?? '');
      const label = contractLabelById.get(contractId) || String(row.groupLabel ?? '') || 'Без договора';
      const key = contractId || `без-договора:${label}`;
      let group = byKey.get(key);
      if (!group) {
        group = { key, label, items: [] };
        byKey.set(key, group);
      }
      group.items.push({ row, engine, organization });
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [rows, engineById, contractLabelById, contractNumberOf]);

  /**
   * Сводка выполнения по каждой программе — то, что показывается на плашке
   * («сколько двигателей ещё не собраны, невыполнены, сколько выполнено»).
   *
   * Считается по ЖИВОЙ карточке двигателя: ОТК пройден — «готов к отгрузке»,
   * отгружен — «выполнено»; срок — плановая отгрузка строки.
   */
  const summaryByProgram = useMemo(() => {
    const map = new Map<string, ProductionProgramExecutionSummary>();
    for (const p of programs) {
      map.set(
        p.id,
        productionProgramExecutionSummary({
          rows: lines.filter((l) => l.programId === p.id),
          engines: props.engines,
        }),
      );
    }
    return map;
  }, [programs, lines, props.engines]);

  const setHeader = (patch: Partial<ProductionProgramDto>) => {
    setPrograms((prev) => prev.map((p) => (p.id === selectedId ? { ...p, ...patch } : p)));
  };

  /** Смена программы: вид периода — по её датам. */
  const selectProgram = (id: string) => {
    setSelectedId(id);
    setPeriodKindOverride(null);
    setPickerContract('');
    setPickerEngine('');
  };

  const inferredPeriodKind = useMemo<ProductionProgramPeriodKind>(
    () => (selected ? productionProgramPeriodKind({ start: selected.periodStart, end: selected.periodEnd }) : 'two_weeks'),
    [selected],
  );
  const periodKind = periodKindOverride ?? inferredPeriodKind;

  /** Смена вида периода — сразу пересчитываем даты (вид = «две недели/месяц/свои»). */
  const applyPeriodKind = (kind: ProductionProgramPeriodKind) => {
    setPeriodKindOverride(kind);
    if (!selected) return;
    const base = selected.periodStart || Date.now();
    const period = buildProductionProgramPeriod(kind, base, { start: selected.periodStart, end: selected.periodEnd });
    setHeader({ periodStart: period.start, periodEnd: period.end });
  };

  /** Правка одной даты периода: вид дальше выводится из дат. */
  const applyPeriodDate = (which: 'start' | 'end', value: string) => {
    if (!selected) return;
    const next = parseIsoDate(value);
    if (next == null) return;
    const start = which === 'start' ? next : selected.periodStart;
    const end = which === 'end' ? next : selected.periodEnd;
    setPeriodKindOverride(null);
    setHeader({ periodStart: Math.min(start, end), periodEnd: Math.max(start, end) });
  };

  async function createProgram() {
    setBusy(true);
    setError('');
    try {
      const now = Date.now();
      const periodStart = new Date(now);
      periodStart.setHours(12, 0, 0, 0);
      const periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 13);
      const res = await window.matrica.productionProgram.create({
        periodStart: periodStart.getTime(),
        periodEnd: periodEnd.getTime(),
        shop: 'Цех № 1',
        title: `Производственная программа ${formatProductionProgramPeriod({ start: periodStart.getTime(), end: periodEnd.getTime() })}`,
        status: 'draft',
        signatureSlots: null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStatus('План создан');
      await reload();
      setSelectedId(res.id);
      setPeriodKindOverride(null);
    } finally {
      setBusy(false);
    }
  }

  async function saveProgram() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const res = await window.matrica.productionProgram.update({
        id: selected.id,
        periodStart: selected.periodStart,
        periodEnd: selected.periodEnd,
        shop: selected.shop,
        title: selected.title,
        status: selected.status,
        signatureSlots: selected.signatureSlots,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const rowsRes = await window.matrica.productionProgram.saveRows({
        id: selected.id,
        rows: rows.map((r, i) => ({
          id: r.id,
          orderNo: i + 1,
          contractId: r.contractId ?? null,
          groupLabel: r.groupLabel,
          contractKind: r.contractKind ?? null,
          engineId: r.engineId ?? null,
          engineMark: r.engineMark ?? '',
          engineNumber: r.engineNumber ?? '',
          state: r.state ?? null,
          shippingPlanAt: r.shippingPlanAt ?? null,
          factors: r.factors ?? '',
          note: r.note ?? '',
        })),
      });
      if (!rowsRes.ok) {
        setError(rowsRes.error);
        return;
      }
      setStatus('Сохранено. План приедет на этот компьютер при следующей синхронизации.');
    } finally {
      setBusy(false);
    }
  }

  async function removeProgram() {
    if (!selected) return;
    const programId = selected.id;
    setBusy(true);
    try {
      const res = await window.matrica.productionProgram.remove(programId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Убираем программу из списка сразу: снятие приходит на клиент с задержкой
      // (публикатор зеркала + pull), а до неё программа ещё жила в реплике — и
      // повторный клик «Удалить» отвечал «программа не найдена».
      setPrograms((prev) => prev.filter((p) => p.id !== programId));
      setLines((prev) => prev.filter((l) => l.programId !== programId));
      setSelectedId((prev) => (prev === programId ? null : prev));
      setStatus('Программа снята. Правка дойдёт до остальных компьютеров при синхронизации.');
    } finally {
      setBusy(false);
    }
  }

  /** Вид договора (военный/гражданский) — из его секций; нужен для подсказки состояния. */
  async function contractKindOf(contractId: string): Promise<'military' | 'civil' | null> {
    try {
      const res = await window.matrica.contracts.contract.get(contractId);
      if (!res.ok || !res.row) return null;
      // Секции договора в строгой реплике лежат JSON-строкой (`sections_json`),
      // а домен ждёт объект секций — разбираем строку и отдаём домену то, что он понимает.
      const raw = res.row.sections_json;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      const sections = parseContractSections({ contract_sections: parsed });
      return sections?.primary?.kind ?? null;
    } catch {
      return null;
    }
  }

  async function addEngine() {
    if (!pickerEngine) return;
    const engine = engineById.get(pickerEngine);
    if (!engine) return;
    const contractId = String(engine.contractId ?? '');
    const kind = contractId ? await contractKindOf(contractId) : null;
    const suggested = suggestedProductionProgramStates(kind);
    // Шапка группы — человеческое наименование договора (организация и номер).
    // Идентификатор в неё не идёт: в отчёте это «номер вместо наименования».
    // Наименования нет — строку не берём: без группы строки план не складывается.
    const groupLabel = contractLabelById.get(contractId) ?? '';
    if (!groupLabel || groupLabel === 'Договор без номера') {
      setError(
        'У двигателя нет наименования договора — строка плана без него не имеет группы. Заведите договор (наименование и номер) и повторите.',
      );
      return;
    }
    setRows((prev) => [
      ...prev,
      {
        // Постоянный id строки: пока id был черновым («draft-…»), сервер на каждое
        // сохранение заводил новый uuid и снимал старый — журнал увозил пару
        // «удалить + вставить», и двигатель на время ПРОПАДАЛ из плана.
        id: crypto.randomUUID(),
        orderNo: prev.length + 1,
        contractId: contractId || null,
        groupLabel,
        contractKind: kind,
        engineId: String(engine.id),
        engineMark: String(engine.engineBrand ?? ''),
        engineNumber: String(engine.engineNumber ?? ''),
        state: suggested[0] ?? null,
        shippingPlanAt: null,
        factors: '',
        note: '',
      },
    ]);
    setPickerEngine('');
  }

  function printProgram() {
    if (!selected) return;
    const ok = openProductionProgramPrint({
      title: selected.title,
      shop: selected.shop,
      period: { start: selected.periodStart, end: selected.periodEnd },
      rows: rows.map((r) => ({
        id: r.id,
        contractId: r.contractId ?? null,
        groupLabel: r.groupLabel,
        contractKind: r.contractKind ?? null,
        engineId: r.engineId ?? null,
        engineMark: r.engineMark ?? '',
        engineNumber: r.engineNumber ?? '',
        state: r.state ?? null,
        shippingPlanAt: r.shippingPlanAt ?? null,
        factors: r.factors ?? '',
        note: r.note ?? '',
      })),
      engines: props.engines,
      employees,
    });
    if (!ok) setError('Окно печати не открылось');
  }

  const hint = pickerEngine ? productionProgramEngineHint(engineById.get(pickerEngine) ?? null) : null;

  const fieldLabel = (label: string, control: React.ReactNode) => (
    <label style={{ display: 'grid', gap: 4, fontSize: 12, minWidth: 0 }}>
      <span style={{ color: 'var(--subtle)' }}>{label}</span>
      {control}
    </label>
  );

  return (
    <div
      className="production-program-page"
      style={{
        display: 'grid',
        gap: 12,
        gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)',
        width: '100%',
        minWidth: 0,
        alignItems: 'start',
      }}
    >
      {/* ЛЕВАЯ ЧАСТЬ — плашки производственных программ */}
      <SectionCard
        title="Производственные программы"
        actions={
          props.canEdit ? (
            <Button onClick={() => void createProgram()} disabled={busy}>
              Новый план
            </Button>
          ) : null
        }
      >
        <div style={{ display: 'grid', gap: 8 }}>
          {programs.length === 0 ? (
            <div className="ui-muted" style={{ fontSize: 12 }}>
              Планов пока нет
            </div>
          ) : null}
          {programs.map((p) => {
            const tone = PROGRAM_STATUS_TONES[p.status] ?? PROGRAM_STATUS_TONES.draft!;
            const count = lines.filter((l) => l.programId === p.id).length;
            const active = p.id === selectedId;
            const summary = summaryByProgram.get(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectProgram(p.id)}
                style={{
                  textAlign: 'left',
                  display: 'grid',
                  gap: 4,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: `1px solid ${active ? tone.border : 'var(--border)'}`,
                  background: active ? tone.bg : 'transparent',
                  cursor: 'pointer',
                  minWidth: 0,
                }}
              >
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</div>
                <div className="ui-muted" style={{ fontSize: 12 }}>
                  {formatProductionProgramPeriod({ start: p.periodStart, end: p.periodEnd })}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 999,
                      border: `1px solid ${tone.border}`,
                      background: tone.bg,
                      color: tone.text,
                    }}
                  >
                    {PROGRAM_STATUS_LABELS[p.status] ?? p.status}
                  </span>
                  <span className="ui-muted" style={{ fontSize: 12 }}>
                    {p.shop} · {count} двиг.
                  </span>
                </div>
                {/* Выполнение плана — по живой карточке двигателя (владелец 10.11.2026):
                    сколько собрано, сколько в срок, сколько выпало из сроков. */}
                {summary && summary.total > 0 ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
                    <span style={{ color: '#166534' }}>Собрано {summary.done} из {summary.total}</span>
                    <span className="ui-muted">В срок {summary.onTime}</span>
                    {summary.overdue > 0 ? (
                      <span style={{ color: 'var(--danger)' }}>Просрочено {summary.overdue}</span>
                    ) : null}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </SectionCard>

      {/* ПРАВАЯ ЧАСТЬ — настройка открытой программы */}
      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        {error ? (
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>
        ) : null}
        {status ? (
          <div style={{ color: 'var(--subtle)', fontSize: 12 }}>{status}</div>
        ) : null}
        {!selected ? (
          <SectionCard title="Программа">
            <div className="ui-muted">Выберите программу слева или создайте новую.</div>
          </SectionCard>
        ) : (
          <>
            <SectionCard
              title="Программа"
              actions={
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button onClick={() => void saveProgram()} disabled={busy || !props.canEdit}>
                    Сохранить
                  </Button>
                  <Button onClick={printProgram}>Печать</Button>
                  {props.canEdit ? (
                    <Button onClick={() => void removeProgram()} disabled={busy}>
                      Удалить
                    </Button>
                  ) : null}
                </div>
              }
            >
              <div
                style={{
                  display: 'grid',
                  gap: 10,
                  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                  alignItems: 'end',
                }}
              >
                {fieldLabel(
                  'Название программы',
                  <input
                    value={selected.title}
                    disabled={!props.canEdit}
                    onChange={(e) => setHeader({ title: e.target.value })}
                    style={{ padding: '4px 6px', width: '100%' }}
                  />,
                )}
                {fieldLabel(
                  'Цех',
                  <input
                    value={selected.shop}
                    disabled={!props.canEdit}
                    onChange={(e) => setHeader({ shop: e.target.value })}
                    style={{ padding: '4px 6px', width: '100%' }}
                  />,
                )}
                {fieldLabel(
                  'Период',
                  <select
                    value={periodKind}
                    disabled={!props.canEdit}
                    onChange={(e) => applyPeriodKind(e.target.value as ProductionProgramPeriodKind)}
                    style={{ padding: '4px 6px', width: '100%' }}
                  >
                    {(['two_weeks', 'month', 'custom'] as ProductionProgramPeriodKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {PRODUCTION_PROGRAM_PERIOD_LABELS[kind]}
                      </option>
                    ))}
                  </select>,
                )}
                {fieldLabel(
                  'Период с',
                  <UnifiedDateInput
                    type="date"
                    value={isoDate(selected.periodStart)}
                    disabled={!props.canEdit}
                    onChange={(e) => applyPeriodDate('start', String(e.target.value ?? ''))}
                  />,
                )}
                {fieldLabel(
                  'Период по',
                  <UnifiedDateInput
                    type="date"
                    value={isoDate(selected.periodEnd)}
                    disabled={!props.canEdit}
                    onChange={(e) => applyPeriodDate('end', String(e.target.value ?? ''))}
                  />,
                )}
                {fieldLabel(
                  'Статус программы',
                  <select
                    value={selected.status}
                    disabled={!props.canEdit}
                    onChange={(e) => setHeader({ status: e.target.value })}
                    style={{ padding: '4px 6px', width: '100%' }}
                  >
                    <option value="draft">Черновик</option>
                    <option value="approved">Утверждён</option>
                  </select>,
                )}
              </div>

              {props.canEdit ? (
                <div
                  style={{
                    display: 'grid',
                    gap: 8,
                    gridTemplateColumns: 'minmax(220px, 1fr) minmax(240px, 1fr) auto',
                    alignItems: 'end',
                    marginTop: 12,
                  }}
                >
                  {fieldLabel(
                    'Договор',
                    <SearchSelect
                      value={pickerContract || null}
                      options={contractOptions}
                      placeholder="— выберите договор —"
                      emptyQueryLimit={40}
                      onChange={(next) => {
                        setPickerContract(next ?? '');
                        // Договор сменился — выбранный двигатель может быть чужим.
                        setPickerEngine('');
                      }}
                    />,
                  )}
                  {fieldLabel(
                    'Двигатель',
                    <SearchSelect
                      value={pickerEngine || null}
                      options={engineOptions}
                      placeholder="— найдите двигатель по номеру —"
                      emptyQueryLimit={40}
                      onChange={(next) => {
                        setPickerEngine(next ?? '');
                        // Поиски взаимозаменяемы: двигатель подтягивает свой договор.
                        const engine = next ? engineById.get(next) : null;
                        const contractId = String(engine?.contractId ?? '');
                        if (contractId) setPickerContract(contractId);
                      }}
                    />,
                  )}
                  <Button onClick={() => void addEngine()} disabled={!pickerEngine}>
                    Добавить в план
                  </Button>
                  {hint ? (
                    <div style={{ fontSize: 12, color: 'var(--subtle)', gridColumn: '1 / -1' }}>{hint.text}</div>
                  ) : null}
                </div>
              ) : null}
            </SectionCard>

            <SectionCard title="Строки плана">
              <div style={{ overflowX: 'auto' }}>
                <table className="list-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>№ п/п</th>
                      <th>Организация, договор</th>
                      <th>Двигатель</th>
                      <th>Выполнение</th>
                      <th>Состояние</th>
                      <th>Отгрузка</th>
                      <th>Факторы</th>
                      <th>Примечание</th>
                      {props.canEdit ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.length === 0 ? (
                      <tr>
                        <td colSpan={props.canEdit ? 9 : 8} className="ui-muted">
                          Строк в плане нет
                        </td>
                      </tr>
                    ) : null}
                    {groups.map((group) => (
                      <React.Fragment key={group.key}>
                        <tr style={{ background: '#f3f4f6' }}>
                          <td
                            colSpan={props.canEdit ? 9 : 8}
                            style={{ fontWeight: 700, padding: '4px 6px', whiteSpace: 'normal' }}
                          >
                            {group.label}
                          </td>
                        </tr>
                        {group.items.map((item, i) => {
                          const r = item.row;
                          const engine = item.engine;
                          // Выполнение — по живой карточке: ОТК пройден → готов к
                          // отгрузке, отгружен → выполнено, срок — плановая отгрузка.
                          const execution = productionProgramRowExecution({
                            engine,
                            shippingPlanAt: r.shippingPlanAt ?? null,
                          });
                          return (
                            <tr key={r.id}>
                              <td>{i + 1}</td>
                              <td title={item.organization}>{item.organization || '—'}</td>
                              <td>
                                {[engine?.engineBrand ?? r.engineMark, engine?.engineNumber ?? r.engineNumber]
                                  .filter(Boolean)
                                  .join(' ')}
                              </td>
                              <td>
                                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                  <span
                                    style={{
                                      fontSize: 12,
                                      color:
                                        execution.state === 'ready' || execution.state === 'shipped'
                                          ? '#166534'
                                          : execution.state === 'inWork'
                                            ? '#1d4ed8'
                                            : 'var(--subtle)',
                                    }}
                                  >
                                    {execution.stateLabel}
                                  </span>
                                  {execution.overdue ? (
                                    <span style={{ fontSize: 11, color: 'var(--danger)' }}>просрочен</span>
                                  ) : null}
                                </div>
                              </td>
                              <td>
                                <select
                                  value={r.state ?? ''}
                                  disabled={!props.canEdit}
                                  onChange={(e) =>
                                    setRows((prev) =>
                                      prev.map((x) => (x.id === r.id ? { ...x, state: e.target.value || null } : x)),
                                    )
                                  }
                                  style={{ padding: '2px 4px' }}
                                >
                                  <option value="">—</option>
                                  {PRODUCTION_PROGRAM_STATES.map((s) => (
                                    <option key={s} value={s}>
                                      {PRODUCTION_PROGRAM_STATE_LABELS[s]}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <UnifiedDateInput
                                  type="date"
                                  value={isoDate(r.shippingPlanAt)}
                                  disabled={!props.canEdit}
                                  onChange={(e) => {
                                    const next = parseIsoDate(String(e.target.value ?? ''));
                                    setRows((prev) =>
                                      prev.map((x) => (x.id === r.id ? { ...x, shippingPlanAt: next } : x)),
                                    );
                                  }}
                                />
                              </td>
                              <td>
                                <input
                                  value={r.factors ?? ''}
                                  disabled={!props.canEdit}
                                  onChange={(e) =>
                                    setRows((prev) =>
                                      prev.map((x) => (x.id === r.id ? { ...x, factors: e.target.value } : x)),
                                    )
                                  }
                                  style={{ padding: '2px 4px', width: 180 }}
                                />
                              </td>
                              <td>
                                <input
                                  value={r.note ?? ''}
                                  disabled={!props.canEdit}
                                  onChange={(e) =>
                                    setRows((prev) =>
                                      prev.map((x) => (x.id === r.id ? { ...x, note: e.target.value } : x)),
                                    )
                                  }
                                  style={{ padding: '2px 4px', width: 160 }}
                                />
                              </td>
                              {props.canEdit ? (
                                <td>
                                  <button
                                    type="button"
                                    onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}
                                    title="Убрать строку из плана"
                                    style={{
                                      border: 'none',
                                      background: 'transparent',
                                      color: 'var(--danger)',
                                      cursor: 'pointer',
                                    }}
                                  >
                                    ✕
                                  </button>
                                </td>
                              ) : null}
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          </>
        )}
      </div>
    </div>
  );
}
