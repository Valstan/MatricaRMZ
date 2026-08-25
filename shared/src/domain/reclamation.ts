// Рекламационный учёт двигателя (MVP, план reclamation-mvp-2026-07).
// Все данные — EAV-атрибуты на той же сущности engine; никакого DDL.
// Коды enum-значений — стабильные строки (хранятся в attribute_values),
// русские лейблы живут только здесь.

export const RECLAMATION_FLAG = 'reclamation_flag';
export const RECLAMATION_ACCEPTED_DATE = 'reclamation_accepted_date';
/** Подпись сменилась на «Описание дефекта изделия» (redesign 2026-08); код прежний. */
export const RECLAMATION_CUSTOMER_REASON = 'reclamation_customer_reason';
export const RECLAMATION_VERDICT = 'reclamation_verdict';
/** Подпись сменилась на «Дата акта исследования» (redesign 2026-08); код прежний. */
export const RECLAMATION_VERDICT_DATE = 'reclamation_verdict_date';
export const RECLAMATION_REPAIR_STATUS = 'reclamation_repair_status';
export const RECLAMATION_SHIPPED_DATE = 'reclamation_shipped_date';
export const RECLAMATION_COMMENT = 'reclamation_comment';

// Переделка вкладки под разбор по акту исследования (план reclamation-tab-redesign-2026-08).
export const RECLAMATION_ACTUAL_DEFECT = 'reclamation_actual_defect';
export const RECLAMATION_DEFECT_NATURE_ID = 'reclamation_defect_nature_id';
/** Подпись выбранного характера дефекта: переживает удаление элемента справочника. */
export const RECLAMATION_DEFECT_NATURE = 'reclamation_defect_nature';
export const RECLAMATION_ACT_NUMBER = 'reclamation_act_number';
export const RECLAMATION_ATTACHMENTS = 'reclamation_attachments';

/**
 * Выведены из обращения переделкой 2026-08: программа их не читает и не пишет.
 * Коды и лейблы оставлены, чтобы прежние значения можно было прочитать глазами.
 */
export const RECLAMATION_LEGACY_ATTR_CODES = [RECLAMATION_VERDICT, RECLAMATION_REPAIR_STATUS] as const;

export const RECLAMATION_ATTR_CODES = [
  RECLAMATION_FLAG,
  RECLAMATION_ACCEPTED_DATE,
  RECLAMATION_CUSTOMER_REASON,
  RECLAMATION_VERDICT,
  RECLAMATION_VERDICT_DATE,
  RECLAMATION_REPAIR_STATUS,
  RECLAMATION_SHIPPED_DATE,
  RECLAMATION_COMMENT,
  RECLAMATION_ACTUAL_DEFECT,
  RECLAMATION_DEFECT_NATURE_ID,
  RECLAMATION_DEFECT_NATURE,
  RECLAMATION_ACT_NUMBER,
  RECLAMATION_ATTACHMENTS,
] as const;

/** Справочник «Характер дефекта» — простой masterdata-тип, как марка двигателя. */
export const DEFECT_NATURE_TYPE_CODE = 'defect_nature';

/** Посев справочника. Идемпотентный: повторный прогон дублей не создаёт. */
export const DEFECT_NATURE_SEED_LABELS = [
  'Производственный',
  'Эксплуатационный',
  'Конструктивный',
  'Дефект КИ',
] as const;

export type ReclamationVerdict = 'our_fault' | 'customer_fault' | 'not_confirmed';
export type ReclamationRepairStatus = 'accepted' | 'cause_found' | 'repaired' | 'closed_no_repair';

export const RECLAMATION_VERDICT_LABELS: Record<ReclamationVerdict, string> = {
  our_fault: 'Наша вина',
  customer_fault: 'Вина заказчика (нарушение эксплуатации)',
  not_confirmed: 'Не подтвердилось',
};

export const RECLAMATION_REPAIR_STATUS_LABELS: Record<ReclamationRepairStatus, string> = {
  accepted: 'Принят',
  cause_found: 'Причина выяснена',
  repaired: 'Отремонтирован',
  closed_no_repair: 'Закрыт без ремонта',
};

export function isReclamationVerdict(v: unknown): v is ReclamationVerdict {
  return v === 'our_fault' || v === 'customer_fault' || v === 'not_confirmed';
}

export function isReclamationRepairStatus(v: unknown): v is ReclamationRepairStatus {
  return v === 'accepted' || v === 'cause_found' || v === 'repaired' || v === 'closed_no_repair';
}

/** Двигатель помечен рекламационным (синяя точка в списке, фильтр). */
export function isReclamationEngine(attrs: Record<string, unknown> | null | undefined): boolean {
  return Boolean(attrs?.[RECLAMATION_FLAG]);
}

/** Пустой список вложений приезжает и массивом, и строкой `[]` — данными это не считается. */
function isFilledAttrValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 0;
  const s = String(v).trim();
  return s !== '' && s !== '[]';
}

/** Есть ли хоть какие-то данные рекламации (маркер «заполнено» на ярлыке вкладки). */
export function hasReclamationData(attrs: Record<string, unknown> | null | undefined): boolean {
  if (!attrs) return false;
  return RECLAMATION_ATTR_CODES.some((code) => isFilledAttrValue(attrs[code]));
}
