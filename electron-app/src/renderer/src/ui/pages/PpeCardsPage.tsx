import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { addWearMonths, nextIssueDates, resolveEmployeeNorms, PPE_DAY_MS, type PpeNextIssue } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { FormField } from '../components/FormField.js';
import { FormGrid } from '../components/FormGrid.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { SectionCard } from '../components/SectionCard.js';

type CardDto = {
  id: string;
  employeeId: string;
  openedAt: number;
  closedAt: number | null;
  norms: Array<{ normSetId: string; name: string; assignedAt: number }>;
  entries: Array<{ id: string; nomenclatureId: string; qty: number; issuedAt: number; documentId: string | null }>;
};

type NormOption = { id: string; name: string; postTitle: string | null };
type IssueLine = { nomenclatureId: string; qty: string };
type AbsenceRow = { id: string; employeeId: string; fromMs: number; toMs: number; kind: string };

const ABSENCE_KIND_RU: Record<string, string> = {
  vacation: 'отпуск',
  sick: 'больничный',
  unpaid: 'без сохранения',
};

const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };

function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

const STATUS_RU: Record<PpeNextIssue['status'], string> = {
  overdue: 'просрочено',
  dueSoon: 'скоро выдавать',
  ok: 'в сроке',
  neverIssued: 'не выдавалось',
};

/**
 * Личные карточки выдачи СИЗ. Карточка = сотрудник + назначенные наборы норм +
 * история выдач. Следующая выдача считается ядром shared/ppe из норм и фактов —
 * тем же, которым считают отчёты. Выдача — одним кликом: создаёт и проводит
 * stock_issue на выбранном складе, след пишет в карточку.
 */
