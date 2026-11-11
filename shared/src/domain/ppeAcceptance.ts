/**
 * Журнал приёмки СИЗ: факты выдачи + контекст нормы.
 *
 * Ключевое требование владельца (05.11): «срок носки» и «количество на год» — разные
 * величины, они не должны жить в одном поле. Путаница между ними выглядит как «норма не
 * выполнена», хотя не выполнено другое. Поэтому в журнале:
 *  - «выдано» и «количество на год» — разные колонки;
 *  - «срок носки» — третья колонка, с указанием, чей это выбор (приказ или кладовщик);
 *  - единого вердикта «норма не выполнена» нет и не должно быть: невыданное количество
 *    и просроченный срок — это разные вещи, их нельзя сливать в один статус.
 */
import { wearPeriodText } from './ppe.js';
import type { PpeWearKind } from './ppe.js';

/** Факт выдачи — строка журнала без контекста нормы. */
export type PpeAcceptanceFact = {
  issuedAt: number;
  employeeId: string;
  personnelNo: string | null;
  fullName: string;
  postTitle: string | null;
  departmentName: string | null;
  nomenclatureId: string;
  itemName: string;
  /** Размер — производное от позиции (в названии номенклатуры), отдельной величиной не хранится. */
  size: string | null;
  qty: number;
  /** Основание выдачи (документ). */
  documentNo: string | null;
  /**
   * Дата возврата вещи (миграция 0126): `null` — ещё выдана. Решение владельца
   * от 09.11: дата возврата живёт в бланке выдачи и в ведомости, поэтому в ведомости
   * это отдельная колонка рядом с датой выдачи, а не подмена срока носки.
   */
  returnedAt?: number | null;
  /** Процент износа, вносит кладовщик (правило — по карточке владельца). */
  wearPercent?: number | null;
};

/** Контекст нормы по позиции: что назначено сотруднику. */
export type PpeNormContext = {
  nomenclatureId: string;
  /** Количество на год по норме. */
  qty: number;
  wearKind: PpeWearKind | null;
  wearMonths: number | null;
  /** Наименование позиции по приказу (может отличаться от номенклатуры выдачи). */
  itemName?: string | null;
};

/** Строка журнала приёмки: факт + контекст нормы. */
export type PpeJournalRow = PpeAcceptanceFact & {
  /** Количество на год по норме; `null` — позиции в норме нет (выдача сверх нормы). */
  normQty: number | null;
  /** Срок носки — отдельной величиной. */
  wearText: string;
  wearKind: PpeWearKind | null;
  wearMonths: number | null;
  /** Позиция есть в норме сотрудника. */
  inNorm: boolean;
};

/**
 * Собирает строки журнала: факт выдачи + контекст нормы по той же позиции.
 *
 * Факт без позиции в норме — не ошибка (выдали сверх нормы или по другой должности):
 * он попадает в журросвсегда, но помечается `inNorm: false`, и количество на год у него
 * пустое — сравнивать не с чем.
 */
export function buildAcceptanceJournal(
  facts: PpeAcceptanceFact[],
  context: PpeNormContext[],
): PpeJournalRow[] {
  const byPos = new Map<string, PpeNormContext>();
  for (const c of context) byPos.set(c.nomenclatureId, c);
  const rows = facts.map((f) => {
    const c = byPos.get(f.nomenclatureId);
    return {
      ...f,
      normQty: c ? c.qty : null,
      wearText: wearPeriodText(c?.wearKind ?? null, c?.wearMonths ?? null),
      wearKind: c?.wearKind ?? null,
      wearMonths: c?.wearMonths ?? null,
      inNorm: Boolean(c),
    };
  });
  // Порядок журнала: по дате выдачи, затем по сотруднику и позиции — иначе строки
  // прыгают между прогонами и сверять выдачу с нормой невозможно.
  return rows.sort(
    (a, b) =>
      a.issuedAt - b.issuedAt ||
      a.fullName.localeCompare(b.fullName, 'ru') ||
      a.itemName.localeCompare(b.itemName, 'ru'),
  );
}

