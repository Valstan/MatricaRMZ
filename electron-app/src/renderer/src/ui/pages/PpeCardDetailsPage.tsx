import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  addWearMonths,
  nextIssueDates,
  normalizeLookupCompact,
  normalizeLookupText,
  PPE_DAY_MS,
  PPE_SIZE_ATTRIBUTE_CODES,
  ppeSizeKindForName,
  resolveEmployeeNorms,
  type PpeNextIssue,
  type PpeSizeKind,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { FormField } from '../components/FormField.js';
import { FormGrid } from '../components/FormGrid.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { MailSendButton } from '../components/MailSendButton.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { SectionCard } from '../components/SectionCard.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { printSectionsToText } from '../utils/mailText.js';
import { escapeHtml, formatMomentLabel, openPrintPreview, type PrintSection } from '../utils/printPreview.js';

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

/** Фактические размеры сотрудника — из EAV-карточки employee (та же, где их правит оператор). */
type EmployeeSizes = { clothes: string; shoes: string; height: string };
const EMPTY_SIZES: EmployeeSizes = { clothes: '', shoes: '', height: '' };
function sizeMatchKey(raw: string): string {
  const compact = normalizeLookupCompact(String(raw ?? ''));
  return compact.match(/\d+/)?.[0] ?? compact;
}
function sizeWordTokens(name: string): string[] {
  return normalizeLookupText(String(name ?? ''))
    .split(/[^0-9a-zа-яё]+/i)
    .map(normalizeLookupCompact)
    .filter(Boolean);
}
const SIZE_LABEL_RU: Array<[PpeSizeKind, string]> = [
  ['clothes', 'одежда'],
  ['shoes', 'обувь'],
];

function readEmployeeSizes(attributes: Record<string, unknown> | null | undefined): EmployeeSizes {
  const text = (code: string): string => {
    const raw = attributes?.[code];
    return raw == null || typeof raw === 'object' ? '' : String(raw).trim();
  };
  return {
    clothes: text(PPE_SIZE_ATTRIBUTE_CODES.clothes),
    shoes: text(PPE_SIZE_ATTRIBUTE_CODES.shoes),
    height: text(PPE_SIZE_ATTRIBUTE_CODES.height),
  };
}

function sizesSummary(sizes: EmployeeSizes): string {
  const parts = SIZE_LABEL_RU.filter(([kind]) => sizes[kind]).map(([kind, label]) => `${label} ${sizes[kind]}`);
  if (sizes.height) parts.push(`рост ${sizes.height}`);
  return parts.join(' · ');
}

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
 * Личная карточка выдачи СИЗ в отдельной вкладке: сотрудник + назначенные наборы норм +
 * история выдач + сроки. Сроки считает ядро shared/ppe — тем же, которым считает список
 * карточек и отчёты. Печать и Word собираются из ОДНОЙ модели секций: иначе лист и файл
 * разъедутся, и чинить придётся дважды.
 */
