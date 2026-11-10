import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  PRODUCTION_PROGRAM_STATES,
  PRODUCTION_PROGRAM_STATE_LABELS,
  formatProductionProgramPeriod,
  looksLikeIdentifier,
  parseContractSections,
  productionProgramContractLabel,
  productionProgramEngineHint,
  suggestedProductionProgramStates,
  type EngineListItem,
  type ProductionProgramDto,
  type ProductionProgramLineDraftDto,
  type ProductionProgramLineDto,
  type WorkOrderSignatureEmployee,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { SectionCard } from '../components/SectionCard.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { openProductionProgramPrint } from '../utils/productionProgramPrintHtml.js';

/**
 * Производственная программа (ПП) — страница модуля.
 *
 * План читается из локальной реплики (сервер ведёт, клиент только читает — план
 * доступен и без сети), а ведётся серверной дверью: кнопки «Сохранить» и «Новый
 * план» бьют в REST `/production-program`, а изменения приезжают обратно pull'ом.
 *
 * Что показывает экран:
 *  · список планов (период, цех, название, число двигателей);
 *  · редактор шапки: цех, название, период (две даты), статус;
 *  · строки плана: организация и договор, двигатель, состояние, плановая
 *    отгрузка, факторы, примечание;
 *  · добор двигателей по договору с подсказкой по состоянию («на заводе — можно
 *    брать», «ещё не приехал», «уже отгружен», «утиль»).
 */

type Props = {
  /** Каталог двигателей — источник подсказок и данных для печати. */
  engines: EngineListItem[];
  /** Право вести план (`production_program.edit`). */
  canEdit: boolean;
};

type DraftRow = ProductionProgramLineDraftDto & { id: string };

function inputDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function parseInputDate(value: string): number | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [, d, mo, y] = m;
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
  // Номер договора, подтянутый из строгой реплики: в строке двигателя его может не
  // быть (контракт создан мимо EAV), а подпись должна остаться человеческой.
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

  const contracts = useMemo(() => {
    // Подпись договора — человеческая: организация + номер. Идентификатор оператору
    // не показываем (правило проекта: наименование, а не технический номер).
    const organizationById = new Map<string, string>();
    const numberById = new Map<string, string>();
    for (const e of props.engines) {
      const id = String(e.contractId ?? '');
      if (!id) continue;
      if (!organizationById.has(id)) organizationById.set(id, String(e.customerName ?? '').trim());
      const number = String(e.contractName ?? '').trim();
      if (number && !looksLikeIdentifier(number) && !numberById.has(id)) numberById.set(id, number);
    }
    for (const [id, number] of Object.entries(resolvedContractNumbers)) numberById.set(id, number);
    return [...organizationById.keys()].map((id) => ({
      id,
      label:
        productionProgramContractLabel({
          organization: organizationById.get(id),
          contractNumber: numberById.get(id),
        }) || 'Договор без номера',
    }));
  }, [props.engines, resolvedContractNumbers]);

  const contractEngines = useMemo(
    // Пока договор не выбран, двигателей нет: строка плана без договора не имеет группы
    // («Организация, договор»), и сервер такую строку всё равно не примет (у неё нет
    // шапки группы) — предлагать её в договоре было бы обещанием, которого нет.
    () => (pickerContract ? props.engines.filter((e) => String(e.contractId ?? '') === pickerContract) : []),
    [props.engines, pickerContract],
  );

  const engineById = useMemo(() => new Map(props.engines.map((e) => [String(e.id), e])), [props.engines]);

  const setHeader = (patch: Partial<ProductionProgramDto>) => {
    setPrograms((prev) => prev.map((p) => (p.id === selectedId ? { ...p, ...patch } : p)));
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
    const groupLabel = contracts.find((c) => c.id === contractId)?.label ?? '';
    if (!groupLabel || groupLabel === 'Договор без номера') {
      setError('У двигателя нет наименования договора — строка плана без него не имеет группы. Заведите договор (наименование и номер) и повторите.');
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

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <SectionCard
        title="Производственная программа"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            {props.canEdit ? (
              <Button onClick={() => void createProgram()} disabled={busy}>
                Новый план
              </Button>
            ) : null}
            {selected ? (
              <>
                <Button onClick={() => void saveProgram()} disabled={busy || !props.canEdit}>
                  Сохранить
                </Button>
                <Button onClick={printProgram}>Печать</Button>
                {props.canEdit ? (
                  <Button onClick={() => void removeProgram()} disabled={busy}>
                    Удалить
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        }
      >
        {error ? <div style={{ color: 'var(--danger)', marginBottom: 8 }}>{error}</div> : null}
        {status ? <div style={{ color: 'var(--subtle)', marginBottom: 8 }}>{status}</div> : null}
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'minmax(220px, 300px) 1fr' }}>
          <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
            <div className="ui-muted" style={{ fontSize: 12 }}>
              Планы
            </div>
            {programs.length === 0 ? (
              <div className="ui-muted" style={{ fontSize: 12 }}>
                Планов пока нет
              </div>
            ) : null}
            {programs.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                style={{
                  textAlign: 'left',
                  padding: '6px 8px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: p.id === selectedId ? 'var(--tone-info-bg, #dbeafe)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 600 }}>{p.title}</div>
                <div className="ui-muted" style={{ fontSize: 12 }}>
                  {p.shop} · {formatProductionProgramPeriod({ start: p.periodStart, end: p.periodEnd })} ·{' '}
                  {lines.filter((l) => l.programId === p.id).length} двиг.
                </div>
              </button>
            ))}
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {!selected ? (
              <div className="ui-muted">Выберите план или создайте новый.</div>
            ) : (
              <>
                <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    Цех
                    <input
                      value={selected.shop}
                      disabled={!props.canEdit}
                      onChange={(e) => setHeader({ shop: e.target.value })}
                      style={{ padding: '4px 6px' }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    Название
                    <input
                      value={selected.title}
                      disabled={!props.canEdit}
                      onChange={(e) => setHeader({ title: e.target.value })}
                      style={{ padding: '4px 6px' }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    Период с
                    <input
                      value={inputDate(selected.periodStart)}
                      disabled={!props.canEdit}
                      onChange={(e) => setHeader({ periodStart: parseInputDate(e.target.value) ?? selected.periodStart })}
                      style={{ padding: '4px 6px' }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    Период по
                    <input
                      value={inputDate(selected.periodEnd)}
                      disabled={!props.canEdit}
                      onChange={(e) => setHeader({ periodEnd: parseInputDate(e.target.value) ?? selected.periodEnd })}
                      style={{ padding: '4px 6px' }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    Статус
                    <select
                      value={selected.status}
                      disabled={!props.canEdit}
                      onChange={(e) => setHeader({ status: e.target.value })}
                      style={{ padding: '4px 6px' }}
                    >
                      <option value="draft">Черновик</option>
                      <option value="approved">Утверждён</option>
                    </select>
                  </label>
                </div>

                {props.canEdit ? (
                  <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(200px, 1fr) minmax(240px, 2fr) auto' }}>
                    <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                      Договор
                      <select value={pickerContract} onChange={(e) => setPickerContract(e.target.value)} style={{ padding: '4px 6px' }}>
                        <option value="">— выберите договор —</option>
                        {contracts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>                    </label>
                    <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                      Двигатель
                      <select value={pickerEngine} onChange={(e) => setPickerEngine(e.target.value)} style={{ padding: '4px 6px' }}>
                        <option value="">— выберите двигатель —</option>
                        {contractEngines.map((e) => (
                          <option key={String(e.id)} value={String(e.id)}>
                            {[e.engineBrand, e.engineNumber].filter(Boolean).join(' ')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button onClick={() => void addEngine()} disabled={!pickerEngine}>
                      Добавить в план
                    </Button>
                    {hint ? (
                      <div style={{ fontSize: 12, color: 'var(--subtle)', gridColumn: '1 / -1' }}>
                        {hint.text}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div style={{ overflowX: 'auto' }}>
                  <table className="list-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>№ п/п</th>
                        <th>Организация, договор</th>
                        <th>Двигатель</th>
                        <th>Состояние</th>
                        <th>Отгрузка</th>
                        <th>Факторы</th>
                        <th>Примечание</th>
                        {props.canEdit ? <th /> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td colSpan={props.canEdit ? 8 : 7} className="ui-muted">
                            Строк в плане нет
                          </td>
                        </tr>
                      ) : null}
                      {rows.map((r, i) => (
                        <tr key={r.id}>
                          <td>{i + 1}</td>
                          <td>{r.groupLabel}</td>
                          <td>{[r.engineMark, r.engineNumber].filter(Boolean).join(' ')}</td>
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
                            <input
                              value={inputDate(r.shippingPlanAt)}
                              disabled={!props.canEdit}
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((x) =>
                                    x.id === r.id ? { ...x, shippingPlanAt: parseInputDate(e.target.value) } : x,
                                  ),
                                )
                              }
                              style={{ padding: '2px 4px', width: 110 }}
                            />
                          </td>
                          <td>
                            <input
                              value={r.factors ?? ''}
                              disabled={!props.canEdit}
                              onChange={(e) =>
                                setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, factors: e.target.value } : x)))
                              }
                              style={{ padding: '2px 4px', width: 180 }}
                            />
                          </td>
                          <td>
                            <input
                              value={r.note ?? ''}
                              disabled={!props.canEdit}
                              onChange={(e) =>
                                setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, note: e.target.value } : x)))
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
                                style={{ border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}
                              >
                                ✕
                              </button>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