/** Контекст нормы по позиции у конкретного сотрудника. */
export type PpeEmployeeNormContext = PpeNormContext & {
  employeeId: string;
};

/** Строка отчёта «невыданное за период»: две независимые величины рядом. */
export type PpeUndeliveredRow = {
  employeeId: string;
  personnelNo: string | null;
  fullName: string;
  postTitle: string | null;
  nomenclatureId: string;
  itemName: string;
  size: string | null;
  /** Количество на год по норме. */
  normQty: number;
  /** Выдано за период. */
  issuedQty: number;
  /** Невыданное количество — величина КОЛИЧЕСТВА, не срока. */
  qtyShort: number;
  /** Срок носки — величина СРОКА, не количества. */
  wearText: string;
  wearMonths: number | null;
  /** Когда пора выдавать по сроку; `null` — срока нет (меняют по износу). */
  nextDueAt: number | null;
  /** Срок просрочен — отдельный признак от невыданного количества. */
  periodOverdue: boolean;
};

/**
 * Отчёт «невыданное за период».
 *
 * Считается по нормам сотрудника: для каждой позиции — сколько выдано за период и
 * сколько положено, ПЛЮС отдельно — когда по сроку. Два вывода не сливаются:
 * невыданное количество и просроченный срок показываются разными колонками, и
 * единого статуса «норма не выполнена» здесь нет по решению владельца.
 *
 * Важно: количество сравнивается с годовой нормой, поэтому период отчёта по
 * количеству должен быть годом. Срок при этом — свой, в месяцах.
 */
export function buildUndeliveredReport(args: {
  contexts: PpeEmployeeNormContext[];
  issuedByEmployeePosition: Array<{ employeeId: string; nomenclatureId: string; qty: number }>;
  /** Выдано по сотруднику и позиции — считается на стороне клиента. */
  employeeInfo: Array<{
    employeeId: string;
    personnelNo: string | null;
    fullName: string;
    postTitle: string | null;
    itemName?: string | null;
    size?: string | null;
  }>;
  /** Когда пора выдавать по сроку (из расчёта сроков), ключ «сотрудник|позиция». */
  nextDueAt?: Map<string, number | null>;
  now: number;
}): PpeUndeliveredRow[] {
  const info = new Map(args.employeeInfo.map((i) => [i.employeeId, i]));
  const issued = new Map<string, number>();
  for (const i of args.issuedByEmployeePosition) {
    const key = `${i.employeeId}|${i.nomenclatureId}`;
    issued.set(key, (issued.get(key) ?? 0) + i.qty);
  }
  const rows: PpeUndeliveredRow[] = [];
  // Контексты приходят по (сотрудник, позиция) — они уже разнесены вызывающим кодом.
  for (const c of args.contexts) {
    const employeeId = c.employeeId;
    const meta = info.get(employeeId);
    const issuedQty = issued.get(`${employeeId}|${c.nomenclatureId}`) ?? 0;
    const nextDueAt = args.nextDueAt?.get(`${employeeId}|${c.nomenclatureId}`) ?? null;
    rows.push({
      employeeId,
      personnelNo: meta?.personnelNo ?? null,
      fullName: meta?.fullName ?? '',
      postTitle: meta?.postTitle ?? null,
      nomenclatureId: c.nomenclatureId,
      itemName: c.itemName ?? meta?.itemName ?? '',
      size: meta?.size ?? null,
      normQty: c.qty,
      issuedQty,
      qtyShort: Math.max(0, c.qty - issuedQty),
      wearText: wearPeriodText(c.wearKind, c.wearMonths),
      wearMonths: c.wearMonths,
      nextDueAt,
      periodOverdue: nextDueAt != null && nextDueAt <= args.now,
    });
  }
  return rows.sort(
    (a, b) =>
      a.fullName.localeCompare(b.fullName, 'ru') || a.itemName.localeCompare(b.itemName, 'ru'),
  );
}
