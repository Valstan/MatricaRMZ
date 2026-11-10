// Очередь рекламаций двигателя: заезды по рекламации и их порядок.
//
// ПРОБЛЕМА (владелец 10.11.2026). Рекламация жила одним набором EAV-атрибутов
// карточки (`reclamation_flag`, `reclamation_accepted_date`, `reclamation_shipped_date`,
// …) — то есть рекламация могла быть только ОДНА. А двигатель может вернуться по
// рекламации несколько раз: первый заезд — основной цикл, второй — рекламация №1,
// третий — рекламация №2. И даты этих заездов не должны пересекаться: приехал по
// рекламации — значит, предыдущий заезд уже закрыт отгрузкой.
//
// ПРАВИЛО (порядок заездов):
//  · заезд №1 — основной цикл карточки (приход на завод → отправка заказчику);
//  · заезд №2 — рекламация №1, заезд №3 — рекламация №2 и так далее;
//  · дата приёма по рекламации не может быть раньше даты отправки предыдущего
//    заезда, а отгрузка из вкладки «Основное» не может быть позже прихода по
//    рекламации — иначе двигатель «уехал» бы раньше, чем приехал снова.
//
// Хранение — отдельная строгая таблица `erp_engine_reclamations` (EAV под заморозкой,
// AGENTS.md §EAV), одна строка — один заезд по рекламации.

/** Одна рекламация (один заезд по рекламации) — как её видит клиент. */
export type EngineReclamationDto = {
  id: string;
  /** Двигатель (uuid карточки). */
  engineId: string;
  /** Порядок в очереди: 1, 2, 3 … Основной цикл — заезд №1, рекламация №1 — заезд №2. */
  queueNo: number;
  /** Дата приёма по рекламации (мс). */
  acceptedAt: number | null;
  /** Дата отправки заказчику после рекламации (мс). */
  shippedAt: number | null;
  /** Описание дефекта изделия (что заявил заказчик). */
  customerReason: string | null;
  /** Фактически установленный дефект (что увидели при разборе). */
  actualDefect: string | null;
  /** Установленный характер дефекта. */
  defectNature: string | null;
  /** Номер акта исследования. */
  actNumber: string | null;
  /** Дата акта исследования (мс). */
  actDate: number | null;
  /** Комментарий по рекламации. */
  comment: string | null;
};

export type EngineReclamationInput = {
  id?: string | null | undefined;
  queueNo?: number | undefined;
  acceptedAt?: number | null | undefined;
  shippedAt?: number | null | undefined;
  customerReason?: string | null | undefined;
  actualDefect?: string | null | undefined;
  defectNature?: string | null | undefined;
  actNumber?: string | null | undefined;
  actDate?: number | null | undefined;
  comment?: string | null | undefined;
};

function ms(value: number | null | undefined): number | null {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function text(value: string | null | undefined): string | null {
  const t = String(value ?? '').trim();
  return t ? t : null;
}

/**
 * Очередь рекламаций по порядку: сортировка по номеру очереди.
 *
 * Номера могут прийти не по порядку (журнал доставляет строки как попало) — порядок
 * задаёт именно `queue_no`, а не позиция в массиве.
 */
export function sortEngineReclamations(rows: readonly EngineReclamationDto[]): EngineReclamationDto[] {
  return [...rows].sort((a, b) => Number(a.queueNo ?? 0) - Number(b.queueNo ?? 0));
}

/**
 * Проверка очереди рекламаций: номера без пропусков и даты заездов по порядку.
 *
 * Возвращает текст ошибки (по-русски, для оператора) или null — если всё в порядке.
 * Гейт строгий: путаница в заездах ломает учёт (двигатель «уехал» раньше, чем
 * приехал снова), поэтому молчать здесь нельзя.
 */
export function validateEngineReclamationQueue(args: {
  rows: readonly EngineReclamationInput[];
  /** Дата прихода по основному циклу (вкладка «Основное»). */
  mainArrivalDate?: number | null | undefined;
  /** Дата отгрузки по основному циклу (вкладка «Основное»). */
  mainShippingDate?: number | null | undefined;
}): string | null {
  const rows = [...args.rows];

  const mainArrival = ms(args.mainArrivalDate);
  const mainShipping = ms(args.mainShippingDate);
  if (mainArrival != null && mainShipping != null && mainShipping < mainArrival) {
    return 'Отгрузка по основному циклу раньше прихода — проверьте даты на вкладке «Основное».';
  }

  if (rows.length === 0) return null;

  const queueNos = rows.map((r) => Number(r.queueNo ?? 0));
  for (const no of queueNos) {
    if (!Number.isFinite(no) || no <= 0) return 'Номер рекламации должен быть положительным числом.';
  }
  const sorted = [...queueNos].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i + 1) {
      return `Номера рекламаций должны идти подряд с первой: нет рекламации №${i + 1}.`;
    }
  }

  const byNo = new Map(rows.map((r) => [Number(r.queueNo ?? 0), r]));
  let previousDeparture = mainShipping;
  let previousLabel = 'основного цикла';
  for (let no = 1; no <= rows.length; no += 1) {
    const row = byNo.get(no);
    if (!row) continue;
    const accepted = ms(row.acceptedAt);
    const shipped = ms(row.shippedAt);
    if (accepted != null && shipped != null && shipped < accepted) {
      return `Рекламация №${no}: отправка раньше приёма.`;
    }
    if (accepted != null && previousDeparture != null && accepted < previousDeparture) {
      return `Рекламация №${no}: приём раньше отгрузки ${previousLabel} (${formatQueueDate(previousDeparture)}). Заезды должны идти друг за дружкой.`;
    }
    if (shipped != null) {
      previousDeparture = shipped;
      previousLabel = `рекламации №${no}`;
    }
  }
  return null;
}