export function PpeCardDetailsPage(props: {
  employeeId: string;
  canEdit: boolean;
  canIssue: boolean;
  onBack?: () => void;
}) {
  const { employeeId } = props;
  const [employees, setEmployees] = useState<SearchSelectOption[]>([]);
  const [card, setCard] = useState<CardDto | null>(null);
  const [cardMissing, setCardMissing] = useState(false);
  const [normOptions, setNormOptions] = useState<NormOption[]>([]);
  const [normToAssign, setNormToAssign] = useState<string | null>(null);
  const [normLines, setNormLines] = useState<Array<{ nomenclatureId: string; qty: number; wearMonths: number }>>([]);
  const [groupNormIds, setGroupNormIds] = useState<string[]>([]);
  const [absences, setAbsences] = useState<AbsenceRow[]>([]);
  const [absenceFrom, setAbsenceFrom] = useState('');
  const [absenceTo, setAbsenceTo] = useState('');
  const [nomNames, setNomNames] = useState<Map<string, string>>(new Map());
  const [personnelByEmployee, setPersonnelByEmployee] = useState<Map<string, string>>(new Map());
  // Размеры по табельному номеру: карточка СИЗ знает строгого сотрудника (id из
  // erp_employee_cards), а размеры живут в EAV-карточке employee — общий ключ один.
  const [sizesByPersonnel, setSizesByPersonnel] = useState<Map<string, EmployeeSizes>>(new Map());
  const [sizes, setSizes] = useState<EmployeeSizes>(EMPTY_SIZES);
  const [warehouses, setWarehouses] = useState<SearchSelectOption[]>([]);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueWarehouse, setIssueWarehouse] = useState<string | null>(null);
  const [issueLines, setIssueLines] = useState<IssueLine[]>([{ nomenclatureId: '', qty: '1' }]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const { confirm } = useConfirm();
  const canEdit = props.canEdit;

  /**
   * Размеры сотрудников — из EAV-карточек `employee` (поля «Размер одежды», «Размер
   * обуви», «Рост»). Карточка СИЗ и EAV-карточка живут разными id, поэтому размеры
   * кладём в карту по табельному номеру — единственному общему ключу. Читаем тем же
   * правом `masterdata.view`, что и справочник сотрудников (оно в базе роли оператора).
   */
  const loadEmployeeSizes = useCallback(async () => {
    const types = await window.matrica.admin.entityTypes.list().catch(() => null as any);
    const employeeType = (types ?? []).find((t: any) => String(t.code ?? '') === 'employee');
    if (!employeeType) return;
    const rows = await window.matrica.admin.entities
      .listByEntityTypeWithAttrs(String(employeeType.id))
      .catch(() => [] as Array<{ id: string; attributes: Record<string, unknown> }>);
    const byPersonnel = new Map<string, EmployeeSizes>();
    for (const row of rows) {
      const personnelNo = String(row.attributes?.personnel_number ?? '').trim();
      if (!personnelNo) continue;
      byPersonnel.set(personnelNo, readEmployeeSizes(row.attributes));
    }
    setSizesByPersonnel(byPersonnel);
  }, []);

  const loadEmployees = useCallback(async () => {
    const emp = await window.matrica.ppe.employees.list().catch(() => null);
    const empRows = emp?.ok ? emp.employees : [];
    setEmployees(
      empRows.map((e) => ({
        id: e.id,
        label: e.fullName.trim() || e.id,
        ...(e.isActive === false ? { disabled: true, hintText: 'уволен' } : e.roleCode ? { hintText: e.roleCode } : {}),
        searchText: `${e.fullName} ${e.personnelNo ?? ''} ${e.roleCode ?? ''}`,
      })),
    );
    setPersonnelByEmployee(new Map(empRows.map((e) => [String(e.id), String(e.personnelNo ?? '')])));
    await loadEmployeeSizes();
  }, [loadEmployeeSizes]);

  // Вкладка живёт в keep-alive: без импульса размеры и табельные, поправленные в карточке
  // сотрудника, не подтянулись бы до перезапуска клиента.
  useLiveDataRefresh(loadEmployees, { intervalMs: 60_000 });

  useEffect(() => {
    void (async () => {
      const [norms, wh] = await Promise.all([
        window.matrica.ppe.norms.list().catch(() => null),
        window.matrica.warehouseLocations.list({ activeOnly: true }).catch(() => null),
      ]);
      await loadEmployees();
      if (norms?.ok) setNormOptions(norms.rows);
      if (wh?.ok) {
        setWarehouses((wh.rows ?? []).map((w: any) => ({ id: String(w.id), label: String(w.name ?? w.code ?? w.id) })));
      }
      const noms = await window.matrica.warehouse.nomenclatureList({ limit: 2000, offset: 0 }).catch(() => null);
      if (noms?.ok) {
        const rows = (noms.rows ?? []) as any[];
        setNomNames(new Map(rows.map((r) => [String(r.id), String(r.name ?? r.id)])));
      }
    })();
  }, [loadEmployees]);

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
    setCardMissing(false);
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
    const personnelNo = personnelByEmployee.get(res.card.employeeId) ?? '';
    setSizes(personnelNo ? (sizesByPersonnel.get(personnelNo) ?? EMPTY_SIZES) : EMPTY_SIZES);
  }, [personnelByEmployee, sizesByPersonnel]);

  // Карточку открываем по сотруднику: список карточек ведёт сюда кликом по строке, а
  // «карточки нет» — законный случай (её заводят первой выдачей или кнопкой).
  const findCard = useCallback(async () => {
    setBusy(true);
    try {
      const res = await window.matrica.ppe.cards.byEmployee(employeeId);
      if (!res.ok) {
        setCard(null);
        setCardMissing(true);
        setAbsences([]);
        setGroupNormIds([]);
        setNormLines([]);
        const personnelNo = personnelByEmployee.get(employeeId) ?? '';
        setSizes(personnelNo ? (sizesByPersonnel.get(personnelNo) ?? EMPTY_SIZES) : EMPTY_SIZES);
        return;
      }
      await loadCard(res.card.id);
    } finally {
      setBusy(false);
    }
  }, [employeeId, loadCard, personnelByEmployee, sizesByPersonnel]);

  useEffect(() => {
    void findCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- карточка перечитывается при смене сотрудника и после первого прихода справочника: findCard зависит от карт размеров, которые приезжают позже
  }, [employeeId, personnelByEmployee.size]);

  async function openCard() {
    setBusy(true);
    try {
      const res = await window.matrica.ppe.cards.open({ employeeId });
      if (!res.ok) {
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
    () =>
      resolveEmployeeNorms(
        normLines.map((l) => ({ normSetId: '', nomenclatureId: l.nomenclatureId, qty: l.qty, wearMonths: l.wearMonths })),
      ),
    [normLines],
  );

  // Позиции размерного ряда, совпавшие с размером сотрудника (подсказка при выдаче).
  // Сравниваем внутри набора норм карточки, по целому слову: «8» ≠ «р. 48».
  const hintedIds = useMemo(() => {
    const result = new Set<string>();
    const byKind = new Map<PpeSizeKind, string[]>();
    for (const m of merged) {
      const kind = ppeSizeKindForName(nomName(m.nomenclatureId));
      if (!kind) continue;
      const size = sizes[kind];
      if (!size) continue;
      const sizeKey = sizeMatchKey(size);
      if (!sizeWordTokens(nomName(m.nomenclatureId)).includes(sizeKey)) continue;
      const arr = byKind.get(kind) ?? [];
      arr.push(m.nomenclatureId);
      byKind.set(kind, arr);
    }
    for (const ids of byKind.values()) {
      if (ids.length === 1) result.add(ids[0]!);
    }
    return result;
  }, [merged, nomName, sizes]);

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

  const closed = card?.closedAt != null;
  const personalNormIds = new Set((card?.norms ?? []).map((n) => n.normSetId));
  const groupOnlyNormIds = groupNormIds.filter((id) => !personalNormIds.has(id));
  const hasAnyNorms = (card?.norms.length ?? 0) + groupOnlyNormIds.length > 0;
  const employeeLabel = empName(employeeId) || 'Сотрудник';

  /**
   * Печатная форма карточки — одна на печать и на Word. Таблицы собираются здесь, а не в
   * JSX: печать и выгрузка обязаны показывать один и тот же лист.
   */
  function buildCardForm() {
    const title = `Личная карточка СИЗ: ${employeeLabel}`;
    const e = (v: unknown) => escapeHtml(String(v ?? ''));
    const head = `<table><tbody>
      <tr><th style="text-align:left;white-space:nowrap;">Сотрудник</th><td>${e(employeeLabel)}</td></tr>
      <tr><th style="text-align:left;">Табельный номер</th><td>${e(personnelByEmployee.get(employeeId) || '—')}</td></tr>
      <tr><th style="text-align:left;">Размеры</th><td>${e(sizesSummary(sizes) || 'не заполнены')}</td></tr>
      <tr><th style="text-align:left;">Карточка</th><td>${e(card ? `открыта ${fmtDate(card.openedAt)}${closed ? `, закрыта ${fmtDate(card.closedAt)}` : ''}` : 'не заведена')}</td></tr>
    </tbody></table>`;

    const normsRows = [
      ...(card?.norms ?? []).map((n, i) => `<tr><td>${i + 1}</td><td>${e(n.name)}</td><td>${e(fmtDate(n.assignedAt))}</td></tr>`),
      ...groupOnlyNormIds.map(
        (id, gi) =>
          `<tr><td>${(card?.norms.length ?? 0) + gi + 1}</td><td>${e(normOptions.find((o) => o.id === id)?.name ?? id)} (от группы)</td><td>—</td></tr>`,
      ),
    ].join('');
    const normsHtml = normsRows
      ? `<table><thead><tr><th>№</th><th>Набор норм</th><th>Назначен</th></tr></thead><tbody>${normsRows}</tbody></table>`
      : '<div class="muted">Нормы не назначены.</div>';

    const dueRows = upcoming
      .map(
        (u, i) =>
          `<tr><td>${i + 1}</td><td>${e(nomName(u.nomenclatureId))}</td><td style="text-align:right;">${u.qty}</td><td>${e(fmtDate(u.lastIssuedAt))}</td><td>${e(fmtDate(u.nextDueAt))}</td><td>${e(STATUS_RU[u.status])}</td></tr>`,
      )
      .join('');
    const dueHtml = dueRows
      ? `<table><thead><tr><th>№</th><th>Позиция</th><th>Кол-во</th><th>Последняя выдача</th><th>Следующая</th><th>Состояние</th></tr></thead><tbody>${dueRows}</tbody></table>`
      : '<div class="muted">Нет назначенных норм — сроки считать не из чего.</div>';

    const absenceHtml = absences.length
      ? `<table><thead><tr><th>№</th><th>Период</th><th>Вид</th></tr></thead><tbody>${[...absences]
          .sort((a, b) => b.fromMs - a.fromMs)
          .map((a, i) => `<tr><td>${i + 1}</td><td>${e(`${fmtDate(a.fromMs)} — ${fmtDate(a.toMs)}`)}</td><td>${e(ABSENCE_KIND_RU[a.kind] ?? a.kind)}</td></tr>`)
          .join('')}</tbody></table>`
      : '<div class="muted">Отпусков нет.</div>';

    const historyHtml = card && card.entries.length
      ? `<table><thead><tr><th>№</th><th>Дата</th><th>Позиция</th><th>Кол-во</th></tr></thead><tbody>${[...card.entries]
          .sort((a, b) => b.issuedAt - a.issuedAt)
          .map((row, i) => `<tr><td>${i + 1}</td><td>${e(fmtDate(row.issuedAt))}</td><td>${e(nomName(row.nomenclatureId))}</td><td style="text-align:right;">${row.qty}</td></tr>`)
          .join('')}</tbody></table>`
      : '<div class="muted">Выдач пока не было.</div>';

    const sign = `<div style="margin-top:18px;">
  <div><b>Выдал (кладовщик):</b> ______________________ (Ф.И.О., подпись)</div>
  <div style="margin-top:10px;"><b>Получил:</b> ______________________ (Ф.И.О., подпись)</div>
</div>`;

    const sections: PrintSection[] = [
      { id: 'title', title: 'Заголовок', html: `<div style="text-align:center;font-size:18px;font-weight:700;">${e(title)}</div>`, hideTitle: true },
      { id: 'main', title: 'Сотрудник', html: head },
      { id: 'norms', title: 'Наборы норм', html: normsHtml },
      { id: 'due', title: 'Сроки следующих выдач', html: dueHtml },
      { id: 'absences', title: 'Отпуска (сдвигают сроки носки)', html: absenceHtml },
      { id: 'history', title: 'История выдач', html: historyHtml },
      { id: 'sign', title: 'Подписи', html: sign },
    ];
    return { title, sections };
  }

  function printCard() {
    const form = buildCardForm();
    openPrintPreview({
      title: form.title,
      sections: form.sections,
      printHeader: { title: form.title, meta: `Напечатано: ${formatMomentLabel(new Date())}` },
    });
  }

  async function exportCardToWord() {
    const form = buildCardForm();
    await window.matrica.exports.card({ title: form.title, fileBaseName: form.title, sections: form.sections });
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {props.onBack ? (
        <div>
          <Button variant="ghost" onClick={props.onBack}>
            ← К списку карточек
          </Button>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="ghost" onClick={() => printCard()} disabled={busy}>
          Печать
        </Button>
        <Button variant="ghost" onClick={() => void exportCardToWord()} disabled={busy}>
          В Word
        </Button>
        <MailSendButton
          subject={`Личная карточка СИЗ: ${employeeLabel}`}
          summary={[
            `Личная карточка СИЗ: ${employeeLabel}`,
            sizesSummary(sizes) ? `Размеры: ${sizesSummary(sizes)}` : 'Размеры не заполнены',
            `Позиций по нормам: ${merged.length}`,
          ]}
          body={(() => {
            const form = buildCardForm();
            return printSectionsToText(form.sections);
          })()}
          attachment={() => {
            const form = buildCardForm();
            return {
              kind: 'card',
              spec: { title: form.title, fileBaseName: form.title, sections: form.sections },
            };
          }}
        />
        {canEdit && cardMissing ? (
          <Button variant="primary" onClick={() => void openCard()} disabled={busy}>
            Завести карточку
          </Button>
        ) : null}
      </div>

      {cardMissing ? (
        <SectionCard title={`Карточка: ${employeeLabel}`}>
          <div style={{ color: 'var(--muted)' }}>
            Карточка СИЗ на этого сотрудника ещё не заведена. Её заводит первая выдача — или кнопка «Завести карточку».
          </div>
        </SectionCard>
      ) : null}

      {!card && !cardMissing ? (
        <SectionCard title="Личная карточка СИЗ">
          <div style={{ color: 'var(--muted)' }}>{busy ? 'Загружаем карточку…' : 'Карточка не найдена.'}</div>
        </SectionCard>
      ) : null}

      {card ? (
        <>
          <SectionCard title={`Карточка: ${employeeLabel}${closed ? ' (закрыта)' : ''}`}>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
              Открыта {fmtDate(card.openedAt)}
              {sizesSummary(sizes) ? ` · размеры: ${sizesSummary(sizes)}` : ' · размеры не заполнены'}
            </div>
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
                      options={normOptions
                        .filter((o) => !card.norms.some((n) => n.normSetId === o.id))
                        .map((o) => ({
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
                              return days > 0 ? <div style={{ color: 'var(--muted)', fontSize: 12 }}>+{days} дн. отпуск</div> : null;
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
              {sizesSummary(sizes) ? (
                <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>Размер сотрудника: {sizesSummary(sizes)}</div>
              ) : null}
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
                      options={merged.map((m) => ({
                        id: m.nomenclatureId,
                        label: nomName(m.nomenclatureId),
                        searchText: nomName(m.nomenclatureId),
                        ...(hintedIds.has(m.nomenclatureId) ? { hintText: 'размер сотрудника' } : {}),
                      }))}
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
      ) : null}

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)' }}>{status}</div> : null}
    </div>
  );
}
