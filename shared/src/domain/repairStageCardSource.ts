/**
 * Связь строки этапа с датой карточки (промты КАРМАНА #133/#136, зачитка владельца 25.11.2026).
 *
 * По грабли M147 строка этапа — это **копия даты карточки**: `shipped`/`accepted`/
 * `arrival`/`disassembly_defect` повторяют соответствующие даты до миллисекунды. Но связи
 * между ними не было вовсе: карточку правили, этап оставался, и «дата удалена, а этап нет»
 * выглядело как ошибка данных.
 *
 * Здесь живёт **один** список «код этапа → атрибут карточки». Раньше он был спрятан в
 * серверном скрипте разбора (`backend-api/src/scripts/reviewRepairStageOrder.ts`), а рантайм
 * его не знал вовсе: клиент и скрипт смотрели на разные списки. Теперь источник истины
 * один — домен, а скрипт разбора берёт его отсюда.
 *
 * Пустая строка означает «источника нет»: ремонтные этапы (`obkatka`, `sborka`, `otk`)
 * приходят из строк ведомостей, а не с карточки.
 */
/**
 * След происхождения строки этапа: этап вырос из даты карточки.
 *
 * По грабли M147 строка этапа — копия даты карточки, и раньше эта связь была только
 * догадкой (сравнение миллисекунд). Теперь источник назван прямо: сняли дату в карточке —
 * этап, ею порождённый, гаснет; дату поменяли — этап едет за ней.
 *
 * Ручная правка этапа в ленте связь снимает (строка перестаёт быть копией даты), и
 * авто-связь её больше не трогает — решение владельца 25.11.2026 («ручную правку не
 * затирать»).
 */
export type RepairHistorySourceMark = {
  kind: 'card_date';
  /** Атрибут карточки-источника: `arrival_date`, `status_customer_sent_date`, … */
  attr: string;
};

/**
 * Пометка погашения: этап погашен, потому что сняли дату карточки.
 *
 * Живёт в погашенной строке, чтобы оператор видел «почему этап исчез» и мог вернуть
 * его одной кнопкой. Без пометки восстановление неотличимо от «строку удалили руками».
 */
export type RepairHistoryExtinguishedMark = {
  /** Атрибут карточки, снятие которого погасило этап. */
  attr: string;
  /** Кто погасил (логин). */
  by: string;
  /** Момент погашения (ms). */
  at: number;
};

export const CARD_SOURCE_ATTR: Record<string, string> = {
  disassembly_defect: 'defect_date',
  arrival: 'arrival_date',
  shipped: 'status_customer_sent_date',
  accepted: 'status_customer_accepted_date',
  repaired: 'status_repaired_date',
  obkatka: '',
  sborka: '',
  otk: '',
};

/**
 * Разбор следа происхождения строки этапа. Вид другой, чем `card_date`, — отбрасывается:
 * неизвестный след ничего не значит, а молча притвориться, что этап с карточки, — значит
 * погасить его по снятой дате.
 */
export function parseSourceMark(raw: unknown): RepairHistorySourceMark | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (String(obj.kind ?? '').trim() !== 'card_date') return null;
  const attr = String(obj.attr ?? '').trim().slice(0, 80);
  if (!attr) return null;
  return { kind: 'card_date', attr };
}

/** Разбор пометки погашения: без момента погашения запись неполна и не читается. */
export function parseExtinguishedMark(raw: unknown): RepairHistoryExtinguishedMark | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const attr = String(obj.attr ?? '').trim().slice(0, 80);
  const by = String(obj.by ?? '').trim().slice(0, 120);
  const at = typeof obj.at === 'number' && Number.isFinite(obj.at) && obj.at > 0 ? obj.at : null;
  if (!attr || at === null) return null;
  return { attr, by, at };
}

/** Атрибут карточки, из которого вырос этап; `null` — этап не с карточки. */
export function cardSourceAttr(stageCode: string | null | undefined): string | null {
  const code = String(stageCode ?? '').trim().toLowerCase();
  if (!code) return null;
  const attr = CARD_SOURCE_ATTR[code];
  if (!attr) return null;
  return attr;
}

/**
 * Код этапа, порождённого атрибутом карточки; `null` — такого этапа нет.
 * Обратная к `cardSourceAttr`: по атрибуту карточки понимаем, какой этап он двигает.
 */
export function stageCodeForCardAttr(attr: string | null | undefined): string | null {
  const value = String(attr ?? '').trim().toLowerCase();
  if (!value) return null;
  for (const [code, source] of Object.entries(CARD_SOURCE_ATTR)) {
    if (source && source === value) return code;
  }
  return null;
}

/**
 * Этапы, которые рантайм ведёт за датой карточки: заполнил дату — появился этап,
 * снял дату — этап погас. Список — тот же, что у авто-простановки дат карточки
 * (`engineCardWrite.ts`, `setEngineAttribute`), иначе правило работало бы наполовину.
 */
export const CARD_DATE_STAGE_CODES: readonly string[] = ['arrival', 'shipped', 'accepted'];

/** Атрибут карточки для этапа из `CARD_DATE_STAGE_CODES`. */
export function cardDateStageAttr(stageCode: string | null | undefined): string | null {
  const code = String(stageCode ?? '').trim().toLowerCase();
  if (!CARD_DATE_STAGE_CODES.includes(code)) return null;
  return cardSourceAttr(code);
}