/** Дата в формате ДД.ММ.ГГГГ — для текста ошибки. */
export function formatQueueDate(msValue: number): string {
  const d = new Date(msValue);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Заезды двигателя по порядку: основной цикл и рекламации следом.
 *
 * Это то, что показывается в истории двигателя: «приехал → уехал» по заездам,
 * без пересечений и с рекламациями в своём порядке.
 */
export type EngineVisit = {
  /** Номер заезда: 1 — основной цикл, 2 и далее — рекламации. */
  visitNo: number;
  /** Рекламация, породившая заезд (null — основной цикл). */
  reclamation: EngineReclamationDto | null;
  /** Дата прихода (мс). */
  arrivalDate: number | null;
  /** Дата отгрузки (мс). */
  shippingDate: number | null;
  /** Подпись заезда для истории. */
  label: string;
};

export function buildEngineVisits(args: {
  mainArrivalDate?: number | null | undefined;
  mainShippingDate?: number | null | undefined;
  reclamations?: readonly EngineReclamationDto[] | null | undefined;
}): EngineVisit[] {
  const visits: EngineVisit[] = [];
  const mainArrival = ms(args.mainArrivalDate);
  const mainShipping = ms(args.mainShippingDate);
  if (mainArrival != null || mainShipping != null) {
    visits.push({
      visitNo: 1,
      reclamation: null,
      arrivalDate: mainArrival,
      shippingDate: mainShipping,
      label: 'Основной цикл',
    });
  }
  const queue = sortEngineReclamations(args.reclamations ?? []);
  for (const reclamation of queue) {
    visits.push({
      visitNo: visits.length + 1,
      reclamation,
      arrivalDate: ms(reclamation.acceptedAt),
      shippingDate: ms(reclamation.shippedAt),
      label: `Рекламация №${reclamation.queueNo}`,
    });
  }
  return visits;
}

/**
 * Подпись заезда для истории двигателя: «Приём по рекламации №1» / «Отправка по
 * рекламации №1» — заезды видны по порядку, включая рекламации (владелец
 * 10.11.2026: «чтоб мы видели, что там с ним происходило, по порядку, в том числе
 * и рекламации»).
 */
export function engineReclamationHistoryLines(reclamation: EngineReclamationDto): string[] {
  const lines: string[] = [];
  const accepted = ms(reclamation.acceptedAt);
  const shipped = ms(reclamation.shippedAt);
  if (accepted != null) lines.push(`Приём по рекламации №${reclamation.queueNo} — ${formatQueueDate(accepted)}`);
  if (shipped != null) lines.push(`Отправка по рекламации №${reclamation.queueNo} — ${formatQueueDate(shipped)}`);
  const nature = text(reclamation.defectNature);
  if (nature) lines.push(`Характер дефекта: ${nature}`);
  const act = text(reclamation.actNumber);
  if (act) lines.push(`Акт исследования: ${act}`);
  return lines;
}
