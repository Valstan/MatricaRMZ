// Рекламационный учёт двигателя (MVP, план reclamation-mvp-2026-07).
// Все данные — EAV-атрибуты на той же сущности engine; никакого DDL.
// Коды enum-значений — стабильные строки (хранятся в attribute_values),
// русские лейблы живут только здесь.

export const RECLAMATION_FLAG = 'reclamation_flag';
export const RECLAMATION_ACCEPTED_DATE = 'reclamation_accepted_date';
export const RECLAMATION_CUSTOMER_REASON = 'reclamation_customer_reason';
export const RECLAMATION_VERDICT = 'reclamation_verdict';
export const RECLAMATION_VERDICT_DATE = 'reclamation_verdict_date';
export const RECLAMATION_REPAIR_STATUS = 'reclamation_repair_status';
export const RECLAMATION_SHIPPED_DATE = 'reclamation_shipped_date';
export const RECLAMATION_COMMENT = 'reclamation_comment';

export const RECLAMATION_ATTR_CODES = [
  RECLAMATION_FLAG,
  RECLAMATION_ACCEPTED_DATE,
  RECLAMATION_CUSTOMER_REASON,
  RECLAMATION_VERDICT,
  RECLAMATION_VERDICT_DATE,
  RECLAMATION_REPAIR_STATUS,
  RECLAMATION_SHIPPED_DATE,
  RECLAMATION_COMMENT,
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

/** Есть ли хоть какие-то данные рекламации (маркер «заполнено» на ярлыке вкладки). */
export function hasReclamationData(attrs: Record<string, unknown> | null | undefined): boolean {
  if (!attrs) return false;
  return RECLAMATION_ATTR_CODES.some((code) => {
    const v = attrs[code];
    if (v == null) return false;
    if (typeof v === 'boolean') return v;
    return String(v).trim() !== '';
  });
}
