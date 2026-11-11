import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  HUMAN_LABEL_DASH,
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
  type PpeWearKind,
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
import {
  applyPrintTemplate,
  buildPrintTemplateLayout,
  parsePrintTemplateLayout,
  PPE_PRINT_FORM_KEY,
  type PpePrintTemplateLayout,
} from '../utils/ppePrintTemplate.js';
import { escapeHtml, formatMomentLabel, openPrintPreview, type PrintSection } from '../utils/printPreview.js';

type CardDto = {
  id: string;
  employeeId: string;
  openedAt: number;
  closedAt: number | null;
  norms: Array<{ normSetId: string; name: string; assignedAt: number }>;
  entries: Array<{
    id: string;
    nomenclatureId: string;
    qty: number;
    issuedAt: number;
    documentId: string | null;
    /** Возврат СИЗ (миграция 0126): дата «получил обратно», кто принял, износ. */
    returnedAt: number | null;
    returnedBy: string | null;
    wearPercent: number | null;
  }>;
};

type NormOption = { id: string; name: string; postTitle: string | null };
type IssueLine = { nomenclatureId: string; qty: string };
type AbsenceRow = { id: string; employeeId: string; fromMs: number; toMs: number; kind: string };

/**
 * Личная карточка СИЗ по форме приложения №3 приказа Минтруда 767н.
 * Реквизиты — снимок на момент выдачи: приказ (п. 12) требует зафиксировать ФИО и
 * должность так, как они были, а карточка сотрудника может измениться задним числом.
 */
type PpeEmployeeCardDto = {
  id: string;
  employeeId: string;
  fullName: string | null;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  personnelNo: string | null;
  departmentId: string | null;
  departmentName: string | null;
  occupationId: string | null;
  postTitle: string | null;
  gender: 'M' | 'F' | null;
  height: string | null;
  sizeClothes: string | null;
  sizeShoes: string | null;
  sizeGloves: string | null;
  sizeHeadgear: string | null;
  sizeRespirator: string | null;
  sizeOd: string | null;
  sizeHands: string | null;
  hireDate: number | null;
  positionChangedDate: number | null;
  occupationNotes: string | null;
  issuedBy: string | null;
  preparedBy: string | null;
  preparedAt: number | null;
};

/** Строка нормы для печати: четыре колонки формы приложения №3. */
type PpeCardNormRow = {
  /** id строки нормы — по нему кладовщик проставляет срок носки по позиции. */
  id: string;
  name: string;
  sourceLabel: string | null;
  unit: string | null;
  qty: number;
  wearKind: PpeWearKind | null;
  wearMonths: number | null;
  qtyText: string;
  /** Срок носки — отдельной величиной, с указанием, чей это выбор. */
  wearText: string;
  /** Сертификат позиции (миграция 0127): вид СИЗ. */
  certificate: string | null;
};

/**
 * Семь размеров формы приложения №3 (размер одежды, обуви, перчаток, головного убора,
 * противогаза, СИЗ ОД и СИЗ рук) + рост. Подписи — как в форме приказа.
 */
