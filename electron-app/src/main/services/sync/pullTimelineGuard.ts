/**
 * Курсор реплики против головы журнала сервера.
 *
 * ИНЦИДЕНТ (25.11.2026, стенд lane1): суперадмин выдал оператору раздел
 * «Производство». Сервер принял и опубликовал строку `user_section_access`
 * (номер 593), клиент её ПРИТЯНУЛ (`pulled=1`) и положил в локальную реплику —
 * а membership в меню не появился.
 *
 * Причина — не в доставке, а в СБОРКЕ membership: клиент читает доступы как
 * `users ⋈ user_section_access` (employeeService.replicaMembershipRows), то есть
 * строка доступа без строки аккаунта бесполезна. Строка аккаунта публикуется в
 * журнал ОДИН раз (номер 152/153 — при заведении учётной записи), а строка
 * доступа — позже (593). Клиент, чей курсор уже стоял выше 153, строку аккаунта
 * НИКОГДА не получит: условие доезда строгое `last_server_seq > since`.
 *
 * Откуда курсор выше головы журнала: сервер пересоздали (новая БД / другой
 * сервер), нумерация журнала началась заново, а у клиента остался курсор
 * прошлой линии. Сервер это ЗАМАЛЧИВАЕТ — поджимает курсор
 * (`effectiveSince = min(since, serverLastSeq)`), и клиент молча продолжает
 * тянуть хвост новой линии, не получая её начало.
 *
 * Лечение: увидеть разрыв линий и пересобрать реплику целиком (полный pull
 * с предварительной чисткой). Иначе доступы не появятся НИКОГДА, а источник
 * membership так и будет врать «реплика» — то есть «раздел не выдан» там, где
 * выдан.
 */

/** Ответ pull'а в том виде, в каком его видит клиент. */
export type PullPageLike = {
  server_cursor: number;
  server_last_seq?: number | null;
  has_more?: boolean;
  changes?: unknown[];
};

/**
 * Курсор клиента ВЫШЕ головы журнала сервера?
 *
 * Истина означает: реплика клиента собрана по другой (или более ранней)
 * временной линии журнала, и инкрементальный pull её не спасёт — головы
 * новой линии он уже никогда не увидит.
 *
 * Ложь в норме: курсор либо пустой (свежий клиент), либо не выше головы.
 */
export function isCrossTimelineCursor(
  clientCursor: number | null | undefined,
  serverLastSeq: number | null | undefined,
): boolean {
  const cursor = Number(clientCursor ?? 0);
  const head = Number(serverLastSeq ?? 0);
  if (!Number.isFinite(cursor) || !Number.isFinite(head)) return false;
  // Голова неизвестна (старый сервер без счётчика) — судить не о чем.
  if (head <= 0) return false;
  return cursor > head;
}

export type PullLoopResult<TPage extends PullPageLike> = {
  last: TPage | null;
  totalPulled: number;
  changedTables: Record<string, number>;
  /** Ремонт реплики по чужой линии журнала был выполнен. */
  repaired: boolean;
};

export type PullLoopArgs<TPage extends PullPageLike> = {
  /** Одна страница pull'а по курсору. */
  pullOnce: (since: number) => Promise<TPage>;
  /**
   * Пересборка реплики по линии сервера: чистка + полный pull.
   * Вызывается, когда курсор клиента оказался выше головы журнала.
   */
  repairReplica: (info: { clientCursor: number; serverLastSeq: number }) => Promise<{
    totalPulled: number;
    changedTables: Record<string, number>;
    last: TPage;
  }>;
  since: number;
  /** Курсор после страницы (для прогресса и следующего запроса). */
  nextCursor?: (page: TPage) => number;
  onProgress?: (info: { cursor: number; serverLastSeq: number; pulled: number }) => void;
  maxPages?: number;
};

/**
 * Инкрементальный pull с проверкой линии журнала.
 *
 * Первая страница — проверочная: если курсор клиента выше головы журнала,
 * инкрементальный pull больше не сможет доставить начало линии (строку
 * аккаунта в том числе), и реплику надо пересобрать целиком.
 */
export async function runPullLoopWithTimelineGuard<TPage extends PullPageLike>(
  args: PullLoopArgs<TPage>,
): Promise<PullLoopResult<TPage>> {
  const maxPages = args.maxPages ?? 2000;
  const nextCursor = args.nextCursor ?? ((page: TPage) => Number(page.server_cursor ?? 0));
  let sinceCursor = Number(args.since ?? 0);
  let totalPulled = 0;
  let last: TPage | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const res = await args.pullOnce(sinceCursor);
    totalPulled += Array.isArray(res.changes) ? res.changes.length : 0;
    last = res;

    const serverLastSeq = Number(res.server_last_seq ?? res.server_cursor ?? 0);
    if (page === 0 && isCrossTimelineCursor(sinceCursor, serverLastSeq)) {
      const repaired = await args.repairReplica({ clientCursor: sinceCursor, serverLastSeq });
      return {
        last: repaired.last,
        totalPulled: totalPulled + repaired.totalPulled,
        changedTables: repaired.changedTables,
        repaired: true,
      };
    }

    args.onProgress?.({ cursor: Number(res.server_cursor ?? 0), serverLastSeq, pulled: totalPulled });
    if (!res.has_more) break;
    const cursor = nextCursor(res);
    if (cursor === sinceCursor) break;
    sinceCursor = cursor;
  }

  return { last, totalPulled, changedTables: {}, repaired: false };
}