export function PpeCardsPage(props: { canEdit: boolean; canIssue: boolean }) {
  const [employees, setEmployees] = useState<SearchSelectOption[]>([]);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [card, setCard] = useState<CardDto | null>(null);
  const [normOptions, setNormOptions] = useState<NormOption[]>([]);
  const [normToAssign, setNormToAssign] = useState<string | null>(null);
  const [normLines, setNormLines] = useState<Array<{ nomenclatureId: string; qty: number; wearMonths: number }>>([]);
  const [groupNormIds, setGroupNormIds] = useState<string[]>([]);
  const [absences, setAbsences] = useState<AbsenceRow[]>([]);
  const [absenceFrom, setAbsenceFrom] = useState('');
  const [absenceTo, setAbsenceTo] = useState('');
  const [nomNames, setNomNames] = useState<Map<string, string>>(new Map());
  const [warehouses, setWarehouses] = useState<SearchSelectOption[]>([]);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueWarehouse, setIssueWarehouse] = useState<string | null>(null);
  const [issueLines, setIssueLines] = useState<IssueLine[]>([{ nomenclatureId: '', qty: '1' }]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  const { confirm } = useConfirm();
  const canEdit = props.canEdit;

  useEffect(() => {
    void (async () => {
      const [emp, norms, wh] = await Promise.all([
        window.matrica.ppe.employees.list().catch(() => null),
        window.matrica.ppe.norms.list().catch(() => null),
        window.matrica.warehouseLocations.list({ activeOnly: true }).catch(() => null),
      ]);
      // Пикер — из реплики СИЗ (`erp_employee_cards`), не из EAV-списка сотрудников:
      // строгая дверь модуля знает только эти id (см. ppe:employees:list).
      setEmployees(
        (emp?.ok ? emp.employees : []).map((e) => ({
          id: e.id,
          label: e.fullName.trim() || e.id,
          ...(e.roleCode ? { hintText: e.roleCode } : {}),
          searchText: `${e.fullName} ${e.personnelNo ?? ''} ${e.roleCode ?? ''}`,
        })),
      );
      if (norms?.ok) setNormOptions(norms.rows);
      if (wh?.ok) {
        setWarehouses(
          (wh.rows ?? []).map((w: any) => ({ id: String(w.id), label: String(w.name ?? w.code ?? w.id) })),
        );
      }
      const noms = await window.matrica.warehouse.nomenclatureList({ limit: 2000, offset: 0 }).catch(() => null);
      if (noms?.ok) {
        setNomNames(new Map((noms.rows ?? []).map((r: any) => [String(r.id), String(r.name ?? r.id)])));
      }
    })();
  }, []);

  const nomName = useCallback((id: string) => nomNames.get(id) ?? id, [nomNames]);
  const empName = useCallback(
    (id: string) => employees.find((e) => e.id === id)?.label ?? id,
    [employees],
  );

  const loadCard = useCallback(async (id: string) => {
    const res = await window.matrica.ppe.cards.get(id);
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    setCard(res.card);
    const abs = await window.matrica.ppe.absences.list({ employeeId: res.card.employeeId }).catch(() => null);
    setAbsences(abs?.ok ? abs.rows : []);
    // Нормы сотрудника = личные привязки + нормы его групп (ядро сливает с дедупом
    // и минимальным сроком) — групповые строки видны и учитываются здесь же.
    const resolved = await window.matrica.ppe.employees.normSets(res.card.employeeId).catch(() => null);
    const groupIds = resolved?.ok ? resolved.group : [];
    setGroupNormIds(groupIds);
    const setIds = [...new Set([...res.card.norms.map((n) => n.normSetId), ...groupIds])];
    const allLines: Array<{ nomenclatureId: string; qty: number; wearMonths: number }> = [];
    for (const setId of setIds) {
      const det = await window.matrica.ppe.norms.get(setId).catch(() => null);
      if (det?.ok) allLines.push(...det.normSet.lines);
    }
    setNormLines(allLines);
  }, []);

  async function openCard() {
    if (!employeeId) return setStatus('Выберите сотрудника');
    setBusy(true);
    try {
      const res = await window.matrica.ppe.cards.open({ employeeId });
      if (!res.ok) {
        // Уже есть открытая — покажем её вместо ошибки.
        const existing = await window.matrica.ppe.cards.byEmployee(employeeId).catch(() => null);
        if (existing?.ok) {
          setStatus('');
          await loadCard(existing.card.id);
          return;
        }
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setStatus('Карточка открыта');
      await loadCard(res.id);
    } finally {
      setBusy(false);
    }
  }

  async function findCard() {
    if (!employeeId) return setStatus('Выберите сотрудника');
    setBusy(true);
    try {
      const res = await window.matrica.ppe.cards.byEmployee(employeeId);
      if (!res.ok) {
        setStatus(`Карточки нет: ${res.error}`);
        setCard(null);
        setAbsences([]);
        setGroupNormIds([]);
        return;
      }
      setCard(res.card);
      setStatus('');
      await loadCard(res.card.id);
    } finally {
      setBusy(false);
    }
  }

  async function assignNorm() {
    if (!card || !normToAssign) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.cards.assignNorms({ cardId: card.id, normSetIds: [normToAssign] });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setNormToAssign(null);
      setStatus(res.assigned > 0 ? 'Норма назначена' : 'Норма уже была назначена');
      await loadCard(card.id);
    } finally {
      setBusy(false);
    }
  }

  async function closeCard() {
    if (!card) return;
    const ok = await confirm({
      title: 'Закрыть карточку?',
      detail: `Карточка ${empName(card.employeeId)}. Выдачи останутся в истории, новые — невозможны.`,
      confirmLabel: 'Закрыть',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.cards.close(card.id);
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setStatus('Карточка закрыта');
      await loadCard(card.id);
    } finally {
      setBusy(false);
    }
  }

  async function addAbsence() {
    if (!card) return;
    const fromMs = fromInputDate(absenceFrom);
    const toMs = fromInputDate(absenceTo);
    if (fromMs == null || toMs == null) return setStatus('Заполните период отпуска: с и по');
    if (toMs <= fromMs) return setStatus('Дата «По» должна быть позже даты «С»');
    setBusy(true);
    try {
      const res = await window.matrica.ppe.absences.create({ employeeId: card.employeeId, fromMs, toMs });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setAbsenceFrom('');
      setAbsenceTo('');
      setStatus('Отпуск добавлен — сроки носки сдвинуты');
      await loadCard(card.id);
    } finally {
      setBusy(false);
    }
  }

  async function removeAbsence(row: AbsenceRow) {
    if (!card) return;
    const ok = await confirm({
      title: 'Убрать отпуск?',
      detail: `${fmtDate(row.fromMs)} — ${fmtDate(row.toMs)} (${ABSENCE_KIND_RU[row.kind] ?? row.kind}). Сроки вернутся назад.`,
      confirmLabel: 'Убрать',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.absences.delete(row.id);
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setStatus('Отпуск убран');
      await loadCard(card.id);
    } finally {
      setBusy(false);
    }
  }

  const merged = useMemo(
    () => resolveEmployeeNorms(normLines.map((l) => ({ normSetId: '', nomenclatureId: l.nomenclatureId, qty: l.qty, wearMonths: l.wearMonths }))),
    [normLines],
  );
  const upcoming = useMemo(
    () =>
      nextIssueDates(
        merged,
        card?.entries ?? [],
        Date.now(),
        undefined,
        absences.map((a) => ({ fromMs: a.fromMs, toMs: a.toMs })),
      ),
    [merged, card, absences],
  );

  async function doIssue() {
    if (!card) return;
    if (!issueWarehouse) return setStatus('Выберите склад выдачи');
    const parsed = issueLines
      .filter((l) => l.nomenclatureId)
      .map((l) => ({ nomenclatureId: l.nomenclatureId, qty: Math.trunc(Number(String(l.qty).replace(',', '.'))) }));
    if (parsed.length === 0) return setStatus('Добавьте хотя бы одну позицию');
    if (parsed.some((l) => !Number.isInteger(l.qty) || l.qty <= 0)) return setStatus('Количество — целое больше нуля');
    const ok = await confirm({
      title: 'Выдать СИЗ?',
      detail: `${empName(card.employeeId)}: ${parsed.map((l) => `${nomName(l.nomenclatureId)} — ${l.qty} шт`).join('; ')}. Документ расхода будет проведён сразу.`,
      confirmLabel: 'Выдать',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.cards.issue({ cardId: card.id, warehouseId: issueWarehouse, lines: parsed });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setIssueOpen(false);
      setIssueLines([{ nomenclatureId: '', qty: '1' }]);
      setStatus('Выдано, документ расхода проведён');
      await loadCard(card.id);
    } finally {
      setBusy(false);
    }
  }

  const filteredEmployees = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => `${e.label} ${e.hintText ?? ''}`.toLowerCase().includes(q));
  }, [employees, query]);

  const closed = card?.closedAt != null;
  const personalNormIds = new Set((card?.norms ?? []).map((n) => n.normSetId));
  const groupOnlyNormIds = groupNormIds.filter((id) => !personalNormIds.has(id));
  const hasAnyNorms = (card?.norms.length ?? 0) + groupOnlyNormIds.length > 0;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
      <SectionCard title="Сотрудники">
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск сотрудника" style={{ flex: 1 }} />
        </div>
        <FormField label="Сотрудник">
          <SearchSelect value={employeeId} options={filteredEmployees} placeholder="Выберите сотрудника" showAllWhenEmpty onChange={setEmployeeId} />
        </FormField>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button variant="primary" onClick={() => void findCard()} disabled={busy || !employeeId}>
            Открыть карточку
          </Button>
          {canEdit ? (
            <Button variant="ghost" onClick={() => void openCard()} disabled={busy || !employeeId}>
              Новая
            </Button>
          ) : null}
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
          <ListCount total={employees.length} shown={filteredEmployees.length} />
        </div>
      </SectionCard>

      <div style={{ display: 'grid', gap: 16 }}>
        {!card ? (
          <SectionCard title="Личная карточка СИЗ">
            <div style={{ color: 'var(--muted)' }}>Выберите сотрудника и откройте карточку. В карточке — назначенные нормы, сроки следующих выдач и история.</div>
          </SectionCard>
        ) : (
          <>
            <SectionCard title={`Карточка: ${empName(card.employeeId)}${closed ? ' (закрыта)' : ''}`}>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>Открыта {fmtDate(card.openedAt)}</div>
              {!hasAnyNorms ? (
                <div style={{ color: 'var(--muted)' }}>Нормы не назначены.</div>
              ) : (
                <table className="table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <RowNumberHeaderCell style={ROWNUM_STYLE} />
                      <th>Набор норм</th>
                      <th>Назначен</th>
                    </tr>
                  </thead>
                  <tbody>
                    {card.norms.map((n, i) => (
                      <tr key={n.normSetId}>
                        <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                        <td>{n.name}</td>
                        <td>{fmtDate(n.assignedAt)}</td>
                      </tr>
                    ))}
                    {groupOnlyNormIds.map((id, gi) => (
                      <tr key={id}>
                        <RowNumberCell n={card.norms.length + gi + 1} style={ROWNUM_STYLE} />
                        <td>
                          {normOptions.find((o) => o.id === id)?.name ?? id}
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}> · от группы</span>
                        </td>
                        <td>—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {canEdit && !closed ? (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'end' }}>
                  <div style={{ flex: 1 }}>
                    <FormField label="Назначить набор">
                      <SearchSelect
                        value={normToAssign}
                        options={normOptions.filter((o) => !card.norms.some((n) => n.normSetId === o.id)).map((o) => ({
                          id: o.id,
                          label: o.name,
                          ...(o.postTitle ? { hintText: o.postTitle } : {}),
                          searchText: `${o.name} ${o.postTitle ?? ''}`,
                        }))}
                        placeholder="Набор норм"
                        showAllWhenEmpty
                        onChange={setNormToAssign}
                      />
                    </FormField>
                  </div>
                  <Button variant="primary" onClick={() => void assignNorm()} disabled={busy || !normToAssign}>
                    Назначить
                  </Button>
                  <Button variant="ghost" tone="danger" onClick={() => void closeCard()} disabled={busy}>
                    Закрыть карточку
                  </Button>
                </div>
              ) : null}
            </SectionCard>

            <SectionCard title="Сроки следующих выдач">
              {upcoming.length === 0 ? (
                <div style={{ color: 'var(--muted)' }}>Нет назначенных норм — сроки считать не из чего.</div>
              ) : (
                <table className="table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <RowNumberHeaderCell style={ROWNUM_STYLE} />
                      <th>Позиция</th>
                      <th style={{ textAlign: 'right' }}>Кол-во</th>
                      <th>Последняя выдача</th>
                      <th>Следующая</th>
                      <th>Состояние</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcoming.map((u, i) => (
                      <tr key={u.nomenclatureId} style={u.status === 'overdue' ? { background: 'var(--danger-soft, rgba(200,0,0,0.06))' } : undefined}>
                        <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                        <td>{nomName(u.nomenclatureId)}</td>
                        <td style={{ textAlign: 'right' }}>{u.qty}</td>
                        <td>{fmtDate(u.lastIssuedAt)}</td>
                        <td>
                          {fmtDate(u.nextDueAt)}
                          {u.lastIssuedAt != null && u.nextDueAt != null
                            ? (() => {
                                const days = Math.round((u.nextDueAt - addWearMonths(u.lastIssuedAt, u.wearMonths)) / PPE_DAY_MS);
                                return days > 0 ? (
                                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>+{days} дн. отпуск</div>
                                ) : null;
                              })()
                            : null}
                        </td>
                        <td>{STATUS_RU[u.status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {props.canIssue && !closed ? (
                <div style={{ marginTop: 8 }}>
                  <Button variant="primary" onClick={() => setIssueOpen(true)} disabled={busy}>
                    Выдать СИЗ
                  </Button>
                </div>
              ) : null}
            </SectionCard>

            <SectionCard title="Отпуска (сдвигают сроки носки)">
              {absences.length === 0 ? (
                <div style={{ color: 'var(--muted)' }}>Отпусков нет.</div>
              ) : (
                <table className="table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <RowNumberHeaderCell style={ROWNUM_STYLE} />
                      <th>Период</th>
                      <th>Вид</th>
                      {canEdit && !closed ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {[...absences].sort((a, b) => b.fromMs - a.fromMs).map((a, i) => (
                      <tr key={a.id}>
                        <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                        <td>
                          {fmtDate(a.fromMs)} — {fmtDate(a.toMs)}
                        </td>
                        <td>{ABSENCE_KIND_RU[a.kind] ?? a.kind}</td>
                        {canEdit && !closed ? (
                          <td style={{ textAlign: 'right' }}>
                            <Button variant="ghost" onClick={() => void removeAbsence(a)} disabled={busy}>
                              Убрать
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {canEdit && !closed ? (
                <div style={{ display: 'grid', gridTemplateColumns: '160px 160px auto', gap: 8, alignItems: 'end', marginTop: 8 }}>
                  <FormField label="С">
                    <Input type="date" value={absenceFrom} onChange={(e) => setAbsenceFrom(e.target.value)} />
                  </FormField>
                  <FormField label="По">
                    <Input type="date" value={absenceTo} onChange={(e) => setAbsenceTo(e.target.value)} />
                  </FormField>
                  <Button variant="primary" onClick={() => void addAbsence()} disabled={busy}>
                    Добавить отпуск
                  </Button>
                </div>
              ) : null}
            </SectionCard>

            {issueOpen ? (
              <SectionCard title="Выдача">
                <FormGrid>
                  <FormField label="Склад выдачи">
                    <SearchSelect value={issueWarehouse} options={warehouses} placeholder="Склад" showAllWhenEmpty onChange={setIssueWarehouse} />
                  </FormField>
                </FormGrid>
                {issueLines.map((l, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 110px auto', gap: 8, alignItems: 'end', marginTop: 8 }}>
                    <FormField label={i === 0 ? 'Позиция' : ''}>
                      <SearchSelect
                        value={l.nomenclatureId || null}
                        options={merged.map((m) => ({ id: m.nomenclatureId, label: nomName(m.nomenclatureId), searchText: nomName(m.nomenclatureId) }))}
                        placeholder="Позиция из норм"
                        showAllWhenEmpty
                        onChange={(next) => setIssueLines((prev) => prev.map((p, j) => (j === i ? { ...p, nomenclatureId: next ?? '' } : p)))}
                      />
                    </FormField>
                    <FormField label={i === 0 ? 'Кол-во' : ''}>
                      <Input
                        value={l.qty}
                        inputMode="numeric"
                        onChange={(e) => setIssueLines((prev) => prev.map((p, j) => (j === i ? { ...p, qty: e.target.value } : p)))}
                      />
                    </FormField>
                    <Button variant="ghost" onClick={() => setIssueLines((prev) => prev.filter((_, j) => j !== i))} disabled={busy || issueLines.length <= 1}>
                      Убрать
                    </Button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <Button variant="ghost" onClick={() => setIssueLines((prev) => [...prev, { nomenclatureId: '', qty: '1' }])} disabled={busy}>
                    + Позиция
                  </Button>
                  <Button variant="primary" onClick={() => void doIssue()} disabled={busy}>
                    Выдать и провести
                  </Button>
                  <Button variant="ghost" onClick={() => setIssueOpen(false)} disabled={busy}>
                    Отмена
                  </Button>
                </div>
              </SectionCard>
            ) : null}

            <SectionCard title="История выдач">
              {card.entries.length === 0 ? (
                <div style={{ color: 'var(--muted)' }}>Выдач пока не было.</div>
              ) : (
                <>
                  <ListCount total={card.entries.length} shown={card.entries.length} />
                  <table className="table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <RowNumberHeaderCell style={ROWNUM_STYLE} />
                        <th>Дата</th>
                        <th>Позиция</th>
                        <th style={{ textAlign: 'right' }}>Кол-во</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...card.entries].sort((a, b) => b.issuedAt - a.issuedAt).map((e, i) => (
                        <tr key={e.id}>
                          <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                          <td>{fmtDate(e.issuedAt)}</td>
                          <td>{nomName(e.nomenclatureId)}</td>
                          <td style={{ textAlign: 'right' }}>{e.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </SectionCard>
          </>
        )}

        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)' }}>{status}</div> : null}
      </div>
    </div>
  );
}