function personalCardSizeFields(pc: PpeEmployeeCardDto | null): Array<{ label: string; value: string | null }> {
  return [
    { label: 'одежды', value: pc?.sizeClothes ?? null },
    { label: 'обуви', value: pc?.sizeShoes ?? null },
    { label: 'перчаток', value: pc?.sizeGloves ?? null },
    { label: 'головного убора', value: pc?.sizeHeadgear ?? null },
    { label: 'противогаза', value: pc?.sizeRespirator ?? null },
    { label: 'СИЗ ОД', value: pc?.sizeOd ?? null },
    { label: 'СИЗ рук', value: pc?.sizeHands ?? null },
  ];
}

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
  // Возврат (миграция 0126): вещь сдали — срок от выдачи больше не значит, но норма
  // остаётся (после новой выдачи срок считается заново).
  returned: 'сдано',
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
  const [normLines, setNormLines] = useState<Array<{ nomenclatureId: string; qty: number; wearMonths: number | null; wearKind: PpeWearKind | null }>>([]);
  const [groupNormIds, setGroupNormIds] = useState<string[]>([]);
  const [absences, setAbsences] = useState<AbsenceRow[]>([]);
  const [absenceFrom, setAbsenceFrom] = useState('');
  const [absenceTo, setAbsenceTo] = useState('');
  const [nomNames, setNomNames] = useState<Map<string, string>>(new Map());
  /** Сертификат позиции (вид СИЗ) по id номенклатуры — из списка номенклатуры. */
  const [nomCertificates, setNomCertificates] = useState<Map<string, string>>(new Map());
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
  // Личная карточка СИЗ по форме приложения №3: реквизиты сотрудника и строки нормы
  // для печати. Грузится по сотруднику — сервер заводит карточку по факту и подставляет
  // значения из карточки сотрудника (ФИО, пол, рост, размеры, должность, даты).
  const [personalCard, setPersonalCard] = useState<PpeEmployeeCardDto | null>(null);
  const [personalCardRows, setPersonalCardRows] = useState<PpeCardNormRow[]>([]);
  /**
   * Черновики срока носки по позиции: id строки нормы → месяцы (пусто — срок снять).
   * У годовой нормы («1 шт.», «12 пар») срока в приказе нет — его проставляет кладовщик
   * (решение владельца от 05.11). Выводить срок из количества нельзя: это разные величины.
   */
  const [periodDrafts, setPeriodDrafts] = useState<Record<string, string>>({});
  /** Предупреждение автоподбора: профессию не опознали — кладовщик выбирает норму вручную. */
  const [postWarning, setPostWarning] = useState<string | null>(null);
  /**
   * Шаблон печатной формы (серверный): какие блоки печатать. Раньше набор колонок жил
   * в localStorage и не переезжал между машинами — теперь шаблон в БД.
   */
  const [printTemplate, setPrintTemplate] = useState<PpePrintTemplateLayout>({});

  const { confirm } = useConfirm();
  const canEdit = props.canEdit;
  /** Позиции без срока носки: годовая норма, срок проставляет кладовщик. */
  const rowsWithoutPeriod = personalCardRows.filter((r) => r.wearKind === 'annual');

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
  useLiveDataRefresh(loadEmployees, { intervalMs: 60_000, domains: ['ppe', 'warehouse', 'employees'] });

  useEffect(() => {
    void (async () => {
      const [norms, wh] = await Promise.all([
        window.matrica.ppe.norms.list().catch(() => null),
        window.matrica.warehouseLocations.list({ activeOnly: true }).catch(() => null),
      ]);
      await loadEmployees();
      if (norms?.ok) setNormOptions(norms.rows);
      if (wh?.ok) {
        setWarehouses((wh.rows ?? []).map((w: any) => ({ id: String(w.id), label: String(w.name ?? w.code ?? '') })));
      }
      const noms = await window.matrica.warehouse.nomenclatureList({ limit: 2000, offset: 0 }).catch(() => null);
      if (noms?.ok) {
        const rows = (noms.rows ?? []) as any[];
        setNomNames(new Map(rows.map((r) => [String(r.id), String(r.name ?? '')])));
        setNomCertificates(
          new Map(
            rows
              .filter((r) => String(r.certificate ?? '').trim())
              .map((r) => [String(r.id), String(r.certificate).trim()]),
          ),
        );
      }
    })();
  }, [loadEmployees]);

  // Нет названия — прочерк, а не идентификатор: эти подписи уезжают в карточку СИЗ
  // (печать и Word), а оператор читает наименование, а не `8f14e45f-…`.
  const nomName = useCallback((id: string) => nomNames.get(id) || HUMAN_LABEL_DASH, [nomNames]);
  const empName = useCallback(
    (id: string) => employees.find((e) => e.id === id)?.label || HUMAN_LABEL_DASH,
    [employees],
  );

  /**
   * Личная карточка СИЗ (форма приложения №3) + строки нормы для печати.
   * Строки берём по наборам норм карточки: сервер сам знает «приказную» строку,
   * пункт приложения, единицу измерения и количество на год.
   */
  const loadPersonalCard = useCallback(async (employeeIdArg: string, normSetIds: string[]) => {
    const res = await window.matrica.ppe.employees.card(employeeIdArg).catch(() => null);
    if (!res?.ok) {
      setPersonalCard(null);
      setPersonalCardRows([]);
      return;
    }
    setPersonalCard((res.card ?? null) as PpeEmployeeCardDto | null);
    if (normSetIds.length === 0) {
      setPersonalCardRows([]);
      return;
    }
    const rows = await window.matrica.ppe.cardNormRows({ normSetIds }).catch(() => null);
    setPersonalCardRows(rows?.ok ? ((rows.rows ?? []) as PpeCardNormRow[]) : []);
  }, []);

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
    const allLines: Array<{ nomenclatureId: string; qty: number; wearMonths: number | null; wearKind: PpeWearKind | null }> = [];
    for (const setId of setIds) {
      const det = await window.matrica.ppe.norms.get(setId).catch(() => null);
      if (det?.ok) allLines.push(...det.normSet.lines);
    }
    setNormLines(allLines);
    const personnelNo = personnelByEmployee.get(res.card.employeeId) ?? '';
    setSizes(personnelNo ? (sizesByPersonnel.get(personnelNo) ?? EMPTY_SIZES) : EMPTY_SIZES);
    await loadPersonalCard(res.card.employeeId, setIds);
  }, [personnelByEmployee, sizesByPersonnel, loadPersonalCard]);

  /**
   * Срок носки по позиции проставляет кладовщик (решение владельца от 05.11): у годовой
   * нормы («1 шт.», «12 пар») срока в приказе нет, а выводить его из количества нельзя —
   * это разные величины. Строка нормы общая для профессии, поэтому срок действует на всех
   * сотрудников этой профессии — об этом предупреждаем.
   */
  const saveWearPeriod = useCallback(
    async (row: PpeCardNormRow) => {
      const raw = (periodDrafts[row.id] ?? '').trim();
      const months = raw === '' ? null : Number(raw);
      if (months != null && (!Number.isInteger(months) || months <= 0)) {
        setStatus('Срок носки — целое число месяцев больше нуля (пусто — срок снять)');
        return;
      }
      setBusy(true);
      try {
        const res = await window.matrica.ppe.norms.setWearPeriod({ id: row.id, wearMonths: months });
        if (!res.ok) {
          setStatus(`Ошибка: ${res.error}`);
          return;
        }
        setStatus('Срок сохранён. Он действует на всех сотрудников этой профессии.');
        if (card) await loadCard(card.id);
      } finally {
        setBusy(false);
      }
    },
    [periodDrafts, card, loadCard],
  );

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
        // Личная карточка по форме приложения №3 заводится по факту — её реквизиты
        // нужны кладовщику и без открытой карточки выдачи.
        await loadPersonalCard(employeeId, []);
        return;
      }
      await loadCard(res.card.id);
    } finally {
      setBusy(false);
    }
  }, [employeeId, loadCard, personnelByEmployee, sizesByPersonnel, loadPersonalCard]);

  useEffect(() => {
    void findCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- карточка перечитывается при смене сотрудника и после первого прихода справочника: findCard зависит от карт размеров, которые приезжают позже
  }, [employeeId, personnelByEmployee.size]);

  /**
   * Шаблон печатной формы — с сервера. Личный шаблон перекрывает общий по ключу формы,
   * поэтому берём первый подходящий: сервер отдаёт сначала личные.
   */
  const loadPrintTemplate = useCallback(async () => {
    const res = await window.matrica.ppe.printTemplates.list({ formKey: PPE_PRINT_FORM_KEY }).catch(() => null);
    if (!res?.ok || !Array.isArray(res.rows) || res.rows.length === 0) {
      setPrintTemplate({});
      return;
    }
    const def = res.rows.find((r) => r.isDefault) ?? res.rows[0];
    setPrintTemplate(parsePrintTemplateLayout(def?.layoutJson));
  }, []);

  useEffect(() => {
    void loadPrintTemplate();
  }, [loadPrintTemplate]);

  /** Сохранение текущего набора блоков как личного шаблона печати. */
  async function savePrintTemplate() {
    const form = buildPersonalCardForm();
    const layout = buildPrintTemplateLayout({ sections: form.sections });
    const res = await window.matrica.ppe.printTemplates.save({
      formKey: PPE_PRINT_FORM_KEY,
      name: `Личная карточка СИЗ (${employeeLabel})`,
      layoutJson: JSON.stringify(layout),
    });
    if (!res.ok) {
      setStatus(`Ошибка сохранения шаблона: ${res.error}`);
      return;
    }
    setStatus('Шаблон печати сохранён');
    await loadPrintTemplate();
  }

  /**
   * Назначение норм по должности: сервер сопоставляет должность сотрудника с
   * профессией приказа и отдаёт наборы норм (основной и зимний 766н). Дальше —
   * обычное назначение наборов на карточку выдачи.
   */
  async function assignNormsByPost() {
    const postTitle = (personalCard?.postTitle ?? '').trim();
    if (!postTitle) {
      setPostWarning('Должность сотрудника не заполнена — норму выберите вручную');
      return;
    }
    setBusy(true);
    setPostWarning(null);
    try {
      const res = await window.matrica.ppe.normsByPost({ postTitle });
      if (!res.ok) {
        setPostWarning(`Ошибка: ${res.error}`);
        return;
      }
      if (!res.occupation || res.normSetIds.length === 0) {
        setPostWarning(res.warning ?? 'Профессия не найдена в справочнике приказа — норму выберите вручную');
        return;
      }
      // Карточки выдачи может ещё не быть — заводим её сами: кладовщику не нужно
      // сначала «Завести карточку», а потом ещё раз назначать нормы.
      let cardId = card?.id ?? null;
      if (!cardId) {
        const opened = await window.matrica.ppe.cards.open({ employeeId });
        if (!opened.ok) {
          setPostWarning(`Не удалось завести карточку выдачи: ${opened.error}`);
          return;
        }
        cardId = opened.id;
      }
      const already = new Set((card?.norms ?? []).map((n) => n.normSetId));
      const toAdd = res.normSetIds.filter((id) => !already.has(id));
      if (toAdd.length === 0) {
        setStatus('Нормы по этой должности уже назначены');
        await loadCard(cardId);
        return;
      }
      const assigned = await window.matrica.ppe.cards.assignNorms({
        cardId,
        normSetIds: [...already, ...toAdd],
      });
      if (!assigned.ok) {
        setPostWarning(`Ошибка: ${assigned.error}`);
        return;
      }
      setStatus(`Назначено наборов норм: ${toAdd.length}`);
      await loadCard(cardId);
    } finally {
      setBusy(false);
    }
  }

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
        normLines.map((l) => ({ normSetId: '', nomenclatureId: l.nomenclatureId, qty: l.qty, wearMonths: l.wearMonths, wearKind: l.wearKind })),
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
   * Отметка «получил обратно» (миграция 0126).
   *
   * Правило владельца (09.11.2026): отработал меньше года → спецодежда подлежит
   * возврату; уволился → сдал. Кладовщик отмечает, кладовщик же и снимает отметку.
   * Возврат не отменяет выдачу и не трогает норму: после новой выдачи срок носки
   * считается заново от новой даты.
   */
  async function markReturned(entryId: string) {
    if (!card) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.issueEntries.markReturned({ entryId });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setStatus('Отмечено: вещь получена обратно');
      await loadCard(card.id);
    } finally {
      setBusy(false);
    }
  }

  async function undoReturn(entryId: string) {
    if (!card) return;
    const ok = await confirm({
      title: 'Снять отметку о возврате?',
      detail: 'Позиция снова числится выданной: срок носки продолжит идти от даты выдачи.',
      confirmLabel: 'Снять отметку',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.issueEntries.undoReturn({ entryId });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setStatus('Отметка о возврате снята');
      await loadCard(card.id);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Печатная форма личной карточки по форме приложения №3 приказа Минтруда 767н.
   *
   * Отдельная от рабочей карточки выдачи: в форме приказа нет истории выдач и сроков —
   * там реквизиты сотрудника и таблица норм. История выдач оставлена ОТДЕЛЬНОЙ
   * секцией и по умолчанию ВЫКЛЮЧЕНА: по умолчанию лист совпадает с формой приказа.
   *
   * Собирается здесь, а не в JSX: печать и Word обязаны показать один и тот же лист.
   */
  function buildPersonalCardForm() {
    const e = (v: unknown) => escapeHtml(String(v ?? ''));
    const pc = personalCard;
    const title = 'ЛИЧНАЯ КАРТОЧКА № ____ учета выдачи средств индивидуальной защиты';
    const val = (v: string | null | undefined): string => (v && String(v).trim() ? e(v) : '—');

    // Реквизиты формы приложения №3: левый столбец — ФИО и должность, правый — пол,
    // рост и семь размеров.
    const requisitesHtml = `<table><tbody>
      <tr>
        <td style="vertical-align:top;width:58%;">
          <table><tbody>
            <tr><th style="text-align:left;white-space:nowrap;">Фамилия</th><td>${val(pc?.lastName)}</td></tr>
            <tr><th style="text-align:left;white-space:nowrap;">Имя</th><td>${val(pc?.firstName)}</td></tr>
            <tr><th style="text-align:left;white-space:nowrap;">Отчество</th><td>${val(pc?.middleName)}</td></tr>
            <tr><th style="text-align:left;white-space:nowrap;">Табельный номер</th><td>${val(pc?.personnelNo)}</td></tr>
            <tr><th style="text-align:left;white-space:nowrap;">Структурное подразделение</th><td>${val(pc?.departmentName)}</td></tr>
            <tr><th style="text-align:left;white-space:nowrap;">Профессия (должность)</th><td>${val(pc?.postTitle)}</td></tr>
            <tr><th style="text-align:left;white-space:nowrap;">Дата поступления на работу</th><td>${val(fmtDate(pc?.hireDate ?? null))}</td></tr>
            <tr><th style="text-align:left;">Дата изменения профессии (должности) или переводе в другое структурное подразделение</th><td>${val(fmtDate(pc?.positionChangedDate ?? null))}</td></tr>
          </tbody></table>
        </td>
        <td style="vertical-align:top;">
          <table><tbody>
            <tr><th style="text-align:left;white-space:nowrap;">Пол</th><td>${val(pc?.gender === 'M' ? 'М' : pc?.gender === 'F' ? 'Ж' : null)}</td></tr>
            <tr><th style="text-align:left;white-space:nowrap;">Рост</th><td>${val(pc?.height)}</td></tr>
            <tr><th style="text-align:left;">Размер</th><td>
              <table><tbody>
                <tr><td>одежды</td><td>${val(pc?.sizeClothes)}</td><td>обуви</td><td>${val(pc?.sizeShoes)}</td></tr>
                <tr><td>перчаток</td><td>${val(pc?.sizeGloves)}</td><td>головного убора</td><td>${val(pc?.sizeHeadgear)}</td></tr>
                <tr><td>противогаза</td><td>${val(pc?.sizeRespirator)}</td><td>СИЗ ОД</td><td>${val(pc?.sizeOd)}</td></tr>
                <tr><td>СИЗ рук</td><td>${val(pc?.sizeHands)}</td><td></td><td></td></tr>
              </tbody></table>
            </td></tr>
          </tbody></table>
        </td>
      </tr>
    </tbody></table>`;

    // Таблица норм формы приложения №3: наименование СИЗ, пункт ТОН, единица, количество.
    const normRows = personalCardRows
      .map(
        (r, i) =>
          `<tr><td style="text-align:right;">${i + 1}</td><td>${e(r.name)}</td><td>${val(r.sourceLabel)}</td><td>${val(r.unit)}</td><td style="text-align:right;">${e(r.qtyText)}</td><td>${val(r.certificate)}</td></tr>`,
      )
      .join('');
    // Сертификат — дополнительная колонка к форме приложения №3: в приказной форме её
    // нет, но решение владельца от 09.11 требует, чтобы «свой сертификат» был виден
    // на бланке выдачи.
    const normsHtml = normRows
      ? `<table><thead><tr><th>№</th><th style="text-align:left;">Наименование средств индивидуальной защиты</th><th style="text-align:left;">Пункт типовых отраслевых норм</th><th style="text-align:left;">Единица измерения</th><th style="text-align:right;">Количество на год</th><th style="text-align:left;">Сертификат</th></tr></thead><tbody>${normRows}</tbody></table>`
      : '<div class="muted">Нормы не назначены.</div>';

    // История выдач — по умолчанию выключена (в форме приказа её нет).
    // Дата возврата («получил обратно», миграция 0126) — в этой же строке: решение
    // владельца от 09.11 — дата возврата живёт в бланке выдачи и в ведомости.
    const historyRows = (card?.entries ?? [])
      .slice()
      .sort((a, b) => b.issuedAt - a.issuedAt)
      .map(
        (row, i) =>
          `<tr><td style="text-align:right;">${i + 1}</td><td>${e(fmtDate(row.issuedAt))}</td><td>${e(nomName(row.nomenclatureId))}</td><td style="text-align:right;">${row.qty}</td><td>${e(fmtDate(row.returnedAt ?? null))}</td><td style="text-align:right;">${row.wearPercent == null ? '—' : e(row.wearPercent)}</td></tr>`,
      )
      .join('');
    const historyHtml = historyRows
      ? `<table><thead><tr><th>№</th><th style="text-align:left;">Дата</th><th style="text-align:left;">Позиция</th><th style="text-align:right;">Кол-во</th><th style="text-align:left;">Дата возврата</th><th style="text-align:right;">Износ, %</th></tr></thead><tbody>${historyRows}</tbody></table>`
      : '<div class="muted">Выдач пока не было.</div>';

    const sign = `<div style="margin-top:18px;">
  <div><b>Разработал: Специалист по ОТ</b> ______________________ (Ф.И.О., должность) ______________________ (подпись)</div>
  <div style="margin-top:10px;"><b>Выдал (кладовщик):</b> ______________________ (Ф.И.О., подпись)</div>
  <div style="margin-top:10px;"><b>Получил:</b> ______________________ (Ф.И.О., подпись)</div>
</div>`;

    const sections: PrintSection[] = [
      { id: 'title', title: 'Заголовок', html: `<div style="text-align:center;font-size:16px;font-weight:700;">${e(title)}</div>`, hideTitle: true },
      { id: 'requisites', title: 'Реквизиты', html: requisitesHtml },
      { id: 'norms', title: 'Нормы', html: normsHtml },
      { id: 'history', title: 'История выдач', html: historyHtml, checked: false },
      { id: 'sign', title: 'Подписи', html: sign },
    ];
    // Шаблон печати снимает выключенные блоки; порядок остаётся приказным.
    return { title, sections: applyPrintTemplate(sections, printTemplate) };
  }

  function printPersonalCard() {
    const form = buildPersonalCardForm();
    openPrintPreview({
      title: form.title,
      sections: form.sections,
      printHeader: {
        title: form.title,
        // Заголовок формы уже есть отдельной секцией — иначе печатается дважды.
        hideTitle: true,
        meta: `Напечатано: ${formatMomentLabel(new Date())}`,
        ...(printTemplate.headerNote ? { lines: [printTemplate.headerNote] } : {}),
      },
    });
  }

  async function exportPersonalCardToWord() {
    const form = buildPersonalCardForm();
    await window.matrica.exports.card({ title: form.title, fileBaseName: 'Личная карточка СИЗ', sections: form.sections });
  }

  /**
   * Выгрузка для 1С: файл по фиксированной структуре, который забирает бухгалтер.
   * Формат — Excel (по умолчанию) и CSV.
   */
  async function exportOneC(kind: 'norms' | 'issues') {
    setBusy(true);
    try {
      const res = await window.matrica.ppe.oneCExport({
        kind,
        format: 'xlsx',
        period: fmtDate(new Date().getTime()),
        who: employeeLabel,
      });
      if (!res.ok) setStatus(`Ошибка выгрузки: ${res.error}`);
      else setStatus(`Выгружено: ${res.name}`);
    } finally {
      setBusy(false);
    }
  }

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
          `<tr><td>${(card?.norms.length ?? 0) + gi + 1}</td><td>${e(normOptions.find((o) => o.id === id)?.name ?? HUMAN_LABEL_DASH)} (от группы)</td><td>—</td></tr>`,
      ),
    ].join('');
    const normsHtml = normsRows
      ? `<table><thead><tr><th>№</th><th>Набор норм</th><th>Назначен</th></tr></thead><tbody>${normsRows}</tbody></table>`
      : '<div class="muted">Нормы не назначены.</div>';

    const dueRows = upcoming
      .map(
        (u, i) =>
          `<tr><td>${i + 1}</td><td>${e(nomName(u.nomenclatureId))}</td><td>${e(nomCertificates.get(u.nomenclatureId) ?? '—')}</td><td style="text-align:right;">${u.qty}</td><td>${e(fmtDate(u.lastIssuedAt))}</td><td>${e(fmtDate(u.nextDueAt))}</td><td>${e(STATUS_RU[u.status])}</td></tr>`,
      )
      .join('');
    const dueHtml = dueRows
      ? `<table><thead><tr><th>№</th><th>Позиция</th><th>Сертификат</th><th>Кол-во</th><th>Последняя выдача</th><th>Следующая</th><th>Состояние</th></tr></thead><tbody>${dueRows}</tbody></table>`
      : '<div class="muted">Нет назначенных норм — сроки считать не из чего.</div>';

    const absenceHtml = absences.length
      ? `<table><thead><tr><th>№</th><th>Период</th><th>Вид</th></tr></thead><tbody>${[...absences]
          .sort((a, b) => b.fromMs - a.fromMs)
          .map((a, i) => `<tr><td>${i + 1}</td><td>${e(`${fmtDate(a.fromMs)} — ${fmtDate(a.toMs)}`)}</td><td>${e(ABSENCE_KIND_RU[a.kind] ?? a.kind)}</td></tr>`)
          .join('')}</tbody></table>`
      : '<div class="muted">Отпусков нет.</div>';

    const historyHtml = card && card.entries.length
      ? `<table><thead><tr><th>№</th><th>Дата</th><th>Позиция</th><th>Кол-во</th><th>Дата возврата</th><th>Износ, %</th></tr></thead><tbody>${[...card.entries]
          .sort((a, b) => b.issuedAt - a.issuedAt)
          .map((row, i) => `<tr><td>${i + 1}</td><td>${e(fmtDate(row.issuedAt))}</td><td>${e(nomName(row.nomenclatureId))}</td><td style="text-align:right;">${row.qty}</td><td>${e(fmtDate(row.returnedAt ?? null))}</td><td style="text-align:right;">${row.wearPercent == null ? '—' : e(row.wearPercent)}</td></tr>`)
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
        <Button variant="ghost" onClick={() => printPersonalCard()} disabled={busy}>
          Печать по форме приказа
        </Button>
        <Button variant="ghost" onClick={() => void exportPersonalCardToWord()} disabled={busy}>
          Форма приказа в Word
        </Button>
        <Button variant="ghost" onClick={() => void exportOneC('norms')} disabled={busy}>
          Выгрузка для 1С (нормы)
        </Button>
        <Button variant="ghost" onClick={() => void exportOneC('issues')} disabled={busy}>
          Выгрузка для 1С (выдача)
        </Button>
        {canEdit ? (
          <Button variant="ghost" onClick={() => void savePrintTemplate()} disabled={busy}>
            Сохранить шаблон печати
          </Button>
        ) : null}
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

      {/*
        Личная карточка по форме приложения №3 — самостоятельный документ, а не часть
        карточки выдачи: показываем её ВСЕГДА, даже если выдачи ещё не было (иначе
        кладовщик не увидит форму, за которую отвечает). Назначение норм по должности
        требует карточки выдачи — без неё кнопка объясняет, что делать.
      */}
      <SectionCard title="Личная карточка СИЗ (форма приложения №3)">
        {personalCard ? (
          <>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
              Реквизиты подставляются из карточки сотрудника. Фамилия, имя и отчество — по частям, как в форме
              приказа; недостающие размеры дописывает кладовщик.
            </div>
            <table className="table" style={{ width: '100%' }}>
              <tbody>
                <tr>
                  <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>Фамилия, имя, отчество</th>
                  <td>
                    {[personalCard.lastName, personalCard.firstName, personalCard.middleName]
                      .filter(Boolean)
                      .join(' ') || '—'}
                  </td>
                  <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>Табельный номер</th>
                  <td>{personalCard.personnelNo || '—'}</td>
                </tr>
                <tr>
                  <th style={{ textAlign: 'left' }}>Структурное подразделение</th>
                  <td>{personalCard.departmentName || '—'}</td>
                  <th style={{ textAlign: 'left' }}>Профессия (должность)</th>
                  <td>{personalCard.postTitle || '—'}</td>
                </tr>
                <tr>
                  <th style={{ textAlign: 'left' }}>Пол</th>
                  <td>{personalCard.gender === 'M' ? 'М' : personalCard.gender === 'F' ? 'Ж' : '—'}</td>
                  <th style={{ textAlign: 'left' }}>Рост</th>
                  <td>{personalCard.height || '—'}</td>
                </tr>
                <tr>
                  <th style={{ textAlign: 'left' }}>Размеры</th>
                  <td colSpan={3}>
                    {personalCardSizeFields(personalCard).map(({ label, value }) => (
                      <span key={label} style={{ marginRight: 14 }}>
                        {label}: {value || '—'}
                      </span>
                    ))}
                  </td>
                </tr>
                <tr>
                  <th style={{ textAlign: 'left' }}>Дата поступления на работу</th>
                  <td>{fmtDate(personalCard.hireDate)}</td>
                  <th style={{ textAlign: 'left' }}>Дата изменения профессии (должности) или перевода</th>
                  <td>{fmtDate(personalCard.positionChangedDate)}</td>
                </tr>
              </tbody>
            </table>
            {canEdit ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                <Button variant="primary" onClick={() => void assignNormsByPost()} disabled={busy}>
                  Назначить нормы по должности
                </Button>
              </div>
            ) : null}
            {postWarning ? (
              <div style={{ color: 'var(--warn, #b45309)', fontSize: 12, marginTop: 8 }}>{postWarning}</div>
            ) : null}
          </>
        ) : (
          <div style={{ color: 'var(--muted)' }}>
            {busy ? 'Загружаем личную карточку…' : 'Личная карточка не заведена.'}
          </div>
        )}
      </SectionCard>

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
                        {u.lastIssuedAt != null && u.nextDueAt != null && u.wearMonths != null
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

          <SectionCard title="Сроки носки по позициям">
            {rowsWithoutPeriod.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>
                Незаданных сроков нет: у всех позиций срок либо задан приказом, либо проставлен кладовщиком.
              </div>
            ) : (
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Позиция</th>
                    <th style={{ textAlign: 'right' }}>Кол-во на год</th>
                    <th style={{ width: 140 }}>Срок носки, мес.</th>
                    <th style={{ width: 120 }} />
                  </tr>
                </thead>
                <tbody>
                  {rowsWithoutPeriod.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td style={{ textAlign: 'right' }}>{r.qtyText}</td>
                      <td>
                        <Input
                          type="number"
                          min={1}
                          placeholder="мес."
                          value={periodDrafts[r.id] ?? ''}
                          onChange={(e) => setPeriodDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        />
                      </td>
                      <td>
                        <Button onClick={() => void saveWearPeriod(r)} disabled={busy}>
                          Сохранить
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 12 }}>
              Срок проставляет кладовщик: в приказе у годовой нормы («1 шт.», «12 пар») срока нет, а выводить
              его из количества нельзя — «срок носки» и «количество на год» это разные величины. Срок действует
              на всех сотрудников профессии.
            </div>
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
                <Button variant="primary" style={{ justifySelf: 'start' }} onClick={() => void addAbsence()} disabled={busy}>
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
                      <th>Дата возврата</th>
                      <th style={{ textAlign: 'right' }}>Износ, %</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {[...card.entries].sort((a, b) => b.issuedAt - a.issuedAt).map((e, i) => (
                      <tr key={e.id}>
                        <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                        <td>{fmtDate(e.issuedAt)}</td>
                        <td>{nomName(e.nomenclatureId)}</td>
                        <td style={{ textAlign: 'right' }}>{e.qty}</td>
                        <td>{fmtDate(e.returnedAt ?? null)}</td>
                        <td style={{ textAlign: 'right' }}>{e.wearPercent ?? '—'}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {props.canEdit ? (
                            e.returnedAt == null ? (
                              <Button variant="ghost" onClick={() => void markReturned(e.id)} disabled={busy}>
                                Получил обратно
                              </Button>
                            ) : (
                              <Button variant="ghost" onClick={() => void undoReturn(e.id)} disabled={busy}>
                                Снять отметку
                              </Button>
                            )
                          ) : null}
                        </td>
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
