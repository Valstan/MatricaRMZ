import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  absenceSegments,
  defaultVacationPeriod,
  findOverlappingAbsence,
  mondayOfDate,
  vacationHalves,
  type VacationAbsence,
  type VacationSegment,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { FormField } from '../components/FormField.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { SectionCard } from '../components/SectionCard.js';

/**
 * График отпусков — наподобие табеля, но по отпускам.
 *
 * Сетка: каждый месяц занимает две колонки (1–15 и 16–последний день), так месяц
 * читается без прокрутки. Период отпуска рисуется полосой в своей половине; период
 * через границу месяца виден в обеих. Кнопка «+» добавляет сотрудников из базы,
 * каждому задаётся период — по умолчанию две недели с ближайшего понедельника.
 *
 * Данные — те же `ppe_absences`, по которым идёт расчёт норм выдачи (миграция 0110):
 * второго места хранения отпусков не заводим.
 */

type GridRow = {
  /** id карточки сотрудника СИЗ (`erp_employee_cards`). */
  id: string;
  fullName: string;
  personnelNo: string | null;
};

const ROWS_STORAGE_KEY = 'matrica:ppe-vacation-rows';
const HALF_WIDTH = 132;

const MONTH_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

const KIND_RU: Record<string, string> = {
  vacation: 'Отпуск',
  sick: 'Больничный',
  unpaid: 'Без сохранения',
};

function toInputDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromInputDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

function fmtRange(fromMs: number, toMs: number): string {
  const f = new Date(fromMs);
  const t = new Date(toMs);
  const fd = `${String(f.getDate()).padStart(2, '0')}.${String(f.getMonth() + 1).padStart(2, '0')}`;
  const td = `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}`;
  return `${fd} – ${td}`;
}

function loadRows(): GridRow[] {
  try {
    const raw = window.localStorage.getItem(ROWS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r.id === 'string')
      .map((r) => ({ id: String(r.id), fullName: String(r.fullName ?? ''), personnelNo: r.personnelNo ?? null }));
  } catch {
    return [];
  }
}

