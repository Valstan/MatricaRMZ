/**
 * Что считать «застрявшей» неотправленной строкой.
 *
 * Зачем: инцидент 16.11.2026 — клиент держал 617 строк `attribute_values` в `pending`
 * неделями. Они не уходили на сервер, оператор об этом не знал, а серверное автолечение
 * упиралось в дневной бюджет и скипалось молча. Сторож нужен с обеих сторон: клиент
 * показывает оператору «застряло», сервер — владельцу.
 *
 * Порог 15 минут: синк у клиента ходит раз в минуту и будится немедленно на своей
 * правке, поэтому неотправленная строка старше 15 минут — это уже не «в пути».
 */

/** Порог «застряло», минут. */
export const STUCK_PENDING_MINUTES = 15;

/** Порог «застряло», мс. */
export const STUCK_PENDING_MS = STUCK_PENDING_MINUTES * 60_000;

export type StuckPendingSummary = {
  /** Сколько строк висит в `pending`/`error` дольше порога. */
  count: number;
  /** Когда застряла самая старая из них (unix-мс); `null` — застрявших нет. */
  oldestPendingAt: number | null;
  /** Порог, по которому считалось (минуты) — подпись в UI рисует именно его. */
  thresholdMinutes: number;
  /**
   * Потабличный разбор — по нему видно, ЧТО именно не уходит (нужно для отчёта
   * администратору). Необязателен: старый воркер шлёт сводку без него.
   */
  byTable?: StuckPendingTableStat[];
};

/** Момент, раньше которого неотправленная строка считается застрявшей. */
export function stuckPendingCutoff(now: number, minutes: number = STUCK_PENDING_MINUTES): number {
  return now - Math.max(1, Math.floor(minutes)) * 60_000;
}

/**
 * Застряла ли строка. `updated_at` — время последней правки строки: пока строка висит
 * и не уезжает, её никто не трогает, поэтому оно и есть «с какого момента зависла».
 */
export function isStuckPending(
  updatedAt: number | null | undefined,
  now: number,
  minutes: number = STUCK_PENDING_MINUTES,
): boolean {
  if (updatedAt == null) return false;
  const ts = Number(updatedAt);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return ts < stuckPendingCutoff(now, minutes);
}

export function emptyStuckPendingSummary(minutes: number = STUCK_PENDING_MINUTES): StuckPendingSummary {
  return { count: 0, oldestPendingAt: null, thresholdMinutes: minutes };
}

/** Возраст самой старой застрявшей строки в минутах; меньше минуты округляем вверх до 1. */
export function stuckAgeMinutes(oldestPendingAt: number | null, now: number): number {
  if (oldestPendingAt == null) return 0;
  const diff = now - Number(oldestPendingAt);
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return Math.max(1, Math.ceil(diff / 60_000));
}

/** Разбор застрявших строк по таблицам — часть отчёта администратору. */
export type StuckPendingTableStat = {
  /** Таблица реплики, в которой строки висят (`attribute_values`, `entities`, …). */
  table: string;
  /** Сколько строк застряло в этой таблице. */
  n: number;
  /** Когда застряла самая старая из них (unix-мс). */
  oldestPendingAt: number | null;
};

/**
 * Отчёт о застрявшей очереди — то, что уходит администратору (в чат программы, в
 * Telegram, в МАКС). Один тип на все каналы: текст собирается один раз, чтобы
 * каналы не расходились в числах.
 */
export type StuckPendingReport = {
  /** Всего застрявших строк. */
  count: number;
  /** Когда застряла самая старая (unix-мс). */
  oldestPendingAt: number | null;
  /** Порог, по которому считалось (минуты). */
  thresholdMinutes: number;
  /** Потабличный разбор — по нему видно, ЧТО именно не уходит. */
  byTable: StuckPendingTableStat[];
  /** Последняя ошибка синка на машине — причина, по которой строки не ушли. */
  lastError?: string | null;
  /** Когда был последний успешный синк (unix-мс). */
  lastSyncAt?: number | null;
};

/** Кто сообщил: логин оператора и его ФИО (ФИО подставляет сервер — на клиенте его нет). */
export type StuckPendingOperator = {
  username?: string | null;
  fullName?: string | null;
  position?: string | null;
};

