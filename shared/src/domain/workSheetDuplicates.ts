import type { RepairHistoryRepeat } from './engineRepairHistory.js';

/**
 * Гейт дублей строк этапов работ (просьба владельца 18.09.2026).
 *
 * Оператор дважды нажал «Добавить» — и в списке два одинаковых этапа: один двигатель, один вид
 * работ, один день. На проде таких пар нашлось две из 66 строк; механизм молодой, и защиту надо
 * ставить сейчас, а не когда строк станут тысячи.
 *
 * **Почему не уникальный индекс в БД.** Ключ дубля лежит ВНУТРИ `meta_json` (`sheet.typeCode`,
 * `at`), а не в колонках. На сервере это потребовало бы expression-индекса по JSON, а на
 * клиентской реплике — его точной копии; расхождение этих двух ограничений — грабля **M142**,
 * из-за которой 18.09 у всего парка встала синхронизация. Плюс индекс просто не создался бы:
 * дубли в данных уже есть. Поэтому гейт доменный, в единственной двери записи.
 *
 * **Почему не жёсткий запрет.** Двигатель реально возвращается на тот же этап — после
 * переборки, по замечанию ОТК. Запрет оператор обойдёт (сдвинет дату, возьмёт соседний вид
 * работ), и мы потеряем и данные, и доверие к ним. Поэтому: предупредить, показать найденную
 * строку и заставить сделать ОСОЗНАННЫЙ выбор — ошибка это или возврат.
 *
 * **Зачем помечать возврат явно.** Сегодня полный дубль и настоящий возврат в базе неотличимы.
 * Как только возврат несёт номер прохода, появляется счётная величина: доля этапов, пройденных
 * с первого раза (выход годного с первого предъявления), и разрез «по каким видам работ
 * двигатели возвращаются чаще» — прямое указание на проблемную операцию.
 *
 * Форма повторяет гейт дублей сборочных нарядов (`workOrder.ts`,
 * `buildAssemblyDuplicateMessage`): чистая функция строит текст и список ссылок, а спрашивает
 * оператора тонкая UI-обёртка.
 */

/** Ссылка на уже существующую строку того же этапа — ровно то, что нужно для текста и кнопок. */
export type WorkSheetDuplicateRef = {
  id: string;
  typeName: string;
  /** Дата этапа (мс). Не момент записи: его несёт `performed_at`, а он здесь ни при чём. */
  at: number;
  /** Номер прохода: 1 у обычной строки, 2+ у помеченной как возврат. */
  pass: number;
  performedBy: string | null;
};

const MOSCOW_DAY_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Календарный день по московскому времени, в виде `ДД.ММ.ГГГГ`.
 *
 * «Тот же день» нельзя сравнивать по `at === at`: дата этапа записывается как ЛОКАЛЬНАЯ полночь
 * машины оператора, а показывается в московской зоне. Две машины в разных часовых поясах,
 * введя одно и то же число, дадут разные `at` — сравнение по равенству такой дубль пропустит.
 *
 * ⚠️ В `shared` уже есть три приватные копии этого форматтера (`customReport.ts`, `workOrder.ts`,
 * `workOrdersReport.ts`). Эта — экспортируемая; сводить их в одну надо отдельной правкой,
 * четвёртую приватную копию заводить нельзя.
 */
export function moscowDayKey(ts: number): string {
  if (!Number.isFinite(ts)) return '';
  return MOSCOW_DAY_FORMAT.format(new Date(ts));
}

/** Тот же календарный день по московскому времени. */
export function isSameWorkSheetDay(a: number, b: number): boolean {
  const ka = moscowDayKey(a);
  return ka !== '' && ka === moscowDayKey(b);
}

/**
 * Номер следующего прохода. Считается по МАКСИМУМУ, а не по количеству строк: если одну из
 * прежних строк удалили, счёт по количеству выдал бы уже занятый номер, и два прохода стали бы
 * неразличимы. Та же логика, по которой номера не переиспользуются нигде в учёте.
 */
export function nextWorkSheetPass(refs: readonly WorkSheetDuplicateRef[]): number {
  let max = 1;
  for (const ref of refs) {
    const pass = Number.isFinite(ref.pass) ? Math.floor(ref.pass) : 1;
    if (pass > max) max = pass;
  }
  return Math.min(max + 1, 99);
}

/** Признак повторного прохода для меты — `null`, если это первый проход. */
export function repeatForPass(pass: number, reason?: string): RepairHistoryRepeat | null {
  if (!Number.isFinite(pass) || pass < 2) return null;
  const trimmed = (reason ?? '').trim().slice(0, 500);
  return { pass: Math.min(Math.floor(pass), 99), ...(trimmed ? { reason: trimmed } : {}) };
}

/** Как строка называется в тексте гейта: «Укладка вала в картер, 15.09.2026 (проход 2)». */
export function formatWorkSheetDuplicateRef(ref: WorkSheetDuplicateRef): string {
  const name = ref.typeName.trim() || 'этап работ';
  const day = moscowDayKey(ref.at) || 'без даты';
  const pass = ref.pass >= 2 ? `, проход ${ref.pass}` : '';
  const by = ref.performedBy?.trim() ? `, внёс ${ref.performedBy.trim()}` : '';
  return `${name}, ${day}${pass}${by}`;
}

export type WorkSheetDuplicateMessage = {
  /** Текст для оператора. */
  text: string;
  /** Строки, которые можно предложить открыть. */
  refs: WorkSheetDuplicateRef[];
  /** Номер прохода, который получит новая строка, если оператор скажет «это возврат». */
  nextPass: number;
};

/**
 * Собрать сообщение гейта. `null` — дублей нет, оператор ничего не увидит.
 *
 * Гейт НИКОГДА не блокирует наглухо: возврат на тот же этап — законная производственная
 * ситуация, и запрет вынудил бы оператора врать про дату. Поэтому текст всегда предлагает
 * обе трактовки, а решает человек.
 */
export function buildWorkSheetDuplicateMessage(args: {
  engineLabel: string;
  typeName: string;
  at: number;
  refs: readonly WorkSheetDuplicateRef[];
}): WorkSheetDuplicateMessage | null {
  const refs = args.refs.filter((ref) => Boolean(ref?.id));
  if (refs.length === 0) return null;

  const engine = args.engineLabel.trim() || 'двигатель';
  const type = args.typeName.trim() || 'этот этап';
  const day = moscowDayKey(args.at) || 'эту дату';
  const nextPass = nextWorkSheetPass(refs);

  const head =
    refs.length === 1
      ? `На двигатель ${engine} за ${day} уже внесён этап «${type}»: ${formatWorkSheetDuplicateRef(refs[0]!)}.`
      : `На двигатель ${engine} за ${day} этап «${type}» уже внесён ${refs.length} раза: ${refs
          .map((ref) => formatWorkSheetDuplicateRef(ref))
          .join('; ')}.`;

  const tail =
    `Если это случайный повтор — не вносите вторую строку, откройте существующую. ` +
    `Если двигатель действительно вернулся на этот этап, отметьте запись как повторный проход ` +
    `(она станет проходом № ${nextPass}) — тогда её будет видно в отчётах как возврат, а не как ошибку ввода.`;

  return { text: `${head} ${tail}`, refs: [...refs], nextPass };
}