export function PpeVacationSchedulePage(props: { canEdit: boolean }) {
  const { confirm } = useConfirm();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [rows, setRows] = useState<GridRow[]>(() => loadRows());
  const [absences, setAbsences] = useState<VacationAbsence[]>([]);
  const [employees, setEmployees] = useState<Array<{ id: string; fullName: string; personnelNo: string | null }>>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerPicked, setPickerPicked] = useState<Set<string>>(new Set());
  const [period, setPeriod] = useState<{
    employeeId: string;
    from: string;
    to: string;
    kind: string;
  } | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const halves = useMemo(() => vacationHalves(year), [year]);

  const loadAbsences = useCallback(async () => {
    const res = await window.matrica.ppe.absences.list().catch((e) => ({ ok: false as const, error: String(e) }));
    if (!res.ok) {
      setStatus(`Не удалось прочитать отпуска: ${res.error}`);
      return;
    }
    const list = (res.rows ?? []) as VacationAbsence[];
    setAbsences(list);
  }, []);

  const loadEmployees = useCallback(async () => {
    const res = await window.matrica.ppe.employees.list().catch(() => null);
    if (!res?.ok) return;
    setEmployees(
      (res.employees ?? []).map((e: any) => ({
        id: String(e.id),
        fullName: String(e.fullName ?? ''),
        personnelNo: e.personnelNo ?? null,
      })),
    );
  }, []);

  useEffect(() => {
    void loadEmployees();
    void loadAbsences();
  }, [loadEmployees, loadAbsences]);

  // Кто в сетке — машинно-локально: набор строк держит сам кладовщик, и он не должен
  // ездить между машинами (как и раскладки колонок).
  useEffect(() => {
    try {
      window.localStorage.setItem(ROWS_STORAGE_KEY, JSON.stringify(rows));
    } catch {
      // Хранилище недоступно — сетка просто не переживёт перезапуск клиента.
    }
  }, [rows]);

  const segmentsByEmployee = useMemo(() => {
    const map = new Map<string, VacationSegment[]>();
    for (const seg of absenceSegments(absences, year)) {
      const list = map.get(seg.employeeId) ?? [];
      list.push(seg);
      map.set(seg.employeeId, list);
    }
    return map;
  }, [absences, year]);

  const periodsByEmployee = useMemo(() => {
    const map = new Map<string, VacationAbsence[]>();
    for (const row of absences) {
      const list = map.get(row.employeeId) ?? [];
      list.push(row);
      map.set(row.employeeId, list);
    }
    return map;
  }, [absences]);

  const openPicker = () => {
    setPickerPicked(new Set());
    setPickerQuery('');
    setPickerOpen(true);
  };

  const addPicked = () => {
    if (!pickerPicked.size) return;
    setRows((prev) => {
      const known = new Set(prev.map((r) => r.id));
      const added = employees
        .filter((e) => pickerPicked.has(e.id) && !known.has(e.id))
        .map((e) => ({ id: e.id, fullName: e.fullName, personnelNo: e.personnelNo }));
      return [...prev, ...added];
    });
    setPickerOpen(false);
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  /** Открыть диалог периода: по умолчанию — две недели с ближайшего понедельника. */
  const openPeriod = (employeeId: string, halfIndex?: number) => {
    const std = defaultVacationPeriod(Date.now());
    let fromMs = std.fromMs;
    // Клик по половине месяца — период ставим в это место, но начиная с понедельника
    // той недели: так правило «с понедельника» не ломается.
    if (halfIndex != null) {
      const half = halves[halfIndex];
      if (half) {
        const monday = mondayOfDate(year, half.month, half.half === 1 ? 1 : 16);
        if (monday >= Date.now()) fromMs = monday;
      }
    }
    setPeriod({
      employeeId,
      from: toInputDate(fromMs),
      to: toInputDate(fromMs + 14 * 86_400_000 - 1),
      kind: 'vacation',
    });
  };

  const savePeriod = async () => {
    if (!period) return;
    const fromMs = fromInputDate(period.from);
    const toMs = fromInputDate(period.to);
    if (fromMs == null || toMs == null) {
      setStatus('Даты не разобраны — нужно «дд.мм.гггг»');
      return;
    }
    if (fromMs >= toMs) {
      setStatus('Дата «с» должна быть раньше даты «по»');
      return;
    }
    const overlap = findOverlappingAbsence(absences, period.employeeId, fromMs, toMs);
    if (overlap) {
      const ok = await confirm({
        title: 'Период пересекается',
        detail: `У сотрудника уже есть отпуск с ${fmtRange(overlap.fromMs, overlap.toMs)}. Завести ещё один поверх?`,
        confirmLabel: 'Завести',
        cancelLabel: 'Отмена',
        confirmTone: 'info',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.ppe.absences.create({
        employeeId: period.employeeId,
        fromMs,
        toMs,
        kind: period.kind,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setStatus('Отпуск записан.');
      setPeriod(null);
      await loadAbsences();
    } finally {
      setBusy(false);
    }
  };

  const deletePeriod = async (absenceId: string) => {
    const ok = await confirm({
      title: 'Удалить отпуск',
      detail: 'Период исчезнет из графика. Отмена сроков норм выдачи пересчитается по новым данным.',
      confirmLabel: 'Удалить',
      cancelLabel: 'Отмена',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.absences.delete(absenceId);
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await loadAbsences();
    } finally {
      setBusy(false);
    }
  };

  const filteredEmployees = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const known = new Set(rows.map((r) => r.id));
    return employees.filter((e) => {
      if (known.has(e.id)) return false;
      if (!q) return true;
      return `${e.fullName} ${e.personnelNo ?? ''}`.toLowerCase().includes(q);
    });
  }, [employees, rows, pickerQuery]);

  const periodCount = useMemo(() => {
    let n = 0;
    for (const row of absences) {
      const d = new Date(row.fromMs);
      if (d.getFullYear() === year) n += 1;
    }
    return n;
  }, [absences, year]);

  return (
    <div style={{ padding: 12, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 16 }}>График отпусков</span>
        <Button variant="ghost" onClick={() => setYear((y) => y - 1)} disabled={busy}>
          ‹
        </Button>
        <span style={{ minWidth: 44, textAlign: 'center', fontWeight: 600 }}>{year}</span>
        <Button variant="ghost" onClick={() => setYear((y) => y + 1)} disabled={busy}>
          ›
        </Button>
        <Button variant="ghost" onClick={() => void loadAbsences()} disabled={busy}>
          Обновить
        </Button>
        {props.canEdit ? (
          <Button variant="primary" onClick={openPicker} disabled={busy}>
            + Сотрудники
          </Button>
        ) : null}
      </div>

      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
        Сетка: месяц в двух половинах (1–15 и 16–последний день). Клик по клетке — задать
        сотруднику отпуск; по умолчанию две недели с понедельника. Отпуск через границу
        месяца виден в обеих половинах.
        <span style={{ marginLeft: 12 }}>
          <ListCount total={rows.length} shown={rows.length} extra="сотрудников в графике" />
        </span>
        <span style={{ marginLeft: 12 }}>отпусков за {year} год: {periodCount}</span>
      </div>

      {status ? <div style={{ color: 'var(--muted)' }}>{status}</div> : null}

      <SectionCard title="">
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ borderCollapse: 'collapse', width: 'max-content' }}>
            <thead>
              <tr>
                <th
                  style={{
                    position: 'sticky',
                    left: 0,
                    background: 'var(--surface)',
                    zIndex: 2,
                    minWidth: 220,
                    textAlign: 'left',
                  }}
                >
                  Сотрудник
                </th>
                {MONTH_RU.map((name) => (
                  <th key={name} colSpan={2} style={{ textAlign: 'center' }}>
                    {name}
                  </th>
                ))}
              </tr>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 2 }} />
                {halves.map((half) => (
                  <th key={half.index} style={{ width: HALF_WIDTH, textAlign: 'center', fontWeight: 400 }}>
                    {half.half === 1 ? '1–15' : `16–${half.days + 15}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const segs = segmentsByEmployee.get(row.id) ?? [];
                const periods = periodsByEmployee.get(row.id) ?? [];
                return (
                  <tr key={row.id}>
                    <td
                      style={{
                        position: 'sticky',
                        left: 0,
                        background: 'var(--surface)',
                        zIndex: 1,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.fullName || row.id}
                      {row.personnelNo ? (
                        <span style={{ color: 'var(--muted)', marginLeft: 6 }}>таб. {row.personnelNo}</span>
                      ) : null}
                      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                        {props.canEdit ? (
                          <>
                            <Button variant="ghost" onClick={() => openPeriod(row.id)} disabled={busy}>
                              + отпуск
                            </Button>
                            <Button variant="ghost" onClick={() => removeRow(row.id)} disabled={busy}>
                              убрать
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                    {halves.map((half) => {
                      const cellSegs = segs.filter((s) => s.halfIndex === half.index);
                      return (
                        <td
                          key={half.index}
                          style={{
                            position: 'relative',
                            height: 34,
                            padding: 0,
                            border: '1px solid var(--border)',
                            background: 'var(--surface)',
                            cursor: props.canEdit ? 'pointer' : 'default',
                          }}
                          onClick={() => props.canEdit && openPeriod(row.id, half.index)}
                        >
                          {cellSegs.map((seg) => {
                            const period = periods.find((p) => p.id === seg.absenceId);
                            return (
                              <div
                                key={`${seg.absenceId}-${seg.halfIndex}`}
                                title={
                                  period
                                    ? `${KIND_RU[period.kind] ?? period.kind}: ${fmtRange(period.fromMs, period.toMs)}`
                                    : seg.label
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (props.canEdit) void deletePeriod(seg.absenceId);
                                }}
                                style={{
                                  position: 'absolute',
                                  left: `${seg.leftPct}%`,
                                  width: `${seg.widthPct}%`,
                                  top: 6,
                                  bottom: 6,
                                  minWidth: 8,
                                  borderRadius: 4,
                                  background: 'var(--accent, #2563eb)',
                                  opacity: 0.85,
                                  color: '#fff',
                                  fontSize: 11,
                                  lineHeight: '20px',
                                  padding: '0 4px',
                                  overflow: 'hidden',
                                  whiteSpace: 'nowrap',
                                  cursor: props.canEdit ? 'pointer' : 'default',
                                }}
                              >
                                {seg.label}
                              </div>
                            );
                          })}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length ? (
            <div style={{ color: 'var(--muted)', padding: 12 }}>
              В графике пока никого нет. Нажмите «+ Сотрудники» и добавьте нужных — по табельному
              номеру они найдутся в базе.
            </div>
          ) : null}
        </div>
      </SectionCard>

      {pickerOpen ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 6, 23, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPickerOpen(false);
          }}
        >
          <div
            data-ppe-vacation-picker
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 16,
              width: 520,
              maxWidth: '100%',
              display: 'grid',
              gap: 10,
              maxHeight: '80vh',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 16 }}>Добавить сотрудников в график</div>
            <Input
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="Поиск по фамилии или табельному номеру"
            />
            <div style={{ overflowY: 'auto', display: 'grid', gap: 4, minHeight: 120 }}>
              {filteredEmployees.map((e) => (
                <label key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={pickerPicked.has(e.id)}
                    onChange={(ev) => {
                      const next = new Set(pickerPicked);
                      if (ev.target.checked) next.add(e.id);
                      else next.delete(e.id);
                      setPickerPicked(next);
                    }}
                  />
                  <span>{e.fullName || e.id}</span>
                  {e.personnelNo ? (
                    <span style={{ color: 'var(--muted)' }}>таб. {e.personnelNo}</span>
                  ) : null}
                </label>
              ))}
              {!filteredEmployees.length ? (
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>Никого не найдено.</div>
              ) : null}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setPickerOpen(false)}>
                Отмена
              </Button>
              <Button variant="primary" onClick={addPicked} disabled={!pickerPicked.size}>
                Добавить ({pickerPicked.size})
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {period ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 6, 23, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPeriod(null);
          }}
        >
          <div
            data-ppe-vacation-period
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 16,
              width: 420,
              maxWidth: '100%',
              display: 'grid',
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 16 }}>Отпуск сотрудника</div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              По умолчанию — две недели с понедельника. Даты можно поменять.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <FormField label="С">
                <Input
                  value={period.from}
                  onChange={(e) => setPeriod((p) => (p ? { ...p, from: e.target.value } : p))}
                  placeholder="дд.мм.гггг"
                />
              </FormField>
              <FormField label="По">
                <Input
                  value={period.to}
                  onChange={(e) => setPeriod((p) => (p ? { ...p, to: e.target.value } : p))}
                  placeholder="дд.мм.гггг"
                />
              </FormField>
            </div>
            <FormField label="Вид отсутствия">
              <Input
                value={KIND_RU[period.kind] ?? period.kind}
                onChange={(e) => {
                  const found = Object.entries(KIND_RU).find(([, ru]) => ru === e.target.value.trim());
                  setPeriod((p) => (p ? { ...p, kind: found ? found[0] : e.target.value.trim() } : p));
                }}
                placeholder="Отпуск"
              />
            </FormField>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setPeriod(null)}>
                Отмена
              </Button>
              <Button variant="primary" onClick={() => void savePeriod()} disabled={busy}>
                Записать
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