/** Откуда пришёл отчёт: машина сама (авто) или оператор нажал кнопку. */
export type StuckPendingTrigger = 'auto' | 'manual';

const REPORT_TZ = 'Europe/Moscow';

function reportDateTime(ms: number | null | undefined): string {
  const ts = Number(ms);
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  try {
    return new Date(ts).toLocaleString('ru-RU', { timeZone: REPORT_TZ });
  } catch {
    return new Date(ts).toISOString();
  }
}

function reportOperator(op: StuckPendingOperator | null | undefined): string {
  const username = String(op?.username ?? '').trim();
  const fullName = String(op?.fullName ?? '').trim();
  const position = String(op?.position ?? '').trim();
  const who = fullName || username || 'оператор неизвестен';
  const tail = [username && fullName && username !== fullName ? `(${username})` : '', position].filter(Boolean).join(', ');
  return tail ? `${who} — ${tail}` : who;
}

/**
 * Текст отчёта для администратора. Один и тот же уходит в чат программы, в Telegram и
 * в МАКС: расхождение чисел между каналами путает («в чате 617, в телеге 600»).
 *
 * Что в отчёте и почему: машина (где случилось), время (когда и как долго), оператор
 * (кто работал в этот момент), потабличный разбор (что именно не уходит), последняя
 * ошибка синка (причина) и версия программы (с ней понятно, старая ли это сборка).
 */
export function formatStuckPendingReport(args: {
  clientId: string;
  /** Человеческое имя машины (если сервер его знает). */
  clientName?: string | null;
  operator?: StuckPendingOperator | null;
  stuck: StuckPendingReport;
  /** Когда отчёт снят (unix-мс). */
  detectedAt?: number;
  trigger?: StuckPendingTrigger;
  appVersion?: string | null;
}): string {
  const stuck = args.stuck;
  const now = Number(args.detectedAt ?? Date.now());
  const ageMin = stuckAgeMinutes(stuck.oldestPendingAt, now);
  const clientId = String(args.clientId ?? '').trim() || 'клиент неизвестен';
  const clientName = String(args.clientName ?? '').trim();
  const lines: string[] = [];

  lines.push('🚨 Матрица РМЗ: очередь отправки на сервер застряла');
  lines.push(`Машина: ${clientName ? `${clientName} (${clientId})` : clientId}`);
  lines.push(
    `Когда: ${reportDateTime(now)} · самая старая ждёт ${ageMin} мин (порог — ${stuck.thresholdMinutes} мин)`,
  );
  // По кнопке отчёт отправляет оператор — «Оператор» тут точно он. По авто-аларму на
  // машине может сидеть кто угодно, и называть его «оператором» значило бы приписать
  // ему чужие правки: в этом случае говорим «кто сейчас на машине».
  lines.push(
    args.trigger === 'manual' ? `Оператор: ${reportOperator(args.operator)}` : `На машине сейчас: ${reportOperator(args.operator)}`,
  );
  lines.push(`Причина: строки не уходят на сервер — ${stuck.count} шт.`);
  for (const row of [...(stuck.byTable ?? [])].sort((a, b) => b.n - a.n)) {
    const oldest = row.oldestPendingAt == null ? '' : `, самая старая ${reportDateTime(row.oldestPendingAt)}`;
    lines.push(`  • ${row.table}: ${row.n}${oldest}`);
  }
  const lastError = String(stuck.lastError ?? '').trim();
  if (lastError) lines.push(`Ошибка синка: ${lastError}`);
  const lastSyncAt = Number(stuck.lastSyncAt ?? 0);
  lines.push(`Последний успешный синк: ${lastSyncAt > 0 ? reportDateTime(lastSyncAt) : 'не было'}`);
  const version = String(args.appVersion ?? '').trim();
  if (version) lines.push(`Версия программы: ${version}`);
  lines.push(
    args.trigger === 'manual'
      ? 'Источник: оператор нажал «сообщить администратору»'
      : 'Источник: сработало автоматически (оператор не нажимал)',
  );
  lines.push('Пока строки в очереди этой машины, их не видит никто.');
  return lines.join('\n');
}

